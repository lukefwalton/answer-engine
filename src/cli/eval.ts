// npm run eval — run the gold set against the live index.
//
// Default: retrieval floor only (one batched embedding call — cheap).
// --full: answer engine per query (expensive). Prefer --ids or --from-report
// so you do not re-synthesize every query while fixing one failure.
// See eval/README.md.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import OpenAI from 'openai';

import { config } from '../../archive.config.js';
import { answerQuestion } from '../answer.js';
import { batchInputs, embedBatch } from '../embedding.js';
import { EVAL_USAGE, filterGoldQueries, parseQueryIdList } from '../eval-select.js';
import { judgeAnswer, judgeRetrieval, loadGold, parseEvalReport, summarizeEvalReport } from '../evaluate.js';
import type { EvalQueryResult } from '../evaluate.js';
import { assembleEvidence } from '../no-leak.js';
import { retrieve } from '../retrieve.js';
import { assertHomogeneousIndex, readIndexFile } from '../store.js';

const GOLD_PATH = resolve('eval/gold.yaml');
const EVAL_REPORT_DIR = resolve('artifacts/eval');

function loadFailedIdsFromReport(reportPath: string): string[] {
  if (!existsSync(reportPath)) {
    throw new Error(`eval report not found: ${reportPath}`);
  }
  const report = parseEvalReport(JSON.parse(readFileSync(reportPath, 'utf8')) as unknown, reportPath);
  if (report.aborted) {
    throw new Error(
      `eval report was aborted by --fail-fast: ${reportPath}. ` +
        `Use --ids for the intended subset or rerun the report without --fail-fast.`,
    );
  }
  return report.results.filter((r) => !r.pass).map((r) => r.id);
}

function resolveLatestEvalReport(evalDir: string): string {
  if (!existsSync(evalDir)) {
    throw new Error(`eval report directory not found: ${evalDir}`);
  }
  const files = readdirSync(evalDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(evalDir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (files.length === 0) {
    throw new Error(`no eval reports in ${evalDir}; run npm run eval first`);
  }
  return files[0]!;
}

interface EvalArgs {
  full: boolean;
  list: boolean;
  failFast: boolean;
  ids?: string[];
  fromReport?: string;
  reportPath?: string;
}

function parseArgs(argv: string[]): EvalArgs {
  const args: EvalArgs = { full: false, list: false, failFast: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        console.log(EVAL_USAGE.trimEnd());
        process.exit(0);
        break;
      case '--list':
        args.list = true;
        break;
      case '--full':
        args.full = true;
        break;
      case '--fail-fast':
        args.failFast = true;
        break;
      case '--ids': {
        const value = argv[++i];
        if (!value) throw new Error('--ids requires a comma-separated list (e.g. q07)');
        args.ids = parseQueryIdList(value);
        break;
      }
      case '--from-report': {
        const value = argv[++i];
        if (!value) throw new Error('--from-report requires a path or "latest"');
        args.fromReport = value;
        break;
      }
      case '--report': {
        const value = argv[++i];
        if (!value) throw new Error('--report requires a path');
        args.reportPath = value;
        break;
      }
      default:
        throw new Error(`Unknown argument '${arg ?? ''}'\n\n${EVAL_USAGE}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const allGold = loadGold(GOLD_PATH, config.authorName);

  let fromReportIds: string[] | undefined;
  if (args.fromReport) {
    const reportPath =
      args.fromReport === 'latest'
        ? resolveLatestEvalReport(EVAL_REPORT_DIR)
        : resolve(args.fromReport);
    fromReportIds = loadFailedIdsFromReport(reportPath);
    if (fromReportIds.length === 0) {
      console.log(`All queries passed in ${reportPath}; nothing to rerun.`);
      process.exit(0);
    }
    console.log(`Rerunning ${fromReportIds.length} failure(s) from ${reportPath}`);
  }

  const gold = filterGoldQueries(allGold, {
    ids: args.ids,
    fromReportIds,
  });

  if (gold.length === 0) {
    console.error('No queries to run (check --ids / --from-report).');
    process.exit(1);
  }

  if (args.list) {
    for (const g of gold) {
      console.log(`${g.id}  ${g.query}`);
    }
    console.log(`\n${gold.length} quer${gold.length === 1 ? 'y' : 'ies'} selected.`);
    process.exit(0);
  }

  const filterBits = [
    args.ids?.length ? `ids=${args.ids.join(',')}` : '',
    args.fromReport ? 'from-report' : '',
  ].filter(Boolean);
  console.log(
    `Eval — ${gold.length} of ${allGold.length} queries` +
      (filterBits.length ? ` (${filterBits.join(', ')})` : '') +
      (args.full ? ' [full: retrieval + answer — $$$]' : ' [retrieval only]'),
  );

  if (args.full && gold.length > 3 && !args.ids?.length && !args.fromReport) {
    console.warn(
      `\nWarning: --full on ${gold.length} queries runs the answer engine for each one. ` +
        `Prefer: npm run eval, then npm run eval -- --full --from-report latest\n`,
    );
  }

  const index = readIndexFile();
  if (index.length === 0) throw new Error('Index is empty. Run `npm run index` first.');
  assertHomogeneousIndex(index);

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set. Put it in .env or the environment.');
  }
  const client = new OpenAI();

  const spec = index[0]!;
  const vectorById = new Map<string, number[]>();
  for (const batch of batchInputs(gold.map((g) => ({ id: g.id, text: g.query })))) {
    const results = await embedBatch(client, batch, {
      model: spec.model,
      dimensions: spec.dimensions,
    });
    for (const r of results) vectorById.set(r.id, r.vector);
  }

  const ranAt = new Date().toISOString();
  const reportPath = args.reportPath ?? join(EVAL_REPORT_DIR, `${ranAt.replace(/[:.]/g, '-')}.json`);
  mkdirSync(dirname(reportPath), { recursive: true });

  const results: EvalQueryResult[] = [];
  let failures = 0;
  let aborted = false;

  for (const g of gold) {
    const vector = vectorById.get(g.id);
    if (!vector) {
      throw new Error(`embedding missing for query '${g.id}'`);
    }
    const hits = retrieve(vector, g.query, index);

    const issues = [...judgeRetrieval(g, hits).issues];
    if (args.full) {
      try {
        const evidence = assembleEvidence(
          hits.records.map((h) => h.record),
          hits.notes.map((h) => h.note),
        );
        const answer = await answerQuestion(client, g.query, evidence, config);
        issues.push(...judgeAnswer(g, answer).issues);
      } catch (err) {
        issues.push(`answer engine threw: ${err instanceof Error ? err.message : err}`);
      }
    }

    const pass = issues.length === 0;
    results.push({ id: g.id, query: g.query, pass, issues });

    if (pass) {
      console.log(`  ok   ${g.id}  ${g.query}`);
    } else {
      failures += 1;
      console.log(`  FAIL ${g.id}  ${g.query}`);
      for (const issue of issues) console.log(`       - ${issue}`);
      if (g.note) console.log(`       note: ${g.note.trim()}`);
      if (args.failFast) {
        aborted = true;
        break;
      }
    }
  }

  const report = summarizeEvalReport(results, {
    ranAt,
    full: args.full,
    selectedTotal: gold.length,
    aborted,
  });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(
    `\n${report.passed}/${report.total} passed` +
      (args.full ? ' (retrieval + answer)' : ' (retrieval only; use --full to check answers)'),
  );
  console.log(`report: ${reportPath}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`eval failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
