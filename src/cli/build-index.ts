// npm run index — read both layers, embed what changed, write artifacts/index.json.
//
// Idempotent by content hash: a source only re-embeds when its embedded text
// or the configured model changed. Sources that disappeared are pruned
// automatically because the index is rewritten from live sources.

import { createHash } from 'node:crypto';
import OpenAI from 'openai';

import { config } from '../../archive.config.js';
import { buildCorpus, buildPrivateNotes, embedText, noteEmbedText } from '../corpus.js';
import { batchInputs, embedBatch, truncateForEmbedding } from '../embedding.js';
import {
  assertHomogeneousIndex,
  entrySourceId,
  INDEX_PATH,
  readIndexFile,
  writeIndexFile,
} from '../store.js';
import type { ArchiveRecord, IndexEntry, PrivateNote } from '../types.js';

/** Hash the text actually sent to OpenAI, so edits past the truncation point
 *  don't force a paid re-embed the model would never see. */
function contentHash(text: string): string {
  return createHash('sha1').update(truncateForEmbedding(text)).digest('hex').slice(0, 16);
}

type Source =
  | { sourceType: 'record'; id: string; record: ArchiveRecord; text: string }
  | { sourceType: 'note'; id: string; note: PrivateNote; text: string };

async function main(): Promise<void> {
  const records = buildCorpus(config);
  if (records.length === 0) {
    throw new Error(
      `No records found under '${config.contentRoot}'. Check archive.config.ts collections.`,
    );
  }
  const notes = buildPrivateNotes(config);
  console.log(`Corpus: ${records.length} records, ${notes.length} private notes`);

  const sources: Source[] = [
    ...records.map((record): Source => ({ sourceType: 'record', id: record.id, record, text: embedText(record) })),
    ...notes.map((note): Source => ({ sourceType: 'note', id: note.id, note, text: noteEmbedText(note) })),
  ];

  const stored = new Map(readIndexFile().map((e) => [entrySourceId(e), e]));
  const entries: IndexEntry[] = [];
  const toEmbed: { source: Source; hash: string }[] = [];

  for (const source of sources) {
    const hash = contentHash(source.text);
    const existing = stored.get(source.id);
    if (
      existing &&
      existing.contentHash === hash &&
      existing.model === config.embeddingModel &&
      existing.sourceType === source.sourceType
    ) {
      // Vector is current; refresh the source (metadata may have changed).
      entries.push(
        source.sourceType === 'record'
          ? { ...existing, sourceType: 'record', record: source.record }
          : { ...existing, sourceType: 'note', note: source.note },
      );
    } else {
      toEmbed.push({ source, hash });
    }
  }

  console.log(`Embedding ${toEmbed.length} new/changed, ${entries.length} unchanged`);

  if (toEmbed.length > 0) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set. Put it in .env or the environment.');
    }
    const client = new OpenAI();
    const byId = new Map(toEmbed.map((j) => [j.source.id, j]));
    let done = 0;
    for (const batch of batchInputs(toEmbed.map((j) => ({ id: j.source.id, text: j.source.text })))) {
      const results = await embedBatch(client, batch, { model: config.embeddingModel });
      for (const result of results) {
        const job = byId.get(result.id)!;
        const vec = {
          model: config.embeddingModel,
          dimensions: result.vector.length,
          vector: result.vector,
          contentHash: job.hash,
        };
        entries.push(
          job.source.sourceType === 'record'
            ? { ...vec, sourceType: 'record', record: job.source.record }
            : { ...vec, sourceType: 'note', note: job.source.note },
        );
      }
      done += batch.length;
      console.log(`  embedded ${done}/${toEmbed.length}`);
    }
  }

  entries.sort((a, b) => entrySourceId(a).localeCompare(entrySourceId(b)));
  assertHomogeneousIndex(entries);
  writeIndexFile(entries);
  console.log(`Wrote ${entries.length} entries to ${INDEX_PATH}`);
}

main().catch((err) => {
  console.error(`index failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
