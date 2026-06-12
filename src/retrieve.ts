// Retrieval: brute-force cosine over the index, plus two hard boosts — a query
// that names a record's title or slug outranks a merely-similar record, and a
// query that uses one of a record's curated themes verbatim gets credit for
// the curation. Hits below the score floor are dropped so weak matches can't
// masquerade as evidence; an empty result is what lets the engine say "I
// don't know."
//
// The result keeps records and private notes in two separate lists. That's
// the privacy boundary showing up as an API shape: notes must pass through
// no-leak.ts before anything reaches the answer model.

import type { ArchiveRecord, IndexEntry, PrivateNote } from './types.js';

/** Additive boost when the query names the record. Conservative on purpose:
 *  enough to beat a close semantic neighbor, not enough to drown relevance. */
export const EXACT_MATCH_BOOST = 0.3;

/** Additive boost when the query contains one of the record's themes verbatim.
 *  Themes are curated frontmatter — metadata you maintain earns retrieval
 *  gravity that raw prose similarity can't claim. */
export const THEME_BOOST = 0.15;

/** Hits scoring below this are not evidence. Tune against your own corpus. */
export const SCORE_FLOOR = 0.2;

export interface ScoredRecord {
  record: ArchiveRecord;
  score: number;
  semantic: number;
}

export interface ScoredNote {
  note: PrivateNote;
  score: number;
  semantic: number;
}

export interface RetrievalResult {
  records: ScoredRecord[];
  notes: ScoredNote[];
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: dimension mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Whole-token phrase match, so 'now' never matches inside 'snow'. */
export function containsPhrase(query: string, phrase: string): boolean {
  const needle = normalize(phrase);
  if (!needle) return false;
  return ` ${normalize(query)} `.includes(` ${needle} `);
}

export function hasExactMatch(record: ArchiveRecord, query: string): boolean {
  return containsPhrase(query, record.title) || containsPhrase(query, record.slug);
}

export function hasThemeMatch(record: ArchiveRecord, query: string): boolean {
  return record.themes.some((theme) => containsPhrase(query, theme));
}

export function retrieve(
  queryVector: readonly number[],
  query: string,
  index: readonly IndexEntry[],
  options: { topK?: number; scoreFloor?: number } = {},
): RetrievalResult {
  // topK is PER STREAM: up to topK records and topK notes. The two streams
  // serve different roles downstream, so one shouldn't crowd out the other.
  const topK = options.topK ?? 8;
  const floor = options.scoreFloor ?? SCORE_FLOOR;

  const records: ScoredRecord[] = [];
  const notes: ScoredNote[] = [];
  for (const entry of index) {
    const semantic = cosine(queryVector, entry.vector);
    if (entry.sourceType === 'record') {
      const boost =
        (hasExactMatch(entry.record, query) ? EXACT_MATCH_BOOST : 0) +
        (hasThemeMatch(entry.record, query) ? THEME_BOOST : 0);
      records.push({ record: entry.record, semantic, score: semantic + boost });
    } else {
      // Notes carry no curated frontmatter; the match is on what the private
      // text says, so semantic similarity is the whole score.
      notes.push({ note: entry.note, semantic, score: semantic });
    }
  }

  const top = <T extends { score: number }>(hits: T[]): T[] =>
    hits.filter((h) => h.score >= floor).sort((a, b) => b.score - a.score).slice(0, topK);

  return { records: top(records), notes: top(notes) };
}
