// Offline tests for the committed gold-query vector store: a clean round-trip,
// a missing file reading as "not built yet" (null), and malformed artifacts
// failing loudly at read with the rebuild hint rather than later as bad cosine.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { QUERY_VECTORS_VERSION, readQueryVectors, writeQueryVectors } from './query-vectors.js';

const tmp = mkdtempSync(join(tmpdir(), 'scaling-qv-'));

test('query-vectors: write/read round-trips with model and dimensions', () => {
  const path = join(tmp, 'ok.json');
  writeQueryVectors('text-embedding-3-large', 3, [{ id: 'a', vector: [0.1, 0.2, 0.3] }], path);
  const loaded = readQueryVectors(path);
  assert.ok(loaded);
  assert.equal(loaded.model, 'text-embedding-3-large');
  assert.equal(loaded.dimensions, 3);
  assert.deepEqual(loaded.byId.get('a'), [0.1, 0.2, 0.3]);
});

test('query-vectors: a missing file reads as null (not built yet), not an error', () => {
  assert.equal(readQueryVectors(join(tmp, 'absent.json')), null);
});

test('query-vectors: malformed entries fail loudly at read', () => {
  const wrongDims = join(tmp, 'dims.json');
  writeFileSync(
    wrongDims,
    JSON.stringify({ version: QUERY_VECTORS_VERSION, model: 'm', dimensions: 3, queries: [{ id: 'a', vector: [0.1, 0.2] }] }),
  );
  assert.throws(() => readQueryVectors(wrongDims), /malformed entry for 'a'/);

  const nonNumeric = join(tmp, 'nan.json');
  writeFileSync(
    nonNumeric,
    JSON.stringify({ version: QUERY_VECTORS_VERSION, model: 'm', dimensions: 2, queries: [{ id: 'b', vector: [0.1, 'x'] }] }),
  );
  assert.throws(() => readQueryVectors(nonNumeric), /malformed entry for 'b'/);

  const badVersion = join(tmp, 'ver.json');
  writeFileSync(badVersion, JSON.stringify({ version: 999, model: 'm', dimensions: 2, queries: [] }));
  assert.throws(() => readQueryVectors(badVersion), /schema version/);
});
