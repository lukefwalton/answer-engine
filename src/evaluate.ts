// The eval harness: load the gold set, judge retrieval and answer behavior.
// Pure logic — the CLI owns the API calls, so all of this is testable offline.
//
// The gold set is what makes the two promises measurable: expected sources
// must surface, forbidden sources must not, and must-refuse questions must
// come back not-found. When a query fails, fix the corpus, the scoring, or
// the prompt — never special-case the question text.

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { RetrievalResult } from './retrieve.js';
import type { AnswerMode, AnswerOutput } from './types.js';

export interface GoldQuery {
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
}

const GOLD_MODES: ReadonlySet<string> = new Set([
  'supported',
  'partial',
  'related-material',
  'not-found',
]);

/** Load the gold set. `{{author}}` in a query resolves to the configured
 *  authorName, so renaming the author never silently detunes the eval. */
export function loadGold(path: string, author = ''): GoldQuery[] {
  const parsed = parse(readFileSync(path, 'utf8')) as { queries?: unknown };
  if (!parsed || !Array.isArray(parsed.queries) || parsed.queries.length === 0) {
    throw new Error(`${path} must contain a non-empty 'queries' list`);
  }
  return parsed.queries.map((q, i): GoldQuery => {
    const item = q as Partial<GoldQuery>;
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
    return item as GoldQuery;
  });
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
  return { pass: issues.length === 0, issues };
}

export interface JudgeResult {
  pass: boolean;
  issues: string[];
}

/** Retrieval floor: expected sources in the hits, forbidden sources out.
 *  Both streams count — a gold id can name a record or a private note. */
export function judgeRetrieval(gold: GoldQuery, hits: RetrievalResult): JudgeResult {
  const hitIds = new Set([
    ...hits.records.map((h) => h.record.id),
    ...hits.notes.map((h) => h.note.id),
  ]);
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
