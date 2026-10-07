// npm run demo:build — embed what changed in the demo corpus, draft the book's
// gists, embed any new gold queries, and write the committed artifacts. KEYED:
// needs network to the OpenAI API and an OPENAI_API_KEY. The logic lives in
// demo/build-lib.ts so the tests can run the same path with fakes; this file
// only supplies the real client. See docs/scaling-demo/build-handoff.md.
//
// A run with nothing new to embed and nothing to draft still needs the key
// check here, because the drafter and the embedder are opened lazily and a
// build that turns out to need one must not fail halfway.

import { resolve } from 'node:path';
import OpenAI from 'openai';

import { batchInputs, embedBatch } from '../src/embedding.js';
import type { EmbedRequest } from '../src/embedding.js';
import { createOpenAIGistDrafter } from '../src/ingest/gist.js';
import type { GistDrafter } from '../src/ingest/gist.js';
import { buildDemo } from './build-lib.js';
import type { Embedder } from './build-lib.js';
import { BOOK_DIR, config, SYNTHETIC_NOTES_DIR } from './config.js';
import { QUERY_VECTORS_PATH } from './query-vectors.js';

export const DEMO_PATHS = {
  natural: resolve('demo/corpus/index.json'),
  synthetic: resolve('demo/corpus/index.synthetic.json'),
  book: resolve('demo/corpus/index.book.json'),
  projections: resolve('demo/corpus/projections.json'),
  queryVectors: QUERY_VECTORS_PATH,
  naturalGold: resolve('demo/gold.yaml'),
  syntheticGold: resolve('demo/gold.synthetic.yaml'),
  bookGold: resolve('demo/gold.book.yaml'),
};

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set. demo:build needs it to embed and to draft (see build-handoff.md).');
  }
  const client = new OpenAI();

  const embed: Embedder = async (jobs: readonly EmbedRequest[]) => {
    const byId = new Map<string, number[]>();
    let done = 0;
    for (const batch of batchInputs(jobs)) {
      const results = await embedBatch(client, batch, { model: config.embeddingModel });
      for (const r of results) byId.set(r.id, r.vector);
      done += batch.length;
      console.log(`  embedded ${done}/${jobs.length}`);
    }
    return byId;
  };

  const model = config.gist?.model ?? config.answerModel;
  let inner: GistDrafter | undefined;
  const drafter: GistDrafter = {
    model,
    draft: (request) => (inner ??= createOpenAIGistDrafter(client, { model })).draft(request),
  };

  const summary = await buildDemo({
    config,
    syntheticNotesDir: SYNTHETIC_NOTES_DIR,
    bookDir: BOOK_DIR,
    paths: DEMO_PATHS,
    embed,
    drafter,
    log: (line) => console.log(line),
  });
  console.log(
    `Wrote ${summary.written.natural} natural, ${summary.written.spire} spire, ${summary.written.book} book entries ` +
      `and ${summary.written.queries} gold-query vectors`,
  );
  console.log('Done. Commit the demo/corpus/*.json artifacts, then `npm run demo:run` (and `-- --natural+book`).');
}

main().catch((err) => {
  console.error(`demo:build failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
