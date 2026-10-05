// The eval harness: load the gold set, judge retrieval and answer behavior.
// Pure logic — the CLI owns the API calls, so all of this is testable offline.
//
// The gold set is what makes the two promises measurable: expected sources
// must surface, forbidden sources must not, and must-refuse questions must
// come back not-found. When a query fails, fix the corpus, the scoring, or
// the prompt — never special-case the question text.

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { EvidenceHit, ScoredHit } from './contract.js';
import type { AnswerMode, AnswerOutput } from './types.js';

/** A gold file: the queries, and the leakage canaries swept over every served
 *  gist (docs/CONTRACT.md §11). */
export interface GoldFile {
  queries: GoldQuery[];
  /** Case-insensitive regexes over wording that exists only in private text. */
  canaries: string[];
}

export interface GoldQuery {
  /** Stable id for targeted runs (--ids, --from-report). */
  id: string;
  query: string;
  /** Mode the answer engine must return. Checked by `eval --full`. */
  expectAnswerMode: AnswerMode;
  /** Source ids (records or notes) retrieval must surface. */
  expectSources?: string[];
  /** Source ids retrieval must NOT surface. */
  forbidSources?: string[];
  /** The lesson this query guards; printed when it fails. */
  note?: string;
  /** With --full: answer must not cite public records (boundary queries). */
  forbidRecordCitations?: boolean;
  /** With --full: answer prose must not match these regexes (e.g. raw URLs). */
  forbidAnswerPatterns?: string[];
  /** With --full: answer prose must match EVERY one of these. Pins behavior
   *  shape — a template opener, a locator — never facts: a gold query asserts
   *  how the engine behaves, not what is true (eval/README.md). */
  expectAnswerPatterns?: string[];
}

export interface EvalQueryResult {
  id: string;
  query: string;
  pass: boolean;
  issues: string[];
}

export interface EvalReport {
  ranAt: string;
  full: boolean;
  /** Queries selected for this run (before --fail-fast truncation). */
  selectedTotal: number;
  /** Queries actually executed (results.length). */
  total: number;
  passed: number;
  failed: number;
  /** True when --fail-fast stopped the run early. */
  aborted?: boolean;
  results: EvalQueryResult[];
}

export function summarizeEvalReport(
  results: readonly EvalQueryResult[],
  opts: { ranAt: string; full: boolean; selectedTotal: number; aborted?: boolean },
): EvalReport {
  const passed = results.filter((r) => r.pass).length;
  return {
    ranAt: opts.ranAt,
    full: opts.full,
    selectedTotal: opts.selectedTotal,
    total: results.length,
    passed,
    failed: results.length - passed,
    ...(opts.aborted ? { aborted: true } : {}),
    results: [...results],
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function requireReportNumber(value: unknown, path: string, key: string): number {
  if (typeof value !== 'number') {
    throw new Error(`invalid eval report at ${path}: ${key} must be a number`);
  }
  return value;
}

/** Parse report JSON text, then validate shape. Pure — no filesystem IO. */
export function parseEvalReportJson(text: string, path = 'eval report'): EvalReport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid eval report at ${path}: not valid JSON (${detail})`);
  }
  return parseEvalReport(raw, path);
}

/** Validate a JSON eval report before `--from-report` uses it to select work. */
export function parseEvalReport(raw: unknown, path = 'eval report'): EvalReport {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`invalid eval report at ${path}: expected an object`);
  }
  const report = raw as Partial<EvalReport>;
  if (typeof report.ranAt !== 'string') {
    throw new Error(`invalid eval report at ${path}: ranAt must be a string`);
  }
  if (typeof report.full !== 'boolean') {
    throw new Error(`invalid eval report at ${path}: full must be a boolean`);
  }
  const selectedTotal = requireReportNumber(report.selectedTotal, path, 'selectedTotal');
  const total = requireReportNumber(report.total, path, 'total');
  const passed = requireReportNumber(report.passed, path, 'passed');
  const failed = requireReportNumber(report.failed, path, 'failed');
  if (report.aborted !== undefined && typeof report.aborted !== 'boolean') {
    throw new Error(`invalid eval report at ${path}: aborted must be a boolean when present`);
  }
  if (!Array.isArray(report.results)) {
    throw new Error(`invalid eval report at ${path}: results must be an array`);
  }
  const results = report.results.map((result, i): EvalQueryResult => {
    if (typeof result !== 'object' || result === null) {
      throw new Error(`invalid eval report at ${path}: results[${i}] must be an object`);
    }
    const item = result as Partial<EvalQueryResult>;
    if (typeof item.id !== 'string') {
      throw new Error(`invalid eval report at ${path}: results[${i}].id must be a string`);
    }
    if (typeof item.query !== 'string') {
      throw new Error(`invalid eval report at ${path}: results[${i}].query must be a string`);
    }
    if (typeof item.pass !== 'boolean') {
      throw new Error(`invalid eval report at ${path}: results[${i}].pass must be a boolean`);
    }
    if (!isStringArray(item.issues)) {
      throw new Error(`invalid eval report at ${path}: results[${i}].issues must be a string array`);
    }
    return { id: item.id, query: item.query, pass: item.pass, issues: item.issues };
  });
  const passCount = results.filter((r) => r.pass).length;
  const failCount = results.length - passCount;
  if (total !== results.length) {
    throw new Error(
      `invalid eval report at ${path}: total (${total}) does not match results.length (${results.length})`,
    );
  }
  if (passed !== passCount) {
    throw new Error(
      `invalid eval report at ${path}: passed (${passed}) does not match results (${passCount} passed)`,
    );
  }
  if (failed !== failCount) {
    throw new Error(
      `invalid eval report at ${path}: failed (${failed}) does not match results (${failCount} failed)`,
    );
  }
  if (selectedTotal < total) {
    throw new Error(
      `invalid eval report at ${path}: selectedTotal (${selectedTotal}) is less than total (${total})`,
    );
  }
  const aborted = report.aborted === true;
  if (!aborted && selectedTotal !== total) {
    throw new Error(
      `invalid eval report at ${path}: selectedTotal (${selectedTotal}) must equal total (${total}) when not aborted`,
    );
  }
  return {
    ranAt: report.ranAt,
    full: report.full,
    selectedTotal,
    total,
    passed,
    failed,
    ...(aborted ? { aborted: true } : {}),
    results,
  };
}

const GOLD_MODES: ReadonlySet<string> = new Set([
  'supported',
  'partial',
  'related-material',
  'not-found',
]);

/** Load the gold set's queries. `{{author}}` in a query resolves to the
 *  configured authorName, so renaming the author never silently detunes the eval. */
export function loadGold(path: string, author = ''): GoldQuery[] {
  return loadGoldFile(path, author).queries;
}

/** Load the whole gold file: queries plus the canary list (absent means none). */
export function loadGoldFile(path: string, author = ''): GoldFile {
  const parsed = parse(readFileSync(path, 'utf8')) as { queries?: unknown; canaries?: unknown };
  if (!parsed || !Array.isArray(parsed.queries) || parsed.queries.length === 0) {
    throw new Error(`${path} must contain a non-empty 'queries' list`);
  }
  const canaries: string[] = [];
  if (parsed.canaries !== undefined) {
    if (!Array.isArray(parsed.canaries) || parsed.canaries.some((c) => typeof c !== 'string' || !c.trim())) {
      throw new Error(`${path}: 'canaries' must be a list of non-empty regex strings`);
    }
    // Canaries are private wording. Every message about one names its index in
    // the gold file, never the pattern (.github/STANDARDS.md §4).
    (parsed.canaries as string[]).forEach((pattern, i) => {
      try {
        new RegExp(pattern, 'i');
      } catch {
        throw new Error(`${path}: canaries[${i}] is not a valid regex`);
      }
      canaries.push(pattern);
    });
  }
  const queries = parsed.queries.map((q, i): GoldQuery => {
    const item = q as Partial<GoldQuery>;
    if (typeof item.id !== 'string' || !item.id.trim()) {
      throw new Error(`${path}: queries[${i}] needs a non-empty id`);
    }
    if (typeof item.query !== 'string' || !item.query.trim()) {
      throw new Error(`${path}: queries[${i}] needs a query string`);
    }
    item.query = item.query.replaceAll('{{author}}', author);
    if (typeof item.expectAnswerMode !== 'string' || !GOLD_MODES.has(item.expectAnswerMode)) {
      throw new Error(
        `${path}: queries[${i}] expectAnswerMode must be one of ${[...GOLD_MODES].join(', ')}`,
      );
    }
    for (const key of ['expectSources', 'forbidSources'] as const) {
      const v = item[key];
      if (v !== undefined && (!Array.isArray(v) || v.some((s) => typeof s !== 'string'))) {
        throw new Error(`${path}: queries[${i}].${key} must be a list of source ids`);
      }
    }
    if (item.forbidRecordCitations !== undefined && typeof item.forbidRecordCitations !== 'boolean') {
      throw new Error(`${path}: queries[${i}].forbidRecordCitations must be a boolean`);
    }
    for (const key of ['forbidAnswerPatterns', 'expectAnswerPatterns'] as const) {
      const patterns = item[key];
      if (patterns === undefined) continue;
      if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== 'string')) {
        throw new Error(`${path}: queries[${i}].${key} must be a list of regex strings`);
      }
      patterns.forEach((pattern, j) => {
        try {
          new RegExp(pattern, 'i');
        } catch {
          throw new Error(`${path}: queries[${i}].${key}[${j}] is not a valid regex`);
        }
      });
    }
    return item as GoldQuery;
  });
  const seen = new Set<string>();
  for (const q of queries) {
    if (seen.has(q.id)) throw new Error(`${path}: duplicate gold query id '${q.id}'`);
    seen.add(q.id);
  }
  return { queries, canaries };
}

/** The slice of an index entry the sweep reads; a private or a served index
 *  file satisfies it. */
export interface SweepableEntry {
  fragment: {
    id: string;
    entityId: string;
    disclosure: { exposure: string };
    projection?: { lint: string; gist?: string };
  };
}

export interface CanarySweepResult extends JudgeResult {
  /** Served gists checked. */
  gists: number;
}

/**
 * The canary sweep (docs/CONTRACT.md §11): every canary against every gist a
 * served index would release, not only the gists a gold query retrieves,
 * because a retrieval-only consumer can surface any of them; and, per entity,
 * against the concatenation of its gists, so a phrase that straddles two gists
 * is at least watched. Keyless; runs before the embedding call in `npm run eval`.
 *
 * An issue names the canary by its index in the gold file's `canaries` list
 * and the fragment or entity it tripped on, never the pattern or the gist:
 * the issues are printed by `npm run eval` and land in CI logs, and a canary
 * is private wording by definition.
 */
export function sweepCanaries(index: { entries: readonly SweepableEntry[] }, canaries: readonly string[]): CanarySweepResult {
  const patterns = canaries.map((c, i) => ({ i, regex: new RegExp(c, 'i') }));
  const issues: string[] = [];
  const perEntity = new Map<string, { gists: string[]; tripped: Set<number> }>();
  let gists = 0;
  for (const { fragment } of index.entries) {
    const p = fragment.projection;
    if (fragment.disclosure.exposure !== 'semantic' || !p || p.lint !== 'passed' || typeof p.gist !== 'string') continue;
    gists += 1;
    let entry = perEntity.get(fragment.entityId);
    if (!entry) perEntity.set(fragment.entityId, (entry = { gists: [], tripped: new Set() }));
    entry.gists.push(p.gist);
    for (const { i, regex } of patterns) {
      if (regex.test(p.gist)) {
        issues.push(`canaries[${i}] appears in the served gist of '${fragment.id}'`);
        entry.tripped.add(i);
      }
    }
  }
  for (const [entityId, { gists: list, tripped }] of perEntity) {
    if (list.length < 2) continue;
    const composed = list.join(' ');
    for (const { i, regex } of patterns) {
      if (!tripped.has(i) && regex.test(composed)) {
        issues.push(`canaries[${i}] appears across the served gists of '${entityId}' (composition)`);
      }
    }
  }
  return { pass: issues.length === 0, issues, gists };
}

/** Answer behavior: mode match plus citation guards aligned with mode semantics. */
export function judgeAnswer(gold: GoldQuery, answer: AnswerOutput): JudgeResult {
  const issues = [...judgeAnswerMode(gold, answer.mode).issues];
  const hasRecord = answer.citations.some((c) => c.kind === 'record');
  const hasHint = answer.citations.some((c) => c.kind === 'hint');
  if (gold.forbidRecordCitations && hasRecord) {
    issues.push('answer must not cite public records for this query');
  }
  if (gold.expectAnswerMode === 'partial' && hasHint) {
    issues.push('partial mode requires record-only citations');
  }
  if (gold.expectAnswerMode === 'related-material' && hasRecord) {
    issues.push('related-material mode requires hint-only citations');
  }
  // Patterns are reported by index, never by content: a forbidAnswerPattern is
  // usually a canary, and the issues are printed and kept in the report.
  (gold.forbidAnswerPatterns ?? []).forEach((pattern, i) => {
    if (new RegExp(pattern, 'i').test(answer.answer)) {
      issues.push(`answer matched forbidAnswerPatterns[${i}]`);
    }
  });
  (gold.expectAnswerPatterns ?? []).forEach((pattern, i) => {
    if (!new RegExp(pattern, 'i').test(answer.answer)) {
      issues.push(`answer did not match expectAnswerPatterns[${i}]`);
    }
  });
  return { pass: issues.length === 0, issues };
}

export interface JudgeResult {
  pass: boolean;
  issues: string[];
}

/** Retrieval floor: expected sources in the hits, forbidden sources out.
 *  Both layers count, and a gold id may name an entity (`essay:x`) or a
 *  fragment (`essay:x#s3`). This is where the gold set *checks recall* on
 *  enumerated cases: every expectSources id is a source someone decided must
 *  surface in regression. The relevant source no gold query names is residue
 *  the suite can never reach — it catches what it lists, not the omission it
 *  never thought of. */
export function judgeRetrieval(gold: GoldQuery, hits: readonly (ScoredHit | EvidenceHit)[]): JudgeResult {
  // Either side of the crossing: a ScoredHit (retrieve(), the demo's ranking
  // gate) or an EvidenceHit (search(), what `npm run eval` judges, so a `none`
  // fragment counts as not retrieved exactly as a consumer would see it).
  const hitIds = new Set(hits.flatMap((h) => [h.entity.id, 'fragment' in h ? h.fragment.id : h.fragmentId]));
  const issues: string[] = [];
  for (const id of gold.expectSources ?? []) {
    if (!hitIds.has(id)) issues.push(`expected source '${id}' not retrieved`);
  }
  for (const id of gold.forbidSources ?? []) {
    if (hitIds.has(id)) issues.push(`forbidden source '${id}' was retrieved`);
  }
  return { pass: issues.length === 0, issues };
}

/** Answer behavior: the mode the engine returned vs the mode the gold demands. */
export function judgeAnswerMode(gold: GoldQuery, mode: AnswerMode): JudgeResult {
  if (mode === gold.expectAnswerMode) return { pass: true, issues: [] };
  return {
    pass: false,
    issues: [`answer mode '${mode}' (expected '${gold.expectAnswerMode}')`],
  };
}
