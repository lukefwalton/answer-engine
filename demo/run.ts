// npm run demo:run — quantize the committed index in process, re-rank, and
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
// See demo/README.md and docs/scaling-demo/build-handoff.md.

import { resolve } from 'node:path';

import { loadGold } from '../src/evaluate.js';
import type { GoldQuery } from '../src/evaluate.js';
import { assertHomogeneousIndex, readIndexFile } from '../src/store.js';
import type { IndexEntry } from '../src/types.js';
import { requantizeIndex, runGate } from './harness.js';
import { readQueryVectors } from './query-vectors.js';

const NATURAL_INDEX = resolve('demo/corpus/index.json');
const SYNTHETIC_INDEX = resolve('demo/corpus/index.synthetic.json');
const NATURAL_GOLD = resolve('demo/gold.yaml');
const SYNTHETIC_GOLD = resolve('demo/gold.synthetic.yaml');

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
          'demo:run [--natural | --natural+synthetic] [--bits <n>] [--full]\n' +
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
        'Run `npm run demo:build` with an OPENAI_API_KEY (see docs/scaling-demo/build-handoff.md).',
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
        '(author the synthetic notes, then `npm run demo:build`).',
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
  const { config } = await import('./config.js');

  const index = loadIndex(args.synthetic);
  const gold = loadGoldSet(args.synthetic, config.authorName);

  const qv = readQueryVectors();
  if (!qv) {
    throw new Error(
      'no committed query vectors. Run `npm run demo:build` with an OPENAI_API_KEY ' +
        '(see docs/scaling-demo/build-handoff.md).',
    );
  }
  const spec = index[0]!;
  if (qv.model !== spec.model || qv.dimensions !== spec.dimensions) {
    throw new Error(
      `query vectors (${qv.model}/${qv.dimensions}) do not match the index ` +
        `(${spec.model}/${spec.dimensions}); rebuild both with demo:build.`,
    );
  }

  // Say plainly what this run IS, so a reader knows what they are looking at.
  const label = args.synthetic ? '--natural+synthetic' : '--natural';
  const shipped = args.bits === 8;
  console.log('demo:run — int8 quantization gate (Smith collection)');
  console.log(
    `  encoding: int${args.bits}  ` +
      (shipped
        ? '(the shipped wire format; expected to HOLD the suite)'
        : '(tightened below int8; a near-tie may flip and be REJECTED)'),
  );
  console.log(
    `  corpus:   ${label}  ` +
      (args.synthetic
        ? '(real corpus + the fabricated spire; headline still comes from --natural)'
        : '(real corpus only; owns the headline numbers)'),
  );
  console.log(`  ${gold.length} gold queries, ${index.length} index entries, keyless (committed vectors)\n`);

  const report = runGate(gold, index, qv.byId, args.bits);

  for (const r of report.results) {
    const status = r.pass ? 'ok  ' : 'FAIL';
    const slot = r.topSlot ? `  top:${r.topSlot.won ? 'won' : `LOST->${r.topSlot.winner ?? 'none'}`}` : '';
    console.log(`  ${status} ${r.id.padEnd(18)} rho=${r.rho.toFixed(4)}${slot}`);
    if (!r.pass) {
      for (const issue of r.retrievalIssues) console.log(`       - ${issue}`);
      if (r.topSlot && !r.topSlot.won) {
        console.log(`       - top slot flipped: expected ${r.topSlot.expected} to win, ${r.topSlot.winner ?? 'nothing'} did`);
      }
    }
  }

  console.log(
    `\nint${args.bits}: ${report.passed}/${report.total} gold verdicts held; ` +
      `rank correlation mean ${report.meanRho.toFixed(4)}, min ${report.minRho.toFixed(4)}`,
  );
  if (report.failed === 0) {
    console.log(`  VERDICT: the gold suite CERTIFIED int${args.bits} — every verdict full precision produces held.`);
  } else {
    const flips = report.results.filter((r) => r.topSlot && !r.topSlot.won).length;
    console.log(
      `  VERDICT: the gold suite REJECTED int${args.bits} — ${report.failed} verdict(s) did not hold` +
        (flips ? `, including ${flips} top-slot flip(s)` : '') +
        '.',
    );
    console.log('           The same suite that owns grounding and refusal caught it; that caught failure is the payload.');
  }

  if (args.full) {
    // The answer pass must see evidence selected from the SAME quantized index
    // the retrieval gate judged, or a route flip on the lossy index would be
    // masked by full-precision retrieval. Quantize once, here, and hand it down.
    await runAnswerPass(gold, requantizeIndex(index, args.bits), qv.byId, config);
  } else {
    console.log('(retrieval + route tier only; add --full to run the answer-mode pass with a key)');
  }

  if (report.failed > 0) process.exitCode = 1;
}

/** The keyed bonus: run the answer model on evidence retrieved from the
 *  QUANTIZED index, and check the declared mode. Same lossy surface the
 *  retrieval gate judged, so a route flip is not masked by full-precision
 *  retrieval. Exercises route SELECTION through the reused no-leak boundary; it
 *  does not touch A2 (the answer model's confabulation residue), which the
 *  encoding never moves. */
async function runAnswerPass(
  gold: readonly GoldQuery[],
  quantIndex: readonly IndexEntry[],
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
  console.log('\n--full answer-mode pass (keyed, on the quantized index):');
  let answerFails = 0;
  for (const g of gold) {
    const qv = queryVectorById.get(g.id);
    if (!qv) continue;
    const hits = retrieve(qv, g.query, quantIndex);
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
  console.error(`demo:run failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
