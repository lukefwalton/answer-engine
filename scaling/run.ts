// npm run scaling:run — quantize the committed index in process, re-rank, and
// run the full gold suite against the quantized index.
//
//   --natural             (default) real corpus only; owns the headline numbers.
//   --natural+synthetic   adds the quarantined synthetic spire + its gold.
//   --bits <n>            quantization width (default 8; 4 is the int4 scalpel).
//   --full                also run the answer-mode pass (needs OPENAI_API_KEY).
//
// The headline run is keyless: it reads committed FP vectors and committed
// gold-query vectors, quantizes in process, and judges with the reused gold
// logic. --full adds the answer model, which is the only part that needs a key.
// See scaling/README.md and docs/scaling-demo/build-handoff.md.

import { resolve } from 'node:path';

import { loadGold } from '../src/evaluate.js';
import type { GoldQuery } from '../src/evaluate.js';
import { assertHomogeneousIndex, readIndexFile } from '../src/store.js';
import type { IndexEntry } from '../src/types.js';
import { runGate } from './harness.js';
import { readQueryVectors } from './query-vectors.js';

const NATURAL_INDEX = resolve('scaling/corpus/index.json');
const SYNTHETIC_INDEX = resolve('scaling/corpus/index.synthetic.json');
const NATURAL_GOLD = resolve('scaling/gold.yaml');
const SYNTHETIC_GOLD = resolve('scaling/gold.synthetic.yaml');

interface RunArgs {
  synthetic: boolean;
  bits: number;
  full: boolean;
}

function parseArgs(argv: string[]): RunArgs {
  const args: RunArgs = { synthetic: false, bits: 8, full: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--natural':
        args.synthetic = false;
        break;
      case '--natural+synthetic':
      case '--synthetic':
        args.synthetic = true;
        break;
      case '--full':
        args.full = true;
        break;
      case '--bits': {
        const value = argv[++i];
        if (!value) throw new Error('--bits requires a number (e.g. 8 or 4)');
        args.bits = Number(value);
        if (!Number.isInteger(args.bits)) throw new Error(`--bits must be an integer, got '${value}'`);
        break;
      }
      case '--help':
      case '-h':
        console.log(
          'scaling:run [--natural | --natural+synthetic] [--bits <n>] [--full]\n' +
            '  --natural             real corpus only (default); owns the headline numbers\n' +
            '  --natural+synthetic   add the quarantined synthetic spire + its gold\n' +
            '  --bits <n>            quantization width (default 8; 4 is the int4 scalpel)\n' +
            '  --full                also run the answer-mode pass (needs OPENAI_API_KEY)',
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument '${arg ?? ''}'`);
    }
  }
  return args;
}

function loadIndex(synthetic: boolean): IndexEntry[] {
  const natural = readIndexFile(NATURAL_INDEX);
  if (natural.length === 0) {
    throw new Error(
      `no committed vectors at ${NATURAL_INDEX}. ` +
        'Run `npm run scaling:build` with an OPENAI_API_KEY (see docs/scaling-demo/build-handoff.md).',
    );
  }
  if (!synthetic) {
    assertHomogeneousIndex(natural);
    return natural;
  }
  const spire = readIndexFile(SYNTHETIC_INDEX);
  if (spire.length === 0) {
    throw new Error(
      `--natural+synthetic needs the spire at ${SYNTHETIC_INDEX}, which is not built yet ` +
        '(author the synthetic notes, then `npm run scaling:build`).',
    );
  }
  const union = [...natural, ...spire];
  // The spire is strictly baseline-plus-delta: same model, same dimensionality.
  assertHomogeneousIndex(union);
  return union;
}

function loadGoldSet(synthetic: boolean, author: string): GoldQuery[] {
  const gold = loadGold(NATURAL_GOLD, author);
  if (!synthetic) return gold;
  const expanded = loadGold(SYNTHETIC_GOLD, author);
  return [...gold, ...expanded];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { config } = await import('./scaling.config.js');

  const index = loadIndex(args.synthetic);
  const gold = loadGoldSet(args.synthetic, config.authorName);

  const qv = readQueryVectors();
  if (!qv) {
    throw new Error(
      'no committed query vectors. Run `npm run scaling:build` with an OPENAI_API_KEY ' +
        '(see docs/scaling-demo/build-handoff.md).',
    );
  }
  const spec = index[0]!;
  if (qv.model !== spec.model || qv.dimensions !== spec.dimensions) {
    throw new Error(
      `query vectors (${qv.model}/${qv.dimensions}) do not match the index ` +
        `(${spec.model}/${spec.dimensions}); rebuild both with scaling:build.`,
    );
  }

  const label = args.synthetic ? '--natural+synthetic' : '--natural';
  console.log(`scaling:run ${label}  int${args.bits}  ${gold.length} gold queries  ${index.length} index entries`);
  if (args.synthetic) {
    console.log('  (headline numbers come from the --natural run; the spire is broken out below)');
  }

  const report = runGate(gold, index, qv.byId, args.bits);

  for (const r of report.results) {
    const status = r.pass ? 'ok  ' : 'FAIL';
    const routeBit = r.route ? `  route:${r.route.won ? 'won' : `LOST->${r.route.winner ?? 'none'}`}` : '';
    console.log(`  ${status} ${r.id.padEnd(18)} rho=${r.rho.toFixed(4)}${routeBit}`);
    if (!r.pass) for (const issue of r.retrievalIssues) console.log(`       - ${issue}`);
    if (r.route && !r.route.won) {
      console.log(`       - route flipped: expected ${r.route.expectedNote} to win the top slot`);
    }
  }

  console.log(
    `\nint${args.bits}: ${report.passed}/${report.total} gold passed; ` +
      `rank correlation mean ${report.meanRho.toFixed(4)}, min ${report.minRho.toFixed(4)}`,
  );

  if (args.full) {
    await runAnswerPass(gold, index, qv.byId, config);
  } else {
    console.log('(retrieval + route tier only; add --full to run the answer-mode pass with a key)');
  }

  if (report.failed > 0) process.exitCode = 1;
}

/** The keyed bonus: run the answer model and check the declared mode. Exercises
 *  route SELECTION through the reused no-leak boundary; it does not touch A2
 *  (the answer model's confabulation residue), which the encoding never moves. */
async function runAnswerPass(
  gold: readonly GoldQuery[],
  index: readonly IndexEntry[],
  queryVectorById: ReadonlyMap<string, number[]>,
  config: import('../src/types.js').ArchiveConfig,
): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('--full runs the answer model, which needs OPENAI_API_KEY.');
  }
  const [{ default: OpenAI }, { retrieve }, { assembleEvidence }, { answerQuestion }, { judgeAnswer }] =
    await Promise.all([
      import('openai'),
      import('../src/retrieve.js'),
      import('../src/no-leak.js'),
      import('../src/answer.js'),
      import('../src/evaluate.js'),
    ]);
  const client = new OpenAI();
  console.log('\n--full answer-mode pass (keyed):');
  let answerFails = 0;
  for (const g of gold) {
    const qv = queryVectorById.get(g.id);
    if (!qv) continue;
    const hits = retrieve(qv, g.query, index);
    const evidence = assembleEvidence(
      hits.records.map((h) => h.record),
      hits.notes.map((h) => h.note),
    );
    try {
      const answer = await answerQuestion(client, g.query, evidence, config);
      const judged = judgeAnswer(g, answer);
      console.log(`  ${judged.pass ? 'ok  ' : 'FAIL'} ${g.id.padEnd(18)} mode=${answer.mode}`);
      if (!judged.pass) {
        answerFails += 1;
        for (const issue of judged.issues) console.log(`       - ${issue}`);
      }
    } catch (err) {
      answerFails += 1;
      console.log(`  FAIL ${g.id.padEnd(18)} answer engine threw: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (answerFails > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`scaling:run failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
