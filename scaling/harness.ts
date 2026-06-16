// scaling/harness.ts — the int8 gate, as pure logic the CLI drives.
//
// Reuses the core retrieval (src/retrieve.ts) and the gold judge
// (src/evaluate.ts) untouched: the int8 path is an encode/decode wrapper plus a
// re-rank, never a second pipeline. Given full-precision index entries and a
// quantization bit width, it builds the lossy index, re-ranks each gold query
// against it, and reports the two things the paper distinguishes: rank
// correlation against the full-precision ranking (necessary), and the gold
// suite's verdicts including refuse and route (sufficient). Rank correlation
// alone is a retrieval benchmark; the suite is the actual adjudicator.

import { cosine, retrieve } from '../src/retrieve.js';
import type { RetrievalResult } from '../src/retrieve.js';
import { judgeRetrieval } from '../src/evaluate.js';
import type { GoldQuery } from '../src/evaluate.js';
import type { IndexEntry } from '../src/types.js';
import { requantizeVector } from './quantize.js';

/** The lossy index the demo re-ranks against: every vector round-tripped
 *  through `bits`-bit quantization, every other field untouched. The
 *  full-precision index stays the source of truth. */
export function requantizeIndex(index: readonly IndexEntry[], bits: number): IndexEntry[] {
  return index.map((e) => ({ ...e, vector: requantizeVector(e.vector, bits) }));
}

/** The single highest-scoring source across both streams, or null if nothing
 *  cleared the floor. Route selection lives here: in related-material mode the
 *  winner must be the private note, or the answer would resolve to a record
 *  instead and the verdict has flipped. */
export function topSource(
  result: RetrievalResult,
): { id: string; kind: 'record' | 'note'; score: number } | null {
  let best: { id: string; kind: 'record' | 'note'; score: number } | null = null;
  for (const r of result.records) {
    if (!best || r.score > best.score) best = { id: r.record.id, kind: 'record', score: r.score };
  }
  for (const n of result.notes) {
    if (!best || n.score > best.score) best = { id: n.note.id, kind: 'note', score: n.score };
  }
  return best;
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
 *  for one query, over the whole index. The boosts (src/retrieve.ts) are
 *  identical in both rankings, so the only thing that can reorder is the vector
 *  part: cosine. That is what this measures. */
export function rankCorrelation(
  index: readonly IndexEntry[],
  quantIndex: readonly IndexEntry[],
  queryVector: readonly number[],
): number {
  const fp = index.map((e) => cosine(queryVector, e.vector));
  const q = quantIndex.map((e) => cosine(queryVector, e.vector));
  return spearmanRho(fp, q);
}

export interface QueryGateResult {
  id: string;
  /** Rank correlation FP vs quantized for this query. */
  rho: number;
  /** judgeRetrieval on the quantized index: expected sources in, forbidden out. */
  retrievalPass: boolean;
  retrievalIssues: string[];
  /** Present only for route (related-material) cases: did the expected note win
   *  the top slot on the quantized index? */
  route?: { expectedNote: string; winner: string | null; won: boolean };
  /** retrievalPass AND (route ? route.won : true). */
  pass: boolean;
}

/** Re-rank one gold query against the quantized index and judge it. */
export function evaluateQuery(
  gold: GoldQuery,
  index: readonly IndexEntry[],
  quantIndex: readonly IndexEntry[],
  queryVector: readonly number[],
): QueryGateResult {
  const hits = retrieve(queryVector, gold.query, quantIndex);
  const judged = judgeRetrieval(gold, hits);
  const rho = rankCorrelation(index, quantIndex, queryVector);

  let route: QueryGateResult['route'];
  if (gold.expectAnswerMode === 'related-material' && gold.expectSources && gold.expectSources[0]) {
    const expectedNote = gold.expectSources[0];
    const winner = topSource(hits);
    route = { expectedNote, winner: winner?.id ?? null, won: winner?.id === expectedNote };
  }

  const pass = judged.pass && (route ? route.won : true);
  return {
    id: gold.id,
    rho,
    retrievalPass: judged.pass,
    retrievalIssues: judged.issues,
    ...(route ? { route } : {}),
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
  index: readonly IndexEntry[],
  queryVectorById: ReadonlyMap<string, number[]>,
  bits: number,
): GateReport {
  const quantIndex = requantizeIndex(index, bits);
  const results: QueryGateResult[] = [];
  for (const g of gold) {
    const qv = queryVectorById.get(g.id);
    if (!qv) throw new Error(`no query vector for gold id '${g.id}' (rebuild scaling:build?)`);
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
