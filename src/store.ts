// The index on disk: one versioned JSON file holding every entity once and
// every fragment with its vector (docs/CONTRACT.md §12). Both layers share one
// vector space; a fragment's resolved disclosure is what lets retrieval and the
// crossing treat them differently (the boundary starts here). At
// personal-archive scale a single file plus brute-force cosine is the honest,
// simple answer.
//
// Private fragments' text is in the private index, so it is private even when
// your corpus is public — it stays gitignored. A SERVED index is a projection of
// it (toServedIndex) with everything the policy does not release stripped, and
// a load-time validator (validateServedIndex) that checks the strip happened.
//
// Schema 4. Until the retrieval core reads fragments (Step 3), readIndexFile and
// writeIndexFile keep their 2.x signatures over ArchiveRecord / PrivateNote
// entries and translate through the teaching adapters, so every caller stays
// green while the file format moves first.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  fromArchiveRecord,
  fromPrivateNote,
  toArchiveRecord,
  toPrivateNote,
} from './adapters/teaching.js';
import type { Entity, Fragment, LintedGist } from './contract.js';
import { isServableGist } from './ingest/disclosure.js';
import type { IndexEntry } from './types.js';

export const INDEX_PATH = resolve('artifacts/index.json');

/** Bump when the file shape changes; old artifacts then fail fast with a
 *  remedy instead of generic type errors deep in retrieval.
 *  v3: PrivateNote split `title` from `label` (NEXT-STEPS.md A1).
 *  v4: entities stored once; every entry carries a Fragment with its resolved
 *  disclosure (docs/CONTRACT.md §12). A v3 file migrates without re-embedding. */
export const INDEX_SCHEMA_VERSION = 4;

const REBUILD = 'Delete artifacts/index.json and rerun `npm run index`.';
const MIGRATE = (path: string): string =>
  `Run \`npm run migrate:index -- ${path}\` to migrate it in place without re-embedding, or ${REBUILD}`;

export interface FragmentEntry {
  model: string;
  dimensions: number;
  vector: number[];
  /** Hash of the embed string (src/embed-string.ts); lets `npm run index` skip unchanged fragments. */
  contentHash: string;
  fragment: Fragment;
}

/** The private index: everything, including text and projections. */
export interface IndexFile {
  version: typeof INDEX_SCHEMA_VERSION;
  entities: Entity[];
  entries: FragmentEntry[];
}

/** What survives of a projection in a served index. */
export interface ServedProjection {
  lint: 'passed';
  gist: LintedGist;
  source: 'generated' | 'edited';
  review: 'unreviewed' | 'reviewed';
}

export type ServedFragment = Omit<Fragment, 'projection' | 'sourceReview'> & {
  projection?: ServedProjection;
};

export interface ServedFragmentEntry {
  model: string;
  dimensions: number;
  vector: number[];
  fragment: ServedFragment;
}

/** The served index: a projection of the private one (CONTRACT.md §3 rule 4). */
export interface ServedIndexFile {
  version: typeof INDEX_SCHEMA_VERSION;
  served: true;
  entities: Entity[];
  entries: ServedFragmentEntry[];
}

// ─── Shape checks ────────────────────────────────────────────────────────────

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isLegalCell(d: unknown): d is Fragment['disclosure'] {
  if (!isRecord(d)) return false;
  if (d.raw === 'public') return ['text', 'semantic', 'locator', 'none'].includes(d.exposure as string);
  if (d.raw === 'private') return ['semantic', 'locator', 'none'].includes(d.exposure as string);
  return false;
}

function entityIsValid(e: unknown): e is Entity {
  return (
    isRecord(e) &&
    typeof e.id === 'string' &&
    typeof e.type === 'string' &&
    typeof e.title === 'string' &&
    typeof e.url === 'string' &&
    Array.isArray(e.attribution) &&
    Array.isArray(e.identifiers) &&
    isLegalCell(e.disclosure)
  );
}

function vectorFieldsValid(e: Record<string, unknown>): boolean {
  return typeof e.model === 'string' && typeof e.dimensions === 'number' && Array.isArray(e.vector);
}

function fragmentIsValid(f: unknown): f is Fragment {
  return (
    isRecord(f) &&
    typeof f.id === 'string' &&
    typeof f.entityId === 'string' &&
    Array.isArray(f.locator) &&
    f.locator.length > 0 &&
    typeof f.text === 'string' &&
    isLegalCell(f.disclosure)
  );
}

function parseJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`index at ${path} is not valid JSON. ${REBUILD}`);
  }
}

function checkVersion(parsed: unknown, path: string): Record<string, unknown> {
  const file = isRecord(parsed) ? parsed : undefined;
  if (!file || file.version !== INDEX_SCHEMA_VERSION) {
    const found = file ? String(file.version) : 'none';
    const remedy = file && file.version === 3 ? MIGRATE(path) : REBUILD;
    throw new Error(
      `index at ${path} is schema version ${found}, not schema version ${INDEX_SCHEMA_VERSION}. ${remedy}`,
    );
  }
  if (!Array.isArray(file.entities) || !Array.isArray(file.entries)) {
    throw new Error(`index at ${path} has no entities/entries arrays. ${REBUILD}`);
  }
  return file;
}

/**
 * Validate a parsed private index (CONTRACT.md §12): every entity well formed
 * and unique; every entry carries a vector and a fragment; every fragment's
 * entity resolves; the fragment's `raw` equals its entity's; the cell is legal;
 * a `semantic` fragment satisfies isServableGist. Throws with the remedy.
 */
export function validateIndex(parsed: unknown, path = 'index'): IndexFile {
  const file = checkVersion(parsed, path);
  const entities = new Map<string, Entity>();
  for (const e of file.entities as unknown[]) {
    if (!entityIsValid(e)) throw new Error(`index at ${path} has a malformed entity. ${REBUILD}`);
    if (entities.has(e.id)) throw new Error(`index at ${path} lists entity '${e.id}' twice. ${REBUILD}`);
    entities.set(e.id, e);
  }
  for (const raw of file.entries as unknown[]) {
    if (!isRecord(raw) || !vectorFieldsValid(raw) || typeof raw.contentHash !== 'string' || !fragmentIsValid(raw.fragment)) {
      throw new Error(`index at ${path} has a malformed entry. ${REBUILD}`);
    }
    const fragment = raw.fragment;
    const entity = entities.get(fragment.entityId);
    if (!entity) {
      throw new Error(`index at ${path}: fragment '${fragment.id}' names unknown entity '${fragment.entityId}'. ${REBUILD}`);
    }
    if (fragment.disclosure.raw !== entity.disclosure.raw) {
      throw new Error(
        `index at ${path}: fragment '${fragment.id}' is raw '${fragment.disclosure.raw}' under entity ` +
          `'${entity.id}' which is raw '${entity.disclosure.raw}'. A fragment never changes the layer. ${REBUILD}`,
      );
    }
    if (fragment.disclosure.exposure === 'semantic' && !isServableGist(fragment, entity)) {
      throw new Error(
        `index at ${path}: fragment '${fragment.id}' is exposed as 'semantic' without a servable gist. ${REBUILD}`,
      );
    }
  }
  return file as unknown as IndexFile;
}

/** Validate a served index: everything validateIndex checks, plus the strip of
 *  CONTRACT.md §3 rule 4 actually happened. A served index that fails this was
 *  misbuilt and is refused. */
export function validateServedIndex(parsed: unknown, path = 'served index'): ServedIndexFile {
  const file = checkVersion(parsed, path);
  if (file.served !== true) throw new Error(`index at ${path} is not marked as a served index. ${REBUILD}`);
  const entities = new Map<string, Entity>();
  for (const e of file.entities as unknown[]) {
    if (!entityIsValid(e)) throw new Error(`index at ${path} has a malformed entity. ${REBUILD}`);
    if ('policy' in e) throw new Error(`index at ${path}: entity '${e.id}' still carries policy. ${REBUILD}`);
    entities.set(e.id, e);
  }
  const servedEntities = new Set<string>();
  for (const raw of file.entries as unknown[]) {
    if (!isRecord(raw) || !vectorFieldsValid(raw) || !fragmentIsValid(raw.fragment)) {
      throw new Error(`index at ${path} has a malformed entry. ${REBUILD}`);
    }
    if ('contentHash' in raw) throw new Error(`index at ${path} still carries contentHash. ${REBUILD}`);
    const f = raw.fragment as Fragment & Record<string, unknown>;
    const entity = entities.get(f.entityId);
    if (!entity) throw new Error(`index at ${path}: fragment '${f.id}' names unknown entity '${f.entityId}'. ${REBUILD}`);
    if (f.disclosure.raw !== entity.disclosure.raw) {
      throw new Error(`index at ${path}: fragment '${f.id}' changes the layer of '${entity.id}'. ${REBUILD}`);
    }
    const exposure = f.disclosure.exposure;
    if (exposure === 'none') throw new Error(`index at ${path}: fragment '${f.id}' has exposure 'none'. ${REBUILD}`);
    if (exposure !== 'text' && (f.text !== '' || (f.summary !== undefined && f.summary !== ''))) {
      throw new Error(`index at ${path}: fragment '${f.id}' is '${exposure}' but still carries text. ${REBUILD}`);
    }
    if (exposure !== 'semantic' && f.projection !== undefined) {
      throw new Error(`index at ${path}: fragment '${f.id}' is '${exposure}' but still carries a projection. ${REBUILD}`);
    }
    if (exposure === 'semantic') {
      const p = f.projection as Record<string, unknown> | undefined;
      if (!p || p.lint !== 'passed' || typeof p.gist !== 'string') {
        throw new Error(`index at ${path}: fragment '${f.id}' is 'semantic' without a passed gist. ${REBUILD}`);
      }
      for (const key of Object.keys(p)) {
        if (!['lint', 'gist', 'source', 'review'].includes(key)) {
          throw new Error(`index at ${path}: fragment '${f.id}' projection still carries '${key}'. ${REBUILD}`);
        }
      }
    }
    if ('sourceReview' in f) throw new Error(`index at ${path}: fragment '${f.id}' still carries sourceReview. ${REBUILD}`);
    servedEntities.add(f.entityId);
  }
  for (const id of entities.keys()) {
    if (!servedEntities.has(id)) throw new Error(`index at ${path}: entity '${id}' has no served fragment. ${REBUILD}`);
  }
  return file as unknown as ServedIndexFile;
}

// ─── The served projection ───────────────────────────────────────────────────

/**
 * CONTRACT.md §3 rule 4, as a pure function: drop every `none` fragment and
 * every entity left with no served fragment; blank `text` and `summary`
 * wherever exposure is not `text`; drop the projection wherever exposure is not
 * `semantic`, and on the ones kept keep only gist, lint, source, review; drop
 * contentHash, policy, sourceReview. Runs last in a build, after embedding and
 * the lint. Defense in depth behind the resolver: "it is only a gist" never
 * bypasses the policy even if a served file leaks.
 */
export function toServedIndex(file: IndexFile): ServedIndexFile {
  const entries: ServedFragmentEntry[] = [];
  const servedEntityIds = new Set<string>();
  for (const entry of file.entries) {
    const f = entry.fragment;
    const exposure = f.disclosure.exposure;
    if (exposure === 'none') continue;
    const { projection, sourceReview: _sourceReview, ...rest } = f;
    const served: ServedFragment = { ...rest };
    if (exposure !== 'text') {
      served.text = '';
      if (served.summary !== undefined) served.summary = '';
    }
    if (exposure === 'semantic') {
      if (!projection || projection.lint !== 'passed') {
        throw new Error(`toServedIndex: fragment '${f.id}' is 'semantic' without a passed gist; resolve the policy first.`);
      }
      served.projection = {
        lint: 'passed',
        gist: projection.gist,
        source: projection.source,
        review: projection.review,
      };
    }
    entries.push({ model: entry.model, dimensions: entry.dimensions, vector: entry.vector, fragment: served });
    servedEntityIds.add(f.entityId);
  }
  const entities = file.entities
    .filter((e) => servedEntityIds.has(e.id))
    .map((e) => {
      const { policy: _policy, ...rest } = e;
      return rest as Entity;
    });
  return { version: INDEX_SCHEMA_VERSION, served: true, entities, entries };
}

// ─── Read / write ────────────────────────────────────────────────────────────

/** Read and validate a private index. A missing file is an empty index. */
export function readIndex(path: string = INDEX_PATH): IndexFile {
  if (!existsSync(path)) return { version: INDEX_SCHEMA_VERSION, entities: [], entries: [] };
  return validateIndex(parseJson(path), path);
}

export function writeIndex(file: IndexFile, path: string = INDEX_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: INDEX_SCHEMA_VERSION, entities: file.entities, entries: file.entries }) + '\n', 'utf8');
}

export function readServedIndex(path: string): ServedIndexFile {
  return validateServedIndex(parseJson(path), path);
}

export function writeServedIndex(file: ServedIndexFile, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file) + '\n', 'utf8');
}

// ─── The transitional legacy view (ArchiveRecord / PrivateNote entries) ──────

/** Legacy entries → a schema-4 file, through the teaching adapters. */
export function indexFileFromLegacyEntries(entries: readonly IndexEntry[]): IndexFile {
  const entities = new Map<string, Entity>();
  const out: FragmentEntry[] = [];
  for (const e of entries) {
    const { entity, fragment } = e.sourceType === 'record' ? fromArchiveRecord(e.record) : fromPrivateNote(e.note);
    const seen = entities.get(entity.id);
    if (seen && JSON.stringify(seen) !== JSON.stringify(entity)) {
      throw new Error(`entity '${entity.id}' is described two ways by its entries; refusing to write an inconsistent index.`);
    }
    entities.set(entity.id, entity);
    out.push({ model: e.model, dimensions: e.dimensions, vector: e.vector, contentHash: e.contentHash, fragment });
  }
  return { version: INDEX_SCHEMA_VERSION, entities: [...entities.values()], entries: out };
}

/** A schema-4 file → legacy entries. Public fragments become records, private
 *  ones become notes. Lossless for anything the teaching adapters wrote. */
export function legacyEntriesFromIndexFile(file: IndexFile): IndexEntry[] {
  const byId = new Map(file.entities.map((e) => [e.id, e]));
  return file.entries.map((entry): IndexEntry => {
    const entity = byId.get(entry.fragment.entityId);
    if (!entity) throw new Error(`fragment '${entry.fragment.id}' names unknown entity '${entry.fragment.entityId}'.`);
    const base = { model: entry.model, dimensions: entry.dimensions, vector: entry.vector, contentHash: entry.contentHash };
    return entity.disclosure.raw === 'public'
      ? { ...base, sourceType: 'record', record: toArchiveRecord(entity, entry.fragment) }
      : { ...base, sourceType: 'note', note: toPrivateNote(entity, entry.fragment) };
  });
}

/** 2.x signature: read the index as record/note entries. Missing file → []. */
export function readIndexFile(path: string = INDEX_PATH): IndexEntry[] {
  return legacyEntriesFromIndexFile(readIndex(path));
}

/** 2.x signature: write record/note entries; the file on disk is schema 4. */
export function writeIndexFile(entries: readonly IndexEntry[], path: string = INDEX_PATH): void {
  writeIndex(indexFileFromLegacyEntries(entries), path);
}

/** Stable id for a legacy entry's source, whichever layer it came from. */
export function entrySourceId(entry: IndexEntry): string {
  return entry.sourceType === 'record' ? entry.record.id : entry.note.id;
}

/** Cosine across vectors from different models or dimensions is meaningless.
 *  Fail fast at load time with the remedy, instead of crashing mid-retrieval. */
export function assertHomogeneousIndex(entries: readonly IndexEntry[]): void {
  const first = entries[0];
  if (!first) return;
  for (const e of entries) {
    if (e.model !== first.model || e.dimensions !== first.dimensions) {
      throw new Error(
        `index mixes embedding specs (${first.model}/${first.dimensions} vs ` +
          `${e.model}/${e.dimensions} for '${entrySourceId(e)}'). ${REBUILD}`,
      );
    }
  }
}

/** The same check over schema-4 entries. */
export function assertHomogeneousEntries(entries: readonly { model: string; dimensions: number; fragment: { id: string } }[]): void {
  const first = entries[0];
  if (!first) return;
  for (const e of entries) {
    if (e.model !== first.model || e.dimensions !== first.dimensions) {
      throw new Error(
        `index mixes embedding specs (${first.model}/${first.dimensions} vs ` +
          `${e.model}/${e.dimensions} for '${e.fragment.id}'). ${REBUILD}`,
      );
    }
  }
}

// ─── Migration ───────────────────────────────────────────────────────────────

function legacyEntryIsValid(e: unknown): e is IndexEntry {
  if (!isRecord(e) || !vectorFieldsValid(e) || typeof e.contentHash !== 'string') return false;
  if (e.sourceType === 'record') {
    const r = e.record;
    return isRecord(r) && typeof r.id === 'string' && typeof r.url === 'string' && typeof r.title === 'string';
  }
  if (e.sourceType === 'note') {
    const n = e.note;
    return (
      isRecord(n) &&
      typeof n.id === 'string' &&
      typeof n.url === 'string' &&
      typeof n.title === 'string' &&
      typeof n.label === 'string' &&
      typeof n.locator === 'string' &&
      typeof n.text === 'string'
    );
  }
  return false;
}

/**
 * Pure, keyless: a parsed schema-3 file → schema 4. Vectors and contentHashes
 * are untouched because the adapters reproduce the embed bytes (src/embed-string.ts);
 * only the shape changes. Refuses anything that is not a well-formed v3 file.
 */
export function migrateV3ToV4(parsed: unknown, path = 'index'): IndexFile {
  if (!isRecord(parsed) || parsed.version !== 3 || !Array.isArray(parsed.entries)) {
    const found = isRecord(parsed) ? String(parsed.version) : 'none';
    throw new Error(`${path} is schema version ${found}, not 3 — refusing to migrate.`);
  }
  const entries = parsed.entries as unknown[];
  for (const e of entries) {
    if (!legacyEntryIsValid(e)) throw new Error(`${path} has a malformed v3 entry — refusing to migrate.`);
  }
  return indexFileFromLegacyEntries(entries as IndexEntry[]);
}
