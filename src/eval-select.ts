// Targeted eval selection — filter gold queries and load failure ids from reports.
// Pure functions (except report IO). Prefer retrieval on a subset before --full.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalReport, GoldQuery } from './evaluate.js';

export interface EvalQueryFilters {
  ids?: readonly string[];
  fromReportIds?: readonly string[];
}

export function parseQueryIdList(raw: string): string[] {
  return [...new Set(raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean))];
}

export function filterGoldQueries(
  queries: readonly GoldQuery[],
  filters: EvalQueryFilters,
): GoldQuery[] {
  let out = [...queries];

  if (filters.ids?.length) {
    const want = new Set(filters.ids);
    out = out.filter((q) => want.has(q.id));
    const missing = filters.ids.filter((id) => !queries.some((q) => q.id === id));
    if (missing.length > 0) {
      throw new Error(`unknown gold query id(s): ${missing.join(', ')}`);
    }
  }
  if (filters.fromReportIds?.length) {
    const want = new Set(filters.fromReportIds);
    out = out.filter((q) => want.has(q.id));
  }

  return out;
}

function isEvalReport(value: unknown): value is EvalReport {
  if (typeof value !== 'object' || value === null) return false;
  return Array.isArray((value as EvalReport).results);
}

export function loadFailedIdsFromReport(reportPath: string): string[] {
  if (!existsSync(reportPath)) {
    throw new Error(`eval report not found: ${reportPath}`);
  }
  const doc = JSON.parse(readFileSync(reportPath, 'utf8')) as unknown;
  if (!isEvalReport(doc)) {
    throw new Error(`not a valid eval report (missing results[]): ${reportPath}`);
  }
  return doc.results.filter((r) => !r.pass).map((r) => r.id);
}

export function resolveLatestEvalReport(evalDir: string): string {
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

export const EVAL_USAGE = `Usage: npm run eval [-- flags]

  Default: retrieval floor only (one batched embedding call — cheap).
  --full: also runs the answer engine per query (OpenAI synthesis — expensive).

Target a subset (prefer this over re-running the full set):
  --ids q07              one query
  --ids q06,q07          comma-separated ids
  --from-report PATH     rerun only failures from a prior report JSON
  --from-report latest   rerun failures from the newest artifacts/eval/*.json

Other flags:
  --fail-fast            stop on first failure
  --report PATH          write report JSON (default: artifacts/eval/<timestamp>.json)
  --list                 print selected queries and exit (no API calls)

Workflow after changing gold or engine code:
  1. npm run eval                          # full retrieval floor
  2. npm run eval -- --from-report latest  # only failures, still retrieval-only
  3. npm run eval -- --full --ids q07      # answer engine ONLY on fixed ids
`;
