// The index on disk: one versioned JSON file holding every entity once and
// every fragment with its vector (docs/CONTRACT.md §12). Both layers share one
// vector space; a fragment's resolved disclosure is what lets retrieval and the
// crossing treat them differently (the boundary starts here). At
// personal-archive scale a single file plus brute-force cosine is the honest,
// simple answer.
//
// Private fragments' text is in the private index, so it is private even when
// your corpus is public — it stays gitignored. Because the text is there, a
// private index is checked against it at every load (validateIndex): shape down
// to the nested items and the vector elements, legal cells, servable gists, the
// lint over every authored string a hit on a private entity would carry, and
// the gist lint over every gist a `semantic` fragment would serve
// (docs/CONTRACT.md §6), so a hand edit fails here and not in an answer. Every
// message names ids, fields, and positions, never a value: a private index's
// values are private text. A SERVED index is a projection of it
// (toServedIndex) with everything the policy does not release stripped, and a
// load-time validator (validateServedIndex) that checks the strip happened; it
// carries no text to lint against and is trusted to descend from a validated
// private index. An index that would be refused at load is refused at write.
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
import { projectionContentHash, projectionProblem } from './ingest/projections.js';
import { isTimecodeValue } from './locator.js';
import { assertPublicSafeMetadata, assertSemanticProjection, entityLintText } from './public-safe.js';
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
//
// Each check returns the first thing wrong as a short phrase naming the field
// and the type it needed, or null. Field names only, never values: a private
// index's values are private text, and these phrases become the error messages
// that build tools, CI, and a consumer's loader print (.github/STANDARDS.md §4).

type Problem = string | null;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

const isString = (x: unknown): x is string => typeof x === 'string';
const isOptionalString = (x: unknown): boolean => x === undefined || typeof x === 'string';
const isOptionalBoolean = (x: unknown): boolean => x === undefined || typeof x === 'boolean';
const isPositiveInteger = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x > 0;

function listProblem(x: unknown, at: string, item: (v: unknown, at: string) => Problem): Problem {
  if (!Array.isArray(x)) return `${at} must be an array`;
  for (let i = 0; i < x.length; i++) {
    const problem = item(x[i], `${at}[${i}]`);
    if (problem !== null) return problem;
  }
  return null;
}

const stringItem = (v: unknown, at: string): Problem => (isString(v) ? null : `${at} must be a string`);

function identifierProblem(x: unknown, at: string): Problem {
  if (!isRecord(x)) return `${at} must be an object`;
  if (!isString(x.scheme)) return `${at}.scheme must be a string`;
  if (!isString(x.value)) return `${at}.value must be a string`;
  return null;
}

function attributionProblem(x: unknown, at: string): Problem {
  if (!isRecord(x)) return `${at} must be an object`;
  if (!isString(x.name)) return `${at}.name must be a string`;
  if (!isOptionalString(x.role)) return `${at}.role must be a string`;
  if (x.placeholder !== undefined && x.placeholder !== 'unnamed' && x.placeholder !== 'unverified') {
    return `${at}.placeholder must be 'unnamed' or 'unverified'`;
  }
  return x.identifiers === undefined ? null : listProblem(x.identifiers, `${at}.identifiers`, identifierProblem);
}

/** A `timecode` value is checked here, by field name, so the renderer never
 *  meets a malformed one inside the lint. */
function locatorProblem(x: unknown, at: string): Problem {
  if (!isRecord(x)) return `${at} must be an object`;
  if (!isString(x.scheme)) return `${at}.scheme must be a string`;
  if (!isString(x.value)) return `${at}.value must be a string`;
  if (!isOptionalString(x.end)) return `${at}.end must be a string`;
  if (x.scheme === 'timecode') {
    if (!isTimecodeValue(x.value)) return `${at}.value must be decimal seconds for scheme 'timecode'`;
    if (x.end !== undefined && !isTimecodeValue(x.end as string)) return `${at}.end must be decimal seconds for scheme 'timecode'`;
  }
  return null;
}

/** The legal cells of CONTRACT.md §3; private + text is not one. */
function disclosureProblem(d: unknown, at: string): Problem {
  if (!isRecord(d)) return `${at} must be an object`;
  if (d.raw === 'public') {
    return ['text', 'semantic', 'locator', 'none'].includes(d.exposure as string)
      ? null
      : `${at}.exposure must be text, semantic, locator, or none`;
  }
  if (d.raw === 'private') {
    return ['semantic', 'locator', 'none'].includes(d.exposure as string)
      ? null
      : `${at}.exposure must be semantic, locator, or none (private + text is not a cell)`;
  }
  return `${at}.raw must be 'public' or 'private'`;
}

function policyProblem(p: unknown, at: string): Problem {
  if (p === undefined) return null;
  if (!isRecord(p)) return `${at} must be an object`;
  if (!isOptionalBoolean(p.requireReview)) return `${at}.requireReview must be a boolean`;
  if (!isOptionalBoolean(p.publicTitle)) return `${at}.publicTitle must be a boolean`;
  if (p.lint !== undefined) {
    if (!isRecord(p.lint)) return `${at}.lint must be an object`;
    for (const key of ['ngramWords', 'ngramChars', 'gistMaxChars'] as const) {
      if (p.lint[key] !== undefined && !isPositiveInteger(p.lint[key])) return `${at}.lint.${key} must be a positive integer`;
    }
  }
  return null;
}

function entityProblem(e: unknown): Problem {
  if (!isRecord(e)) return 'it is not an object';
  for (const key of ['id', 'type', 'title', 'url'] as const) {
    if (!isString(e[key])) return `'${key}' must be a string`;
  }
  for (const key of ['date', 'version', 'parent'] as const) {
    if (!isOptionalString(e[key])) return `'${key}' must be a string`;
  }
  return (
    listProblem(e.attribution, "'attribution'", attributionProblem) ??
    listProblem(e.identifiers, "'identifiers'", identifierProblem) ??
    (e.themes === undefined ? null : listProblem(e.themes, "'themes'", stringItem)) ??
    disclosureProblem(e.disclosure, "'disclosure'") ??
    policyProblem(e.policy, "'policy'")
  );
}

/** What survives of a projection in a served index: exactly these four fields. */
function servedProjectionProblem(p: unknown, at: string): Problem {
  if (!isRecord(p)) return `${at} must be an object`;
  if (p.lint !== 'passed') return `${at}.lint must be 'passed'`;
  if (!isString(p.gist)) return `${at}.gist must be a string`;
  if (p.source !== 'generated' && p.source !== 'edited') return `${at}.source must be 'generated' or 'edited'`;
  if (p.review !== 'unreviewed' && p.review !== 'reviewed') return `${at}.review must be 'unreviewed' or 'reviewed'`;
  for (const key of Object.keys(p)) {
    if (!['lint', 'gist', 'source', 'review'].includes(key)) return `${at} still carries '${key}'`;
  }
  return null;
}

function fragmentProblem(f: unknown, served: boolean): Problem {
  if (!isRecord(f)) return "'fragment' must be an object";
  for (const key of ['id', 'entityId', 'text'] as const) {
    if (!isString(f[key])) return `'${key}' must be a string`;
  }
  for (const key of ['date', 'summary'] as const) {
    if (!isOptionalString(f[key])) return `'${key}' must be a string`;
  }
  if (f.sourceReview !== undefined && !['unreviewed', 'in-review', 'reviewed'].includes(f.sourceReview as string)) {
    return "'sourceReview' must be unreviewed, in-review, or reviewed";
  }
  if (!Array.isArray(f.locator) || f.locator.length === 0) return "'locator' must be a non-empty array";
  return (
    listProblem(f.locator, "'locator'", locatorProblem) ??
    disclosureProblem(f.disclosure, "'disclosure'") ??
    (f.attribution === undefined ? null : listProblem(f.attribution, "'attribution'", attributionProblem)) ??
    (f.themes === undefined ? null : listProblem(f.themes, "'themes'", stringItem)) ??
    (f.projection === undefined
      ? null
      : served
        ? servedProjectionProblem(f.projection, "'projection'")
        : projectionProblem(f.projection, "'projection'"))
  );
}

/** `vector` has exactly `dimensions` finite numbers: a NaN or a short vector
 *  would not fail; it would score. */
function vectorProblem(e: Record<string, unknown>): Problem {
  if (!isString(e.model)) return "'model' must be a string";
  if (!isPositiveInteger(e.dimensions)) return "'dimensions' must be a positive integer";
  const v = e.vector;
  if (!Array.isArray(v)) return "'vector' must be an array of numbers";
  if (v.length !== e.dimensions) return `'vector' has ${v.length} elements, not 'dimensions' (${e.dimensions})`;
  for (let i = 0; i < v.length; i++) {
    const x: unknown = v[i];
    if (typeof x !== 'number' || !Number.isFinite(x)) return `'vector'[${i}] must be a finite number`;
  }
  return null;
}

function entryProblem(raw: unknown, served: boolean): Problem {
  if (!isRecord(raw)) return 'it is not an object';
  if (!served && !isString(raw.contentHash)) return "'contentHash' must be a string";
  return vectorProblem(raw) ?? fragmentProblem(raw.fragment, served);
}

/** `'x'` when the malformed object still names itself, so the message points. */
function idOf(x: unknown): string {
  return isRecord(x) && isString(x.id) ? ` '${x.id}'` : '';
}

function fragmentIdOf(raw: unknown): string {
  return isRecord(raw) ? idOf(raw.fragment) : '';
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

/** The entities of a parsed file, each well formed and unique. */
function checkEntities(file: Record<string, unknown>, path: string): Map<string, Entity> {
  const entities = new Map<string, Entity>();
  for (const e of file.entities as unknown[]) {
    const problem = entityProblem(e);
    if (problem !== null) throw new Error(`index at ${path} has a malformed entity${idOf(e)}: ${problem}. ${REBUILD}`);
    const entity = e as Entity;
    if (entities.has(entity.id)) throw new Error(`index at ${path} lists entity '${entity.id}' twice. ${REBUILD}`);
    entities.set(entity.id, entity);
  }
  return entities;
}

/** One entry's fragment: well formed, listed once, under an entity the file
 *  lists and in that entity's layer. Fragment ids key the projections file,
 *  vector reuse, and citations, so a duplicate is refused here. */
function checkEntry(
  raw: unknown,
  served: boolean,
  entities: ReadonlyMap<string, Entity>,
  seen: Set<string>,
  path: string,
): Fragment {
  const problem = entryProblem(raw, served);
  if (problem !== null) {
    throw new Error(`index at ${path} has a malformed entry${fragmentIdOf(raw)}: ${problem}. ${REBUILD}`);
  }
  const fragment = (raw as { fragment: Fragment }).fragment;
  if (seen.has(fragment.id)) throw new Error(`index at ${path} lists fragment '${fragment.id}' twice. ${REBUILD}`);
  seen.add(fragment.id);
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
  return fragment;
}

/**
 * Validate a parsed private index (CONTRACT.md §12): every entity and every
 * entry well formed down to its nested items and vector elements; every
 * entity and every fragment id listed once; every fragment's entity resolves
 * and shares its `raw`; every entity has at least one fragment; the cell is
 * legal; a `semantic` fragment satisfies isServableGist. Then, because
 * the private index is the one artifact that still holds the text, the two
 * verdicts a served hit relies on are re-earned against it rather than read
 * from the file: every authored string a hit on a private entity carries
 * passes the §6 metadata lint, and every `semantic` fragment's gist is the
 * gist of this text (contentHash) and passes the §6 gist lint against it, and
 * against the whole entity where there is more than one fragment, exactly as
 * the drafter checked it (src/ingest/gist.ts). `lint: 'passed'` in a JSON file
 * is a word; the text is here, so it is checked. Throws with the remedy.
 */
export function validateIndex(parsed: unknown, path = 'index'): IndexFile {
  const file = checkVersion(parsed, path);
  const entities = checkEntities(file, path);
  const fragmentsByEntity = new Map<string, Fragment[]>();
  const seen = new Set<string>();
  for (const raw of file.entries as unknown[]) {
    const fragment = checkEntry(raw, false, entities, seen, path);
    const entity = entities.get(fragment.entityId)!;
    if (fragment.disclosure.exposure === 'semantic' && !isServableGist(fragment, entity)) {
      throw new Error(
        `index at ${path}: fragment '${fragment.id}' is exposed as 'semantic' without a servable gist. ${REBUILD}`,
      );
    }
    let list = fragmentsByEntity.get(entity.id);
    if (!list) fragmentsByEntity.set(entity.id, (list = []));
    list.push(fragment);
  }
  for (const entity of entities.values()) {
    const fragments = fragmentsByEntity.get(entity.id);
    if (!fragments) {
      // Every build writes an entity with its fragments; one without any is a
      // hand edit, and it would vanish at toServedIndex instead of failing here.
      throw new Error(`index at ${path}: entity '${entity.id}' has no fragment. ${REBUILD}`);
    }
    if (entity.disclosure.raw === 'private') {
      assertPublicSafeMetadata(entity, fragments, { path: `index at ${path}` });
    }
    const entityText = fragments.length > 1 ? entityLintText(fragments) : undefined;
    const lint = entity.policy?.lint;
    for (const fragment of fragments) {
      const projection = fragment.projection;
      if (fragment.disclosure.exposure !== 'semantic' || projection?.lint !== 'passed') continue;
      if (projection.contentHash !== projectionContentHash(fragment.text)) {
        throw new Error(
          `index at ${path}: fragment '${fragment.id}' is exposed as 'semantic' with a gist drafted against ` +
            `other text (contentHash does not match the fragment). ${REBUILD}`,
        );
      }
      assertSemanticProjection(projection.gist, {
        path: `index at ${path}: fragment '${fragment.id}'`,
        fragmentText: fragment.text,
        ...(entityText !== undefined ? { entityText } : {}),
        maxChars: lint?.gistMaxChars,
        ngramWords: lint?.ngramWords,
        ngramChars: lint?.ngramChars,
      });
    }
  }
  return file as unknown as IndexFile;
}

/** Validate a served index: the same shape checks as validateIndex, plus the
 *  strip of CONTRACT.md §3 rule 4 actually happened. The lints cannot run here
 *  (the text is blank) and are not pretended to; a served index is trusted to
 *  descend from a validated private one. A served index that fails this was
 *  misbuilt and is refused. */
export function validateServedIndex(parsed: unknown, path = 'served index'): ServedIndexFile {
  const file = checkVersion(parsed, path);
  if (file.served !== true) throw new Error(`index at ${path} is not marked as a served index. ${REBUILD}`);
  const entities = checkEntities(file, path);
  for (const e of entities.values()) {
    if ('policy' in e) throw new Error(`index at ${path}: entity '${e.id}' still carries policy. ${REBUILD}`);
  }
  const servedEntities = new Set<string>();
  const seen = new Set<string>();
  for (const raw of file.entries as unknown[]) {
    if (isRecord(raw) && 'contentHash' in raw) throw new Error(`index at ${path} still carries contentHash. ${REBUILD}`);
    const f = checkEntry(raw, true, entities, seen, path);
    const exposure = f.disclosure.exposure;
    if (exposure === 'none') throw new Error(`index at ${path}: fragment '${f.id}' has exposure 'none'. ${REBUILD}`);
    if (exposure !== 'text' && (f.text !== '' || (f.summary !== undefined && f.summary !== ''))) {
      throw new Error(`index at ${path}: fragment '${f.id}' is '${exposure}' but still carries text. ${REBUILD}`);
    }
    if (exposure !== 'semantic' && f.projection !== undefined) {
      throw new Error(`index at ${path}: fragment '${f.id}' is '${exposure}' but still carries a projection. ${REBUILD}`);
    }
    if (exposure === 'semantic' && f.projection === undefined) {
      throw new Error(`index at ${path}: fragment '${f.id}' is 'semantic' without a passed gist. ${REBUILD}`);
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

/** Write a private index. What would be refused at load is refused here, with
 *  the same message, so a build cannot leave an artifact behind that the next
 *  command rejects. */
export function writeIndex(file: IndexFile, path: string = INDEX_PATH): void {
  const out = { version: INDEX_SCHEMA_VERSION, entities: file.entities, entries: file.entries };
  validateIndex(out, path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(out) + '\n', 'utf8');
}

export function readServedIndex(path: string): ServedIndexFile {
  return validateServedIndex(parseJson(path), path);
}

/** Write a served index, after the same validation a load would run. */
export function writeServedIndex(file: ServedIndexFile, path: string): void {
  validateServedIndex(file, path);
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
  if (!isRecord(e) || vectorProblem(e) !== null || typeof e.contentHash !== 'string') return false;
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
