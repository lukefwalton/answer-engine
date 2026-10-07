// demo/build-lib.ts — the demo build as pure functions. demo/build.ts drives
// them with the real embedding client and gist drafter (keyed); the tests run
// them with fakes (keyless), so the whole path from markdown to committed
// artifacts is checked before anyone spends a key on it.
//
// What a build produces, all committed (they derive from public-domain text;
// demo/corpus/README.md §2 says why that is safe here and not in general):
//   demo/corpus/index.json            the natural layer: records + real private notes
//   demo/corpus/index.synthetic.json  the spire: synthetic notes only (--natural+synthetic)
//   demo/corpus/index.book.json       the book: one private entity, chapter fragments (--natural+book)
//   demo/corpus/projections.json      the book's gists, the author-facing file
//   demo/corpus/query-vectors.json    the gold-query vectors that keep demo:run keyless
//
// Idempotent by content hash, as `npm run index` is (src/cli/build-index.ts):
// a fragment is re-embedded only when its embed string or the model changed, a
// gold query only when its id is new, and a gist is redrafted only when its
// text, the drafter's model, or the prompt version moved. So adding the book
// does not touch a Smith vector, and the headline numbers do not move because
// a layer was added beside them.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

import { fromArchiveRecord, fromPrivateBook, fromPrivateNote } from '../src/adapters/teaching.js';
import type { Entity, EntityPolicy, Fragment, SemanticProjection } from '../src/contract.js';
import { buildCorpus, buildPrivateBooks, buildPrivateNotes } from '../src/corpus.js';
import { embedStringFor } from '../src/embed-string.js';
import { truncateForEmbedding } from '../src/embedding.js';
import type { EmbedRequest } from '../src/embedding.js';
import { loadGold } from '../src/evaluate.js';
import type { GoldQuery } from '../src/evaluate.js';
import { collectEntities } from '../src/ingest/collect.js';
import { resolveDisclosure } from '../src/ingest/disclosure.js';
import { draftProjections } from '../src/ingest/gist.js';
import type { GistDrafter, ProjectionDraftInput } from '../src/ingest/gist.js';
import { readProjections, writeProjections } from '../src/ingest/projections.js';
import { assertHomogeneousEntries, INDEX_SCHEMA_VERSION, readIndex, writeIndex } from '../src/store.js';
import type { FragmentEntry, IndexFile } from '../src/store.js';
import type { ArchiveConfig } from '../src/types.js';
import { queryContentHash, readQueryVectors, writeQueryVectors } from './query-vectors.js';

export interface Source {
  entity: Entity;
  fragment: Fragment;
}

/** Embeds every job and returns a vector per id. The CLI batches through the
 *  API; the tests hand back deterministic vectors. */
export type Embedder = (jobs: readonly EmbedRequest[]) => Promise<ReadonlyMap<string, number[]>>;

/** Hash the text actually sent to the embedding model (mirrors src/cli/build-index.ts). */
export function contentHash(text: string): string {
  return createHash('sha1').update(truncateForEmbedding(text)).digest('hex').slice(0, 16);
}

/** A lint window tuned in the config becomes each entity's `policy.lint`
 *  (docs/CONTRACT.md §6), as `npm run index` does. */
function lintPolicy(gist: ArchiveConfig['gist']): EntityPolicy['lint'] | undefined {
  const lint: NonNullable<EntityPolicy['lint']> = {
    ...(gist?.ngramWords !== undefined ? { ngramWords: gist.ngramWords } : {}),
    ...(gist?.maxChars !== undefined ? { gistMaxChars: gist.maxChars } : {}),
  };
  return Object.keys(lint).length > 0 ? lint : undefined;
}

export interface DemoSources {
  natural: Source[];
  spire: Source[];
  book: Source[];
  counts: { records: number; notes: number; syntheticNotes: number; books: number };
}

/** Read the three layers through the teaching adapters. The spire and the
 *  book are optional by presence: a layer whose directory is absent is
 *  empty, not an error, because the natural layer owns the headline and the
 *  other two are added beside it under their flags (demo/run.ts). */
export function readSources(config: ArchiveConfig, syntheticNotesDir: string, bookDir: string): DemoSources {
  const records = buildCorpus(config);
  if (records.length === 0) {
    throw new Error(`No records found under '${config.contentRoot}'; populate the public layer first (build-handoff.md §1).`);
  }
  const notes = buildPrivateNotes(config);
  const syntheticNotes = existsSync(syntheticNotesDir) ? buildPrivateNotes({ ...config, privateNotesDir: syntheticNotesDir }) : [];
  const books = existsSync(bookDir) ? buildPrivateBooks({ ...config, privateBooksDir: bookDir }) : [];
  const sources: DemoSources = {
    natural: [...records.map(fromArchiveRecord), ...notes.map(fromPrivateNote)],
    spire: syntheticNotes.map(fromPrivateNote),
    book: books.flatMap(fromPrivateBook),
    counts: { records: records.length, notes: notes.length, syntheticNotes: syntheticNotes.length, books: books.length },
  };
  const lint = lintPolicy(config.gist);
  if (lint) {
    for (const layer of [sources.natural, sources.spire, sources.book]) {
      for (const { entity } of layer) entity.policy = { ...entity.policy, lint };
    }
  }
  return sources;
}

export interface DraftSummary {
  projections: Map<string, SemanticProjection>;
  stats: { drafted: number; skipped: number; kept: number; failed: number };
  unservable: { fragmentId: string; reason: string }[];
}

/** Draft, keep, or carry a projection for every entity, as `npm run index`
 *  does: only fragments that request `semantic` ever reach the drafter, so a
 *  layer without such a request costs no call. */
export async function draftAll(
  sources: readonly Source[],
  drafter: GistDrafter,
  existing: ReadonlyMap<string, SemanticProjection>,
  config: ArchiveConfig,
): Promise<DraftSummary> {
  const { entities, fragments: byEntity } = collectEntities(sources);
  const projections = new Map<string, SemanticProjection>();
  const unservable: DraftSummary['unservable'] = [];
  const stats = { drafted: 0, skipped: 0, kept: 0, failed: 0 };
  for (const [entityId, group] of byEntity) {
    const entity = entities.get(entityId)!;
    const inputs: ProjectionDraftInput[] = group.map((fragment) => ({
      id: fragment.id,
      text: fragment.text,
      locator: fragment.locator,
      requested: fragment.disclosure.exposure,
    }));
    const result = await draftProjections(entity, inputs, drafter, {
      existing,
      allowedNames: config.gist?.allowedNames?.[entity.id],
    });
    for (const [id, projection] of result.projections) projections.set(id, projection);
    unservable.push(...result.unservable);
    stats.drafted += result.stats.drafted;
    stats.skipped += result.stats.skipped;
    stats.kept += result.stats.kept;
    stats.failed += result.stats.failed;
  }
  return { projections, stats, unservable };
}

export interface LayerPlan {
  entities: Entity[];
  /** Entries whose vector is current, refreshed with the rebuilt fragment. */
  reused: FragmentEntry[];
  /** Fragments that need a vector, with the text and hash to store. */
  toEmbed: { fragment: Fragment; text: string; hash: string }[];
}

/** Resolve every fragment's disclosure against its projection (the one place
 *  the policy is decided, docs/CONTRACT.md §3), then split the layer into
 *  vectors that can be reused and fragments that must be embedded. */
export function planLayer(
  sources: readonly Source[],
  previous: ReadonlyMap<string, FragmentEntry>,
  model: string,
  projections: ReadonlyMap<string, SemanticProjection>,
): LayerPlan {
  const { entities } = collectEntities(sources);
  const reused: FragmentEntry[] = [];
  const toEmbed: LayerPlan['toEmbed'] = [];
  for (const { entity, fragment } of sources) {
    const projection = projections.get(fragment.id);
    if (projection) fragment.projection = projection;
    fragment.disclosure = resolveDisclosure(entity, { exposure: fragment.disclosure.exposure, projection }, { path: fragment.id });
    const text = embedStringFor(fragment, entity);
    const hash = contentHash(text);
    const existing = previous.get(fragment.id);
    if (existing && existing.contentHash === hash && existing.model === model) {
      reused.push({ ...existing, fragment });
    } else {
      toEmbed.push({ fragment, text, hash });
    }
  }
  return { entities: [...entities.values()].sort((a, b) => a.id.localeCompare(b.id)), reused, toEmbed };
}

/** The index file for a layer once its vectors are in hand. Refuses to write
 *  a partial file: every planned fragment must have a vector. */
export function assembleLayer(plan: LayerPlan, vectors: ReadonlyMap<string, number[]>, model: string): IndexFile {
  const entries: FragmentEntry[] = [...plan.reused];
  for (const { fragment, hash } of plan.toEmbed) {
    const vector = vectors.get(fragment.id);
    if (!vector) throw new Error(`no embedding returned for '${fragment.id}'; refusing to write a partial index.`);
    entries.push({ model, dimensions: vector.length, vector, contentHash: hash, fragment });
  }
  entries.sort((a, b) => a.fragment.id.localeCompare(b.fragment.id));
  assertHomogeneousEntries(entries);
  return { version: INDEX_SCHEMA_VERSION, entities: plan.entities, entries };
}

/** The previous committed layer by fragment id. A file that fails the
 *  load-time validation is refused here too, with its own message: a build
 *  never proceeds from an artifact the next command would reject. */
export function previousEntries(path: string): Map<string, FragmentEntry> {
  return new Map(readIndex(path).entries.map((e) => [e.fragment.id, e]));
}

export interface DemoBuildPaths {
  natural: string;
  synthetic: string;
  book: string;
  projections: string;
  queryVectors: string;
  naturalGold: string;
  syntheticGold: string;
  bookGold: string;
}

export interface DemoBuildOptions {
  config: ArchiveConfig;
  syntheticNotesDir: string;
  bookDir: string;
  paths: DemoBuildPaths;
  embed: Embedder;
  drafter: GistDrafter;
  log?: (line: string) => void;
}

export interface DemoBuildSummary {
  counts: DemoSources['counts'];
  drafts: DraftSummary['stats'];
  unservable: DraftSummary['unservable'];
  /** Fragments embedded this run, per layer, and gold queries embedded. */
  embedded: { natural: number; spire: number; book: number; queries: number };
  written: { natural: number; spire: number; book: number; queries: number };
  /** Paths actually written (a layer with no sources writes nothing). */
  files: string[];
}

/** The gold set a build embeds: natural always; the spire's and the book's
 *  only when that layer has sources, so no vector is minted for a case that
 *  cannot run. */
export function goldForBuild(paths: DemoBuildPaths, sources: DemoSources, author: string): GoldQuery[] {
  const gold = loadGold(paths.naturalGold, author);
  if (sources.spire.length > 0 && existsSync(paths.syntheticGold)) gold.push(...loadGold(paths.syntheticGold, author));
  if (sources.book.length > 0 && existsSync(paths.bookGold)) gold.push(...loadGold(paths.bookGold, author));
  return assertUniqueGoldIds(gold);
}

/** Gold ids are unique across the demo's gold files: one id is one vector and
 *  one verdict. Shared by the build and the runner so neither can judge two
 *  cases under one id. */
export function assertUniqueGoldIds(gold: GoldQuery[]): GoldQuery[] {
  const seen = new Set<string>();
  for (const g of gold) {
    if (seen.has(g.id)) throw new Error(`gold id '${g.id}' appears in more than one demo gold file; ids are unique across them.`);
    seen.add(g.id);
  }
  return gold;
}

export async function buildDemo(options: DemoBuildOptions): Promise<DemoBuildSummary> {
  const { config, paths } = options;
  const log = options.log ?? (() => undefined);
  const model = config.embeddingModel;
  const sources = readSources(config, options.syntheticNotesDir, options.bookDir);
  log(
    `Corpus: ${sources.counts.records} records, ${sources.counts.notes} private notes, ` +
      `${sources.counts.syntheticNotes} synthetic notes, ${sources.counts.books} private books ` +
      `(${sources.book.length} book fragments)`,
  );

  // Projections: draft where a fragment asks for a gist, keep edits, carry the rest.
  const stored = readProjections(paths.projections);
  const drafts = await draftAll([...sources.natural, ...sources.spire, ...sources.book], options.drafter, stored, config);
  if (drafts.projections.size > 0 || stored.size > 0) {
    writeProjections(drafts.projections, paths.projections);
    log(
      `Projections: ${drafts.stats.drafted} drafted, ${drafts.stats.skipped} unchanged, ${drafts.stats.kept} edited and kept, ` +
        `${drafts.stats.failed} failed the lint → ${paths.projections}`,
    );
  }
  for (const { fragmentId, reason } of drafts.unservable) {
    log(`  ${fragmentId}: asked for 'semantic', resolved to 'locator' — ${reason}`);
  }

  // Plan every layer against its committed predecessor.
  const plans = {
    natural: planLayer(sources.natural, previousEntries(paths.natural), model, drafts.projections),
    spire: planLayer(sources.spire, previousEntries(paths.synthetic), model, drafts.projections),
    book: planLayer(sources.book, previousEntries(paths.book), model, drafts.projections),
  };

  // Gold queries: reuse a committed vector only when it was embedded from the
  // text the gold file carries now, under the same model. An id whose text
  // was edited is re-embedded, so the gate never judges a stale embedding.
  const gold = goldForBuild(paths, sources, config.authorName);
  const previousQueries = readQueryVectors(paths.queryVectors);
  const reusableQueries = new Map<string, number[]>();
  if (previousQueries && previousQueries.model === model) {
    for (const g of gold) {
      const vector = previousQueries.byId.get(g.id);
      if (vector && previousQueries.hashes.get(g.id) === queryContentHash(g.query)) reusableQueries.set(g.id, vector);
    }
  }
  const queryJobs: EmbedRequest[] = gold.filter((g) => !reusableQueries.has(g.id)).map((g) => ({ id: `query:${g.id}`, text: g.query }));

  const jobs: EmbedRequest[] = [
    ...plans.natural.toEmbed.map((j) => ({ id: j.fragment.id, text: j.text })),
    ...plans.spire.toEmbed.map((j) => ({ id: j.fragment.id, text: j.text })),
    ...plans.book.toEmbed.map((j) => ({ id: j.fragment.id, text: j.text })),
    ...queryJobs,
  ];
  const reusedCount = plans.natural.reused.length + plans.spire.reused.length + plans.book.reused.length;
  log(`Embedding ${jobs.length} new/changed (${queryJobs.length} gold queries new or edited), ${reusedCount + reusableQueries.size} unchanged`);
  const vectors = jobs.length > 0 ? await options.embed(jobs) : new Map<string, number[]>();

  const files: string[] = [];
  const written = { natural: 0, spire: 0, book: 0, queries: 0 };
  const natural = assembleLayer(plans.natural, vectors, model);
  writeIndex(natural, paths.natural);
  files.push(paths.natural);
  written.natural = natural.entries.length;

  // The spire and the book are strictly baseline-plus-delta files, written
  // only when authored, so the headline never depends on either.
  for (const [layer, path] of [
    ['spire', paths.synthetic],
    ['book', paths.book],
  ] as const) {
    const plan = plans[layer];
    if (plan.entities.length === 0) {
      log(`No ${layer === 'spire' ? 'synthetic notes' : 'book'} authored; skipping ${path}`);
      continue;
    }
    const file = assembleLayer(plan, vectors, model);
    assertHomogeneousEntries([...natural.entries, ...file.entries]); // must share the space
    writeIndex(file, path);
    files.push(path);
    written[layer] = file.entries.length;
  }

  const queryVectors = gold.map((g) => {
    const vector = reusableQueries.get(g.id) ?? vectors.get(`query:${g.id}`);
    if (!vector) throw new Error(`no embedding returned for gold query '${g.id}'; refusing to write partial query vectors.`);
    return { id: g.id, vector, contentHash: queryContentHash(g.query) };
  });
  const dims = queryVectors[0]?.vector.length ?? natural.entries[0]?.dimensions ?? 0;
  writeQueryVectors(model, dims, queryVectors, paths.queryVectors);
  files.push(paths.queryVectors);
  written.queries = queryVectors.length;

  return {
    counts: sources.counts,
    drafts: drafts.stats,
    unservable: drafts.unservable,
    embedded: {
      natural: plans.natural.toEmbed.length,
      spire: plans.spire.toEmbed.length,
      book: plans.book.toEmbed.length,
      queries: queryJobs.length,
    },
    written,
    files,
  };
}
