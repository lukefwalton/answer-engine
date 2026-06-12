// npm run ask -- "your question" — the full path: embed the query, retrieve
// both evidence streams, cross the no-leak boundary, ask the model for a
// cited answer, print it.

import OpenAI from 'openai';

import { config } from '../../archive.config.js';
import { answerQuestion } from '../answer.js';
import { embedBatch } from '../embedding.js';
import { assembleEvidence } from '../no-leak.js';
import { retrieve } from '../retrieve.js';
import { assertHomogeneousIndex, readIndexFile } from '../store.js';

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question) throw new Error('Usage: npm run ask -- "your question"');

  const index = readIndexFile();
  if (index.length === 0) {
    throw new Error('Index is empty. Run `npm run index` first.');
  }
  assertHomogeneousIndex(index);

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set. Put it in .env or the environment.');
  }
  const client = new OpenAI();

  // Embed the query with the same model the index used (the stored entries
  // are the source of truth; cosine across models is meaningless).
  const spec = index[0]!;
  const [embedded] = await embedBatch(client, [{ id: 'query', text: question }], {
    model: spec.model,
    dimensions: spec.dimensions,
  });

  const hits = retrieve(embedded!.vector, question, index);

  // The boundary crossing: private notes become routing hints (no text) here,
  // and only here. Everything past this line is public-safe.
  const evidence = assembleEvidence(
    hits.records.map((h) => h.record),
    hits.notes.map((h) => h.note),
  );
  console.log(`Evidence: ${evidence.records.length} records, ${evidence.hints.length} hints\n`);

  const answer = await answerQuestion(client, question, evidence, config);

  console.log(`Mode: ${answer.mode}`);
  // not-found carries an empty answer string by contract; say it plainly.
  console.log(answer.mode === 'not-found' ? "I don't know." : answer.answer);
  if (answer.citations.length > 0) {
    console.log('\nCitations:');
    for (const c of answer.citations) {
      console.log(c.kind === 'record' ? `  [${c.recordId}] ${c.url}` : `  [${c.hintId}] ${c.url}`);
    }
  }
}

main().catch((err) => {
  console.error(`ask failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
