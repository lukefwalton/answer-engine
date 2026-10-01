// npm run ask -- "your question" — the full path: embed the query, retrieve
// both evidence streams, cross the no-leak boundary, ask the model for a
// cited answer, print it.

import OpenAI from 'openai';

import { config } from '../../archive.config.js';
import { answerQuestion } from '../answer.js';
import { embedBatch } from '../embedding.js';
import { toAnswerEvidence } from '../evidence.js';
import { search } from '../no-leak.js';
import { buildRetrievalIndex } from '../retrieve.js';
import { readIndex } from '../store.js';

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question) throw new Error('Usage: npm run ask -- "your question"');

  const file = readIndex();
  if (file.entries.length === 0) {
    throw new Error('Index is empty. Run `npm run index` first.');
  }
  const index = buildRetrievalIndex(file);

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set. Put it in .env or the environment.');
  }
  const client = new OpenAI();

  // Embed the query with the same model the index used (the stored entries
  // are the source of truth; cosine across models is meaningless).
  const [embedded] = await embedBatch(client, [{ id: 'query', text: question }], {
    model: index.model,
    dimensions: index.dimensions,
  });

  // search() is retrieve().map(project): the boundary crossing happens inside
  // it (src/no-leak.ts), so nothing past this line holds a Fragment.
  const hits = search(embedded!.vector, question, index);
  const evidence = toAnswerEvidence(hits);
  console.log(`Evidence: ${evidence.records.length} records, ${evidence.hints.length} hints\n`);

  const answer = await answerQuestion(client, question, evidence, config);

  console.log(`Mode: ${answer.mode}`);
  // not-found carries an empty answer string by contract; say it plainly.
  console.log(answer.mode === 'not-found' ? "I don't know." : answer.answer);
  // Render citations from the final answer, not from raw retrieval hits:
  // retrieved neighbors are candidates, but citations are the evidence.
  // Web UIs should follow the same rule — see README §4.
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
