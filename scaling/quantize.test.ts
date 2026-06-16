// Offline, deterministic tests for the int8 demo's mechanism. No corpus, no
// key: the quantizer and the gate are exercised on fixture vectors, so the
// whole int8 path — including the int4 route flip the demo is built to catch —
// is provable here. The real corpus instantiates this same mechanism; these
// tests prove the mechanism itself.

import assert from 'node:assert/strict';
import test from 'node:test';

import { cosine } from '../src/retrieve.js';
import type { ArchiveRecord, IndexEntry, PrivateNote } from '../src/types.js';
import type { GoldQuery } from '../src/evaluate.js';
import { dequantize, levelFor, quantize, requantizeVector } from './quantize.js';
import { evaluateQuery, rankCorrelation, requantizeIndex, runGate, spearmanRho, topSource } from './harness.js';

// A near-tie found by deterministic search (scaling: seed 421, 24-dim): the
// query Q ranks note VN just above record VR at full precision; int8 preserves
// that order, int4 reorders it. This is the route flip in miniature.
const Q = [-0.201545, -0.070296, -0.836567, -0.496486, 0.932744, -0.183835, 0.620633, -0.319135, 0.353699, 0.535227, 0.630447, -0.913022, 0.74482, 0.20067, -0.735437, 0.48168, -0.628687, 0.422013, -0.824056, 0.95873, -0.055049, -0.014708, 0.136552, -0.126328];
const VN = [-0.209326, -0.367113, -0.781625, -0.22665, 0.421356, -0.779461, 0.686374, -0.431379, 0.807734, 0.556436, 0.078187, -1.104108, 0.064971, -0.250693, -0.829483, -0.06284, -0.225568, 0.419642, -0.941748, 0.05885, -0.260352, 0.396049, -0.299235, 0.33248];
const VR = [0.153577, 0.081729, -1.05474, -0.793276, 0.049555, -0.0844, 0.769011, 0.098334, 0.570278, -0.166597, 0.599978, -1.115543, 0.517046, -0.496545, 0.207507, 0.785012, -0.899066, 0.109867, -0.881006, 0.360131, 0.467909, 0.04772, 0.550953, 0.232781];

function makeRecord(id: string, extra: Partial<ArchiveRecord> = {}): ArchiveRecord {
  return {
    id,
    type: 'work',
    slug: id.split(':')[1] ?? id,
    title: extra.title ?? id,
    url: `https://smith-collection.example/${id}/`,
    summary: extra.summary ?? '',
    body: extra.body ?? '',
    themes: extra.themes ?? [],
  };
}

function makeNote(id: string): PrivateNote {
  return { id, label: id, url: 'https://en.wikipedia.org/wiki/George_Adam_Smith', locator: 'sermon', text: 'private' };
}

function recordEntry(id: string, vector: number[], extra: Partial<ArchiveRecord> = {}): IndexEntry {
  return { model: 'text-embedding-3-large', dimensions: vector.length, vector, contentHash: 'h', sourceType: 'record', record: makeRecord(id, extra) };
}

function noteEntry(id: string, vector: number[]): IndexEntry {
  return { model: 'text-embedding-3-large', dimensions: vector.length, vector, contentHash: 'h', sourceType: 'note', note: makeNote(id) };
}

// Two fillers near-orthogonal to Q, so they stay below the floor in every
// precision and never enter the route contest.
const filler1 = Array.from({ length: 24 }, (_, i) => (i === 1 ? 1 : 0));
const filler2 = Array.from({ length: 24 }, (_, i) => (i === 21 ? 1 : 0));

test('quantize: level widths and rejection of bad bit counts', () => {
  assert.equal(levelFor(8), 127);
  assert.equal(levelFor(4), 7);
  assert.throws(() => levelFor(1));
  assert.throws(() => levelFor(9));
  assert.throws(() => levelFor(3.5));
});

test('quantize: round-trips within the per-vector scale, zero vector is safe', () => {
  const v = [0.5, -0.25, 0.9, -0.9, 0.1];
  const q = quantize(v, 8);
  const back = dequantize(q);
  for (let i = 0; i < v.length; i += 1) {
    assert.ok(Math.abs(back[i]! - v[i]!) <= q.scale, `component ${i} within one scale step`);
  }
  // scale derives from the max magnitude (0.9), one signed byte (127 levels).
  assert.ok(Math.abs(q.scale - 0.9 / 127) < 1e-9);

  const zero = quantize([0, 0, 0], 8);
  assert.equal(zero.scale, 1);
  assert.deepEqual([...zero.codes], [0, 0, 0]);
});

test('quantize: int4 is coarser than int8 (larger reconstruction error)', () => {
  const v = Q;
  const err = (bits: number) => v.reduce((s, x, i) => s + Math.abs(requantizeVector(v, bits)[i]! - x), 0);
  assert.ok(err(4) > err(8), 'int4 reconstruction error exceeds int8');
});

test('quantize: per-vector scale cancels under cosine (exact, by algebra)', () => {
  // Scaling a vector by any positive constant leaves cosine unchanged, which is
  // why the per-vector scale need not be restored to rank. The demo leans on this.
  const scaled = VN.map((x) => x * 7.5);
  assert.ok(Math.abs(cosine(Q, VN) - cosine(Q, scaled)) < 1e-12);
});

test('harness: spearmanRho on known orderings, with ties', () => {
  assert.equal(spearmanRho([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearmanRho([1, 2, 3, 4], [40, 30, 20, 10]), -1);
  assert.ok(Math.abs(spearmanRho([1, 2, 2, 3], [1, 2, 2, 3]) - 1) < 1e-12); // ties -> average ranks
  assert.equal(spearmanRho([5], [9]), 1); // degenerate length < 2
});

test('harness: requantizeIndex keeps every field but the vector', () => {
  const index = [recordEntry('work:a', VR), noteEntry('note:b', VN)];
  const q = requantizeIndex(index, 8);
  assert.equal(q.length, 2);
  assert.equal(q[0]!.sourceType, 'record');
  assert.equal(q[0]!.dimensions, 24);
  assert.notDeepEqual(q[0]!.vector, index[0]!.vector); // lossy
  assert.equal(q[0]!.contentHash, index[0]!.contentHash); // untouched
});

test('harness: topSource picks the highest score across both streams', () => {
  const result = {
    records: [{ record: makeRecord('work:r'), score: 0.71, semantic: 0.71 }],
    notes: [{ note: makeNote('note:n'), score: 0.73, semantic: 0.73 }],
  };
  assert.equal(topSource(result)?.id, 'note:n');
  assert.equal(topSource(result)?.kind, 'note');
  assert.equal(topSource({ records: [], notes: [] }), null);
});

test('harness: int8 preserves the FP ranking better than int4 (rank correlation)', () => {
  const index = [noteEntry('note:n', VN), recordEntry('work:r', VR), recordEntry('work:f1', filler1), recordEntry('work:f2', filler2)];
  const rho8 = rankCorrelation(index, requantizeIndex(index, 8), Q);
  const rho4 = rankCorrelation(index, requantizeIndex(index, 4), Q);
  assert.ok(rho8 >= rho4, `int8 rho (${rho8}) >= int4 rho (${rho4})`);
  assert.ok(rho8 >= rho4 && rho8 > 0.9, 'int8 holds the ordering tightly');
});

test('the payload: the gate certifies int8 and rejects int4 on the route case', () => {
  // The note (VN) must win the top slot; that is the route. A query with no
  // title/theme overlap, so the contest is pure cosine, not boosts.
  const index: IndexEntry[] = [
    noteEntry('note:syn-amos-justice-margin', VN),
    recordEntry('george-adam-smith:twelve-prophets-amos', VR, { title: 'unrelated phrasing' }),
    recordEntry('work:f1', filler1),
  ];
  const gold: GoldQuery = {
    id: 'route-margin',
    query: 'zzz qqq no token overlap with any title or theme',
    expectAnswerMode: 'related-material',
    expectSources: ['note:syn-amos-justice-margin'],
  };
  const qById = new Map([[gold.id, Q]]);

  // int8: the note wins the top slot, the gate passes.
  const int8 = runGate([gold], index, qById, 8);
  assert.equal(int8.passed, 1, 'int8 certifies the route');
  assert.equal(int8.results[0]!.route?.won, true);
  assert.ok(int8.results[0]!.rho >= 0.9);

  // int4: the record overtakes the note for the top slot. The note is still
  // retrieved (so judgeRetrieval alone would miss it), but the route flipped,
  // and the gate catches it.
  const int4 = runGate([gold], index, qById, 4);
  assert.equal(int4.failed, 1, 'int4 is rejected');
  const r = int4.results[0]!;
  assert.equal(r.retrievalPass, true, 'the note is still in the candidate set');
  assert.equal(r.route?.won, false, 'but it lost the top slot');
  assert.equal(r.route?.winner, 'george-adam-smith:twelve-prophets-amos');
});

test('the payload, directly: cosine ordering flips between int8 and int4', () => {
  const c = (v: number[], bits: number) => cosine(Q, requantizeVector(v, bits));
  assert.ok(cosine(Q, VN) > cosine(Q, VR), 'FP: note outranks record');
  assert.ok(c(VN, 8) > c(VR, 8), 'int8: note still outranks record');
  assert.ok(c(VR, 4) > c(VN, 4), 'int4: record overtakes the note (the flip)');
});

test('evaluateQuery: a refuse case with nothing above the floor stays not-found', () => {
  const index = [recordEntry('work:f1', filler1), recordEntry('work:f2', filler2)];
  const gold: GoldQuery = { id: 'refuse', query: 'zzz qqq', expectAnswerMode: 'not-found', forbidSources: ['work:f1', 'work:f2'] };
  const res = evaluateQuery(gold, index, requantizeIndex(index, 8), Q);
  assert.equal(res.pass, true, 'fillers stay below the floor, so nothing is forbidden-surfaced');
});
