// npm run eval [-- --full] — run the gold set against the live index.
//
// Default run checks the retrieval floor only (one batched embedding call for
// all queries — cheap). --full also runs the answer engine per query and
// checks the returned mode, which is the real test of "says I don't know."
// Exits non-zero on any failure.

import { resolve } from 'node:path';
import OpenAI from 'openai';

import { config } from '../../archive.config.js';
import { answerQuestion } from '../answer.js';
import { batchInputs, embedBatch } from '../embedding.js';
import { judgeAnswerMode, judgeRetrieval, loadGold } from '../evaluate.js';
import { assembleEvidence } from '../no-leak.js';
import { retrieve } from '../retrieve.js';
import { assertHomogeneousIndex, readIndexFile } from '../store.js';

const GOLD_PATH = resolve('eval/gold.yaml');

async function main(): Promise<void> {
  const full = process.argv.includes('--full');
  const gold = loadGold(GOLD_PATH, config.authorName);

  const index = readIndexFile();
  if (index.length === 0) throw new Error('Index is empty. Run `npm run index` first.');
  assertHomogeneousIndex(index);

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set. Put it in .env or the environment.');
  }
  const client = new OpenAI();

  // Embed all queries through the same batching guardrails the index builder
  // uses, so a gold set big enough to cross a request limit splits cleanly
  // instead of failing the whole run.
  const spec = index[0]!;
  const vectorById = new Map<string, number[]>();
  for (const batch of batchInputs(gold.map((g, i) => ({ id: String(i), text: g.query })))) {
    const results = await embedBatch(client, batch, {
      model: spec.model,
      dimensions: spec.dimensions,
    });
    for (const r of results) vectorById.set(r.id, r.vector);
  }

  let failures = 0;
  for (let i = 0; i < gold.length; i += 1) {
    const g = gold[i]!;
    const hits = retrieve(vectorById.get(String(i))!, g.query, index);

    const issues = [...judgeRetrieval(g, hits).issues];
    if (full) {
      try {
        const evidence = assembleEvidence(
          hits.records.map((h) => h.record),
          hits.notes.map((h) => h.note),
        );
        const answer = await answerQuestion(client, g.query, evidence, config);
        issues.push(...judgeAnswerMode(g, answer.mode).issues);
      } catch (err) {
        issues.push(`answer engine threw: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (issues.length === 0) {
      console.log(`  ok   ${g.query}`);
    } else {
      failures += 1;
      console.log(`  FAIL ${g.query}`);
      for (const issue of issues) console.log(`       - ${issue}`);
      if (g.note) console.log(`       note: ${g.note.trim()}`);
    }
  }

  console.log(
    `\n${gold.length - failures}/${gold.length} passed` +
      (full ? ' (retrieval + answer)' : ' (retrieval only; use --full to check answers)'),
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`eval failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
