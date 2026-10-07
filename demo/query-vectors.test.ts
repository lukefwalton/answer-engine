// Offline tests for the committed gold-query vector store: a clean round-trip,
// a missing file reading as "not built yet" (null), and malformed artifacts
// failing loudly at read with the rebuild hint rather than later as bad cosine.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { queryContentHash, QUERY_VECTORS_VERSION, readQueryVectors, writeQueryVectors } from './query-vectors.js';

const tmp = mkdtempSync(join(tmpdir(), 'scaling-qv-'));
const HASH = queryContentHash('What did Adam Smith argue about justice?');

test('query-vectors: write/read round-trips with model, dimensions, and the text hash per entry', () => {
  const path = join(tmp, 'ok.json');
  writeQueryVectors('text-embedding-3-large', 3, [{ id: 'a', vector: [0.1, 0.2, 0.3], contentHash: HASH }], path);
  const loaded = readQueryVectors(path);
  assert.ok(loaded);
  assert.equal(loaded.model, 'text-embedding-3-large');
  assert.equal(loaded.dimensions, 3);
  assert.deepEqual(loaded.byId.get('a'), [0.1, 0.2, 0.3]);
  assert.equal(loaded.hashes.get('a'), HASH);
  // The hash is of the exact text: an edit under the same id no longer matches.
  assert.match(HASH, /^[0-9a-f]{16}$/);
  assert.equal(queryContentHash('What did Adam Smith argue about justice?'), HASH);
  assert.notEqual(queryContentHash('What did Adam Smith argue about beneficence?'), HASH);
});

test('query-vectors: a missing file reads as null (not built yet), not an error', () => {
  assert.equal(readQueryVectors(join(tmp, 'absent.json')), null);
});

test('query-vectors: malformed entries fail loudly at read', () => {
  const wrongDims = join(tmp, 'dims.json');
  writeFileSync(
    wrongDims,
    JSON.stringify({ version: QUERY_VECTORS_VERSION, model: 'm', dimensions: 3, queries: [{ id: 'a', vector: [0.1, 0.2], contentHash: HASH }] }),
  );
  assert.throws(() => readQueryVectors(wrongDims), /malformed entry for 'a'/);

  const nonNumeric = join(tmp, 'nan.json');
  writeFileSync(
    nonNumeric,
    JSON.stringify({ version: QUERY_VECTORS_VERSION, model: 'm', dimensions: 2, queries: [{ id: 'b', vector: [0.1, 'x'], contentHash: HASH }] }),
  );
  assert.throws(() => readQueryVectors(nonNumeric), /malformed entry for 'b'/);

  // A vector with no text hash, or a malformed one, cannot be checked against
  // the gold text and is refused the same way.
  const noHash = join(tmp, 'nohash.json');
  writeFileSync(noHash, JSON.stringify({ version: QUERY_VECTORS_VERSION, model: 'm', dimensions: 2, queries: [{ id: 'c', vector: [0.1, 0.2] }] }));
  assert.throws(() => readQueryVectors(noHash), /malformed entry for 'c'/);
  const badHash = join(tmp, 'badhash.json');
  writeFileSync(badHash, JSON.stringify({ version: QUERY_VECTORS_VERSION, model: 'm', dimensions: 2, queries: [{ id: 'd', vector: [0.1, 0.2], contentHash: 'not-hex' }] }));
  assert.throws(() => readQueryVectors(badHash), /malformed entry for 'd'/);

  // A version-1 file (no hashes) is refused with the rebuild hint; the one-off
  // scripts/stamp-query-vectors.ts is how the committed file crossed over.
  const versionOne = join(tmp, 'v1.json');
  writeFileSync(versionOne, JSON.stringify({ version: 1, model: 'm', dimensions: 2, queries: [{ id: 'e', vector: [0.1, 0.2] }] }));
  assert.throws(() => readQueryVectors(versionOne), /schema version 2/);

  const badVersion = join(tmp, 'ver.json');
  writeFileSync(badVersion, JSON.stringify({ version: 999, model: 'm', dimensions: 2, queries: [] }));
  assert.throws(() => readQueryVectors(badVersion), /schema version/);
});
