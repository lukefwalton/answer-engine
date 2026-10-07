// npm run index — read the public collections, the private notes, and the
// private books; draft the gists the author asked for,
// resolve each fragment's exposure, embed what changed, and write the private
// index (artifacts/index.json) and the author's projections file
// (artifacts/projections.json). Both are private material and gitignored.
//
// Idempotent by content hash on two axes: a fragment only re-embeds when its
// embed string or the configured embedding model changed, and a gist is only
// redrafted when its text, the drafter's model, or the prompt version changed
// (src/ingest/gist.ts). An author's edited gist is never redrafted. Sources
// that disappeared are pruned automatically because both files are rewritten
// from live sources. A run with nothing to draft and nothing to embed needs no
// key.
//
// The previous index is read through the same validator every load uses. One
// that fails it is refused here too, with the remedy, and nothing in it is
// reused: a build never proceeds from an artifact the next command would
// reject (.github/STANDARDS.md §4).
//
// What this command prints: counts, ids, field names, and the positions of
// lint failures. The store's and the lints' messages carry no private text by
// construction (src/public-safe.ts, src/store.ts), so printing one is safe
// (.github/STANDARDS.md §4).

import { createHash } from 'node:crypto';
import OpenAI from 'openai';

import { config } from '../../archive.config.js';
import { fromArchiveRecord, fromPrivateBook, fromPrivateNote } from '../adapters/teaching.js';
import type { Entity, EntityPolicy, Fragment, SemanticProjection } from '../contract.js';
import { buildCorpus, buildPrivateBooks, buildPrivateNotes } from '../corpus.js';
import { embedStringFor } from '../embed-string.js';
import { batchInputs, embedBatch, truncateForEmbedding } from '../embedding.js';
import { collectEntities } from '../ingest/collect.js';
import { resolveDisclosure } from '../ingest/disclosure.js';
import { createOpenAIGistDrafter, draftProjections } from '../ingest/gist.js';
import type { GistDrafter, ProjectionDraftInput } from '../ingest/gist.js';
import { PROJECTIONS_PATH, readProjections, writeProjections } from '../ingest/projections.js';
import { PublicSafeLintError } from '../public-safe.js';
import { assertHomogeneousEntries, INDEX_PATH, INDEX_SCHEMA_VERSION, readIndex, writeIndex } from '../store.js';
import type { FragmentEntry } from '../store.js';

/** Hash the text actually sent to OpenAI, so edits past the truncation point
 *  don't force a paid re-embed the model would never see. */
function contentHash(text: string): string {
  return createHash('sha1').update(truncateForEmbedding(text)).digest('hex').slice(0, 16);
}

let cachedClient: OpenAI | undefined;
function client(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set. Put it in .env or the environment.');
  }
  return (cachedClient ??= new OpenAI());
}

/** Opens the client on first use, so a run with every gist current needs no key. */
function lazyDrafter(model: string): GistDrafter {
  let inner: GistDrafter | undefined;
  return {
    model,
    draft: (request) => (inner ??= createOpenAIGistDrafter(client(), { model })).draft(request),
  };
}

/** The previous index's entries by fragment id, for vector reuse. The read is
 *  the load-time validation every command runs; a previous index that fails
 *  it is refused, not worked around. A lint failure (the author tightened the
 *  window, or fixed a string or a gist the artifact still carries) gets the
 *  remedy the store's other refusals carry: fix the source, delete the file,
 *  rerun. The lint's message names the field and the position of the run, not
 *  the run, so the whole message is safe to print. */
function previousEntries(): Map<string, FragmentEntry> {
  try {
    return new Map(readIndex().entries.map((e) => [e.fragment.id, e]));
  } catch (err) {
    if (err instanceof PublicSafeLintError) {
      throw new Error(
        `${err.message} The previous index is refused and nothing in it is reused: fix the source ` +
          `(the note's frontmatter, or the gist in ${PROJECTIONS_PATH}), then delete ${INDEX_PATH} and rerun \`npm run index\` to re-embed.`,
      );
    }
    throw err;
  }
}

/** A window tuned in archive.config.ts becomes each entity's `policy.lint`
 *  (docs/CONTRACT.md §6): the index then carries the terms its strings and
 *  gists were checked under, and the validator reads them back at load. */
function lintPolicy(gist: typeof config.gist): EntityPolicy['lint'] | undefined {
  const lint: NonNullable<EntityPolicy['lint']> = {
    ...(gist?.ngramWords !== undefined ? { ngramWords: gist.ngramWords } : {}),
    ...(gist?.maxChars !== undefined ? { gistMaxChars: gist.maxChars } : {}),
  };
  return Object.keys(lint).length > 0 ? lint : undefined;
}

interface Source {
  entity: Entity;
  fragment: Fragment;
}

async function main(): Promise<void> {
  const records = buildCorpus(config);
  if (records.length === 0) {
    throw new Error(
      `No records found under '${config.contentRoot}'. Check archive.config.ts collections.`,
    );
  }
  const notes = buildPrivateNotes(config);
  const books = buildPrivateBooks(config);
  console.log(`Corpus: ${records.length} records, ${notes.length} private notes, ${books.length} private books`);

  // A record or a note is one fragment; a book is one entity with many.
  const sources: Source[] = [
    ...records.map(fromArchiveRecord),
    ...notes.map(fromPrivateNote),
    ...books.flatMap(fromPrivateBook),
  ];
  const lint = lintPolicy(config.gist);
  if (lint) for (const { entity } of sources) entity.policy = { ...entity.policy, lint };
  // Entities once, every fragment under its entity (CONTRACT.md §12). The
  // teaching adapters yield one fragment per entity; a fragmenter yields many,
  // and collectEntities groups either, refusing an id described two ways or a
  // fragment produced twice.
  const { entities, fragments: byEntity } = collectEntities(sources);

  // Projections: draft where the author asked for a gist, keep edits, carry the rest.
  const stored = readProjections(PROJECTIONS_PATH);
  const drafter = lazyDrafter(config.gist?.model ?? config.answerModel);
  const projections = new Map<string, SemanticProjection>();
  const unservable: { fragmentId: string; reason: string }[] = [];
  const totals = { drafted: 0, skipped: 0, kept: 0, failed: 0 };
  for (const [entityId, group] of byEntity) {
    const entity = entities.get(entityId)!;
    // An adapter emits each fragment's REQUESTED exposure on the fragment: the
    // entity default unless the adapter overrode it (CONTRACT.md §3). It is
    // read here for drafting and below for resolution, then overwritten.
    const inputs: ProjectionDraftInput[] = group.map((fragment) => ({
      id: fragment.id,
      text: fragment.text,
      locator: fragment.locator,
      requested: fragment.disclosure.exposure,
    }));
    const result = await draftProjections(entity, inputs, drafter, {
      existing: stored,
      allowedNames: config.gist?.allowedNames?.[entity.id],
    });
    for (const [id, projection] of result.projections) projections.set(id, projection);
    unservable.push(...result.unservable);
    totals.drafted += result.stats.drafted;
    totals.skipped += result.stats.skipped;
    totals.kept += result.stats.kept;
    totals.failed += result.stats.failed;
  }
  if (projections.size > 0 || stored.size > 0) {
    writeProjections(projections, PROJECTIONS_PATH);
    console.log(
      `Projections: ${totals.drafted} drafted, ${totals.skipped} unchanged, ${totals.kept} edited and kept, ` +
        `${totals.failed} failed the lint → ${PROJECTIONS_PATH}`,
    );
  }

  // Resolve every fragment's exposure from its request and its projection
  // (docs/CONTRACT.md §3): the one place the policy is decided, stored on the fragment.
  for (const { fragment } of sources) {
    const entity = entities.get(fragment.entityId)!;
    const projection = projections.get(fragment.id);
    if (projection) fragment.projection = projection;
    fragment.disclosure = resolveDisclosure(entity, { exposure: fragment.disclosure.exposure, projection }, { path: fragment.id });
  }
  for (const { fragmentId, reason } of unservable) {
    console.log(`  ${fragmentId}: asked for 'semantic', resolved to 'locator' — ${reason}`);
  }

  // Embed what changed.
  const previous = previousEntries();
  const entries: FragmentEntry[] = [];
  const toEmbed: { source: Source; text: string; hash: string }[] = [];
  for (const source of sources) {
    const text = embedStringFor(source.fragment, source.entity);
    const hash = contentHash(text);
    const existing = previous.get(source.fragment.id);
    if (existing && existing.contentHash === hash && existing.model === config.embeddingModel) {
      // Vector is current; the fragment (metadata, resolved disclosure, projection) is refreshed.
      entries.push({ ...existing, fragment: source.fragment });
    } else {
      toEmbed.push({ source, text, hash });
    }
  }
  console.log(`Embedding ${toEmbed.length} new/changed, ${entries.length} unchanged`);

  if (toEmbed.length > 0) {
    const byId = new Map(toEmbed.map((job) => [job.source.fragment.id, job]));
    let done = 0;
    for (const batch of batchInputs(toEmbed.map((job) => ({ id: job.source.fragment.id, text: job.text })))) {
      const results = await embedBatch(client(), batch, { model: config.embeddingModel });
      for (const result of results) {
        const job = byId.get(result.id)!;
        entries.push({
          model: config.embeddingModel,
          dimensions: result.vector.length,
          vector: result.vector,
          contentHash: job.hash,
          fragment: job.source.fragment,
        });
      }
      done += batch.length;
      console.log(`  embedded ${done}/${toEmbed.length}`);
    }
  }

  entries.sort((a, b) => a.fragment.id.localeCompare(b.fragment.id));
  assertHomogeneousEntries(entries);
  writeIndex({
    version: INDEX_SCHEMA_VERSION,
    entities: [...entities.values()].sort((a, b) => a.id.localeCompare(b.id)),
    entries,
  });
  console.log(`Wrote ${entries.length} fragments across ${entities.size} entities to ${INDEX_PATH}`);
}

main().catch((err) => {
  console.error(`index failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
