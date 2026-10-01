// demo/harness.ts — the int8 gate, as pure logic the CLI drives.
//
// Reuses the core retrieval (src/retrieve.ts) and the gold judge
// (src/evaluate.ts) untouched: the int8 path is an encode/decode wrapper plus a
// re-rank, never a second pipeline. Given a full-precision retrieval index and
// a quantization bit width, it builds the lossy index, re-ranks each gold query
// against it, and reports two things: rank correlation against the
// full-precision ranking (a diagnostic for how much the ranking moved), and the
// gold suite's verdicts including refuse and route (the adjudicator). Rank
// correlation gates nothing here — it is a retrieval benchmark; the gold suite
// decides.

import type { ScoredHit } from '../src/contract.js';
import { judgeRetrieval } from '../src/evaluate.js';
import type { GoldQuery } from '../src/evaluate.js';
import { cosine, retrieve } from '../src/retrieve.js';
import type { RetrievalIndex } from '../src/retrieve.js';
import { requantizeVector } from './quantize.js';

/** The lossy index the demo re-ranks against: every vector round-tripped
 *  through `bits`-bit quantization, every other field untouched. The
 *  full-precision index stays the source of truth. */
export function requantizeIndex(index: RetrievalIndex, bits: number): RetrievalIndex {
  return {
    ...index,
    entries: index.entries.map((e) => ({ fragment: e.fragment, vector: requantizeVector([...e.vector], bits) })),
  };
}

/** The single highest-scoring hit across both layers, or null if nothing
 *  cleared the floor. Route selection lives here: in related-material mode the
 *  winner must be the private note, or the answer would resolve to a record
 *  instead and the verdict has flipped. */
export function topSource(
  hits: readonly ScoredHit[],
): { id: string; fragmentId: string; raw: 'public' | 'private'; score: number } | null {
  let best: ScoredHit | null = null;
  for (const h of hits) {
    if (!best || h.score > best.score) best = h;
  }
  return best
    ? { id: best.entity.id, fragmentId: best.fragment.id, raw: best.fragment.disclosure.raw, score: best.score }
    : null;
}

function averageRanks(xs: readonly number[]): number[] {
  const order = xs.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
  const ranks = new Array<number>(xs.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.x === order[i]!.x) j += 1;
    const avg = (i + j) / 2 + 1; // 1-based average rank across the tie block i..j
    for (let k = i; k <= j; k += 1) ranks[order[k]!.i] = avg;
    i = j + 1;
  }
  return ranks;
}

/** Spearman's rho: Pearson correlation of the rank vectors, with average ranks
 *  for ties. Returns 1 for degenerate inputs (length < 2 or all-tied), which is
 *  the harmless reading — no reordering to detect. */
export function spearmanRho(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error('spearmanRho: length mismatch');
  const n = a.length;
  if (n < 2) return 1;
  const ra = averageRanks(a);
  const rb = averageRanks(b);
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i += 1) {
    ma += ra[i]!;
    mb += rb[i]!;
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    const x = ra[i]! - ma;
    const y = rb[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return 1;
  return num / Math.sqrt(da * db);
}

/** Rank correlation between the full-precision and quantized cosine orderings
 *  for one query, over the whole index. The boosts are identical in both
 *  rankings, so the only thing that can reorder is the vector part: cosine. */
export function rankCorrelation(
  index: RetrievalIndex,
  quantIndex: RetrievalIndex,
  queryVector: readonly number[],
): number {
  const fp = index.entries.map((e) => cosine(queryVector, e.vector));
  const q = quantIndex.entries.map((e) => cosine(queryVector, e.vector));
  return spearmanRho(fp, q);
}

export interface QueryGateResult {
  id: string;
  /** Rank correlation FP vs quantized for this query. */
  rho: number;
  /** judgeRetrieval on the quantized index: expected sources in, forbidden out. */
  retrievalPass: boolean;
  retrievalIssues: string[];
  /** For any case that names an expected source and is not a refusal: did that
   *  source win the top slot on the quantized index? This is what protects the
   *  *verdict*, not just presence. judgeRetrieval only checks membership, so a
   *  quantization flip that keeps both Smiths retrieved but swaps which one
   *  ranks first would pass it silently. The top-slot check catches that: the
   *  expected record must OUTRANK the competing Smith (disambiguation), and the
   *  private note must win over the public records (route). An expected id may
   *  name the entity or the fragment. */
  topSlot?: { expected: string; winner: string | null; won: boolean };
  /** retrievalPass AND (topSlot ? topSlot.won : true). */
  pass: boolean;
}

/** Re-rank one gold query against the quantized index and judge it. */
export function evaluateQuery(
  gold: GoldQuery,
  index: RetrievalIndex,
  quantIndex: RetrievalIndex,
  queryVector: readonly number[],
): QueryGateResult {
  const hits = retrieve(queryVector, gold.query, quantIndex);
  const judged = judgeRetrieval(gold, hits);
  const rho = rankCorrelation(index, quantIndex, queryVector);

  // Any non-refusal case with a named expected source must see that source win
  // the top slot, not merely appear. Refusals (not-found) carry no expected
  // source; the floor and forbidSources adjudicate them via judgeRetrieval.
  let topSlot: QueryGateResult['topSlot'];
  if (gold.expectAnswerMode !== 'not-found') {
    if (gold.expectSources?.length !== 1) {
      throw new Error(
        `demo gold '${gold.id}': a non-refusal case must list exactly one expectSources ` +
          `entry (the required top-slot winner); got ${gold.expectSources?.length ?? 0}.`,
      );
    }
    const expected = gold.expectSources[0]!;
    const winner = topSource(hits);
    const won = winner !== null && (winner.id === expected || winner.fragmentId === expected);
    topSlot = { expected, winner: winner?.id ?? null, won };
  }

  const pass = judged.pass && (topSlot ? topSlot.won : true);
  return {
    id: gold.id,
    rho,
    retrievalPass: judged.pass,
    retrievalIssues: judged.issues,
    ...(topSlot ? { topSlot } : {}),
    pass,
  };
}

export interface GateReport {
  bits: number;
  total: number;
  passed: number;
  failed: number;
  meanRho: number;
  minRho: number;
  results: QueryGateResult[];
}

/** Run the whole gold suite against the index at `bits` precision. */
export function runGate(
  gold: readonly GoldQuery[],
  index: RetrievalIndex,
  queryVectorById: ReadonlyMap<string, number[]>,
  bits: number,
): GateReport {
  const quantIndex = requantizeIndex(index, bits);
  const results: QueryGateResult[] = [];
  for (const g of gold) {
    const qv = queryVectorById.get(g.id);
    if (!qv) throw new Error(`no query vector for gold id '${g.id}' (rebuild demo:build?)`);
    results.push(evaluateQuery(g, index, quantIndex, qv));
  }
  const passed = results.filter((r) => r.pass).length;
  const rhos = results.map((r) => r.rho);
  const meanRho = rhos.length ? rhos.reduce((s, x) => s + x, 0) / rhos.length : 1;
  const minRho = rhos.length ? Math.min(...rhos) : 1;
  return {
    bits,
    total: results.length,
    passed,
    failed: results.length - passed,
    meanRho,
    minRho,
    results,
  };
}
