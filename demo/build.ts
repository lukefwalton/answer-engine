// npm run demo:build — embed the scaling corpus and the gold queries, then
// commit the vectors. KEYED and run once (or after corpus edits): needs network
// to the embedding API and an OPENAI_API_KEY. The session that wrote this code
// had neither; see docs/scaling-demo/build-handoff.md.
//
// Reuses the core corpus loaders, embedding, and store writers untouched. The
// only thing new is pointing them at demo/corpus/ and splitting the output
// into the natural index (the headline source of truth), the synthetic spire
// (a strictly baseline-plus-delta file, unioned only under --natural+synthetic),
// and the committed gold-query vectors (what makes demo:run keyless).

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import OpenAI from 'openai';

import { buildCorpus, buildPrivateNotes, embedText, noteEmbedText } from '../src/corpus.js';
import { batchInputs, embedBatch, truncateForEmbedding } from '../src/embedding.js';
import { assertHomogeneousIndex, writeIndexFile } from '../src/store.js';
import type { ArchiveConfig, IndexEntry, PrivateNote } from '../src/types.js';
import { loadGold } from '../src/evaluate.js';
import { config, SYNTHETIC_NOTES_DIR } from './config.js';
import { writeQueryVectors } from './query-vectors.js';

const NATURAL_INDEX = resolve('demo/corpus/index.json');
const SYNTHETIC_INDEX = resolve('demo/corpus/index.synthetic.json');
const NATURAL_GOLD = resolve('demo/gold.yaml');
const SYNTHETIC_GOLD = resolve('demo/gold.synthetic.yaml');

function contentHash(text: string): string {
  return createHash('sha1').update(truncateForEmbedding(text)).digest('hex').slice(0, 16);
}

type EmbedJob = { id: string; text: string };

async function embedAll(client: OpenAI, jobs: EmbedJob[]): Promise<Map<string, number[]>> {
  const byId = new Map<string, number[]>();
  let done = 0;
  for (const batch of batchInputs(jobs)) {
    const results = await embedBatch(client, batch, { model: config.embeddingModel });
    for (const r of results) byId.set(r.id, r.vector);
    done += batch.length;
    console.log(`  embedded ${done}/${jobs.length}`);
  }
  return byId;
}

function recordEntries(config: ArchiveConfig, vectors: Map<string, number[]>): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const record of buildCorpus(config)) {
    const text = embedText(record);
    const vector = vectors.get(record.id);
    if (!vector) throw new Error(`no embedding returned for record '${record.id}'; refusing to write a partial index.`);
    entries.push({
      model: config.embeddingModel,
      dimensions: vector.length,
      vector,
      contentHash: contentHash(text),
      sourceType: 'record',
      record,
    });
  }
  return entries;
}

function noteEntries(notes: PrivateNote[], vectors: Map<string, number[]>): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const note of notes) {
    const vector = vectors.get(note.id);
    if (!vector) throw new Error(`no embedding returned for note '${note.id}'; refusing to write a partial index.`);
    entries.push({
      model: config.embeddingModel,
      dimensions: vector.length,
      vector,
      contentHash: contentHash(noteEmbedText(note)),
      sourceType: 'note',
      note,
    });
  }
  return entries;
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set. demo:build needs it to embed (see build-handoff.md).');
  }
  const client = new OpenAI();

  const records = buildCorpus(config);
  const naturalNotes = buildPrivateNotes(config);
  const syntheticNotes = buildPrivateNotes({ ...config, privateNotesDir: SYNTHETIC_NOTES_DIR });
  console.log(
    `Corpus: ${records.length} records, ${naturalNotes.length} private notes, ` +
      `${syntheticNotes.length} synthetic notes`,
  );
  if (records.length === 0) {
    throw new Error('No records found under demo/corpus/public — populate it first (build-handoff.md §1).');
  }

  // Gold queries: natural always, synthetic if authored.
  const gold = loadGold(NATURAL_GOLD, config.authorName);
  const goldQueries = [...gold];
  if (existsSync(SYNTHETIC_GOLD)) {
    goldQueries.push(...loadGold(SYNTHETIC_GOLD, config.authorName));
  }

  // One embedding pass over every source and query, distinguished by id.
  const sourceJobs: EmbedJob[] = [
    ...records.map((r) => ({ id: r.id, text: embedText(r) })),
    ...naturalNotes.map((n) => ({ id: n.id, text: noteEmbedText(n) })),
    ...syntheticNotes.map((n) => ({ id: n.id, text: noteEmbedText(n) })),
  ];
  const queryJobs: EmbedJob[] = goldQueries.map((g) => ({ id: `query:${g.id}`, text: g.query }));

  console.log(`Embedding ${sourceJobs.length} sources and ${queryJobs.length} gold queries...`);
  const vectors = await embedAll(client, [...sourceJobs, ...queryJobs]);

  // Natural index: records + real private notes.
  const naturalEntries = [...recordEntries(config, vectors), ...noteEntries(naturalNotes, vectors)].sort((a, b) =>
    (a.sourceType === 'record' ? a.record.id : a.note.id).localeCompare(
      b.sourceType === 'record' ? b.record.id : b.note.id,
    ),
  );
  assertHomogeneousIndex(naturalEntries);
  writeIndexFile(naturalEntries, NATURAL_INDEX);
  console.log(`Wrote ${naturalEntries.length} natural entries to ${NATURAL_INDEX}`);

  // Synthetic spire: written only when authored, so the headline never depends on it.
  if (syntheticNotes.length > 0) {
    const spireEntries = noteEntries(syntheticNotes, vectors);
    assertHomogeneousIndex([...naturalEntries, ...spireEntries]); // spire must share the space
    writeIndexFile(spireEntries, SYNTHETIC_INDEX);
    console.log(`Wrote ${spireEntries.length} synthetic spire entries to ${SYNTHETIC_INDEX}`);
  } else {
    console.log('No synthetic notes authored yet; skipping the spire index.');
  }

  // Committed gold-query vectors (what makes demo:run keyless). Every gold
  // query must embed, or the keyless runner would later fail on a missing id.
  const queryVectors = goldQueries.map((g) => {
    const vector = vectors.get(`query:${g.id}`);
    if (!vector) throw new Error(`no embedding returned for gold query '${g.id}'; refusing to write partial query vectors.`);
    return { id: g.id, vector };
  });
  const dims = queryVectors[0]?.vector.length ?? naturalEntries[0]?.dimensions ?? 0;
  writeQueryVectors(config.embeddingModel, dims, queryVectors);
  console.log(`Wrote ${queryVectors.length} gold-query vectors`);
  console.log('Done. Commit the *.json artifacts, then `npm run demo:run`.');
}

main().catch((err) => {
  console.error(`demo:build failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
