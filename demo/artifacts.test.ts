import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

import { embedStringFor } from '../src/embed-string.js';
import { loadGold } from '../src/evaluate.js';
import { readIndex } from '../src/store.js';
import { contentHash } from './build-lib.js';
import { queryContentHash, readQueryVectors } from './query-vectors.js';

const NATURAL = 'demo/corpus/index.json';
const SYNTHETIC = 'demo/corpus/index.synthetic.json';
const BOOK = 'demo/corpus/index.book.json';
const AUTHOR = 'Smith Collection';

const EXPECTED_NATURAL_ENTITIES = [
  'adam-smith:theory-of-moral-sentiments-justice',
  'adam-smith:theory-of-moral-sentiments-sympathy',
  'adam-smith:wealth-of-nations-division-of-labour',
  'adam-smith:wealth-of-nations-value',
  'george-adam-smith:isaiah-prophet-of-faith',
  'george-adam-smith:twelve-prophets-amos',
  'george-adam-smith:twelve-prophets-hosea',
  'george-adam-smith:twelve-prophets-micah',
  'note:forgiveness-of-sins',
  'note:temptation',
  'note:word-of-god',
].sort();

test('committed demo index matches the public-domain source allowlist', () => {
  const natural = readIndex(NATURAL);
  const entities = natural.entities.map((e) => e.id).sort();
  assert.deepEqual(
    entities,
    EXPECTED_NATURAL_ENTITIES,
    `committed demo index entities changed; update the public-domain provenance and allowlist deliberately\n` +
      `actual: ${entities.join(', ')}`,
  );
  // Whole records and whole sermons: one fragment per entity, nothing split.
  assert.deepEqual(natural.entries.map((e) => e.fragment.entityId).sort(), EXPECTED_NATURAL_ENTITIES);

  const synthetic = readIndex(SYNTHETIC);
  assert.deepEqual(
    synthetic.entities.map((e) => e.id),
    ['note:syn-amos-justice-margin'],
    'committed synthetic spire changed; keep it to the single flagged near-tie unless the demo is recalibrated',
  );
  assert.deepEqual(synthetic.entries.map((e) => e.fragment.entityId), ['note:syn-amos-justice-margin']);
});

test('committed demo hashes match the current embed-string derivation', () => {
  // The committed vectors were embedded from label+body at v2 and carried
  // through the schema-3 and schema-4 migrations without re-embedding. This
  // pins that invariant: the embed string the adapters produce today
  // (src/embed-string.ts) must reproduce the exact bytes those hashes were
  // taken over, so drift in an adapter or the derivation fails here,
  // keylessly, not at re-embed time. The book layer, when built, is held to
  // the same rule.
  const layers = [NATURAL, SYNTHETIC, ...(existsSync(BOOK) ? [BOOK] : [])];
  for (const path of layers) {
    const file = readIndex(path);
    const entities = new Map(file.entities.map((e) => [e.id, e]));
    for (const entry of file.entries) {
      const entity = entities.get(entry.fragment.entityId);
      assert.ok(entity, `fragment '${entry.fragment.id}' names an unknown entity in ${path}`);
      assert.equal(
        entry.contentHash,
        contentHash(embedStringFor(entry.fragment, entity)),
        `contentHash drift for '${entry.fragment.id}' in ${path}`,
      );
    }
  }
});

test('committed demo query vectors match the gold suite ids', () => {
  const gold = [
    ...loadGold('demo/gold.yaml', AUTHOR),
    ...loadGold('demo/gold.synthetic.yaml', AUTHOR),
    ...(existsSync(BOOK) ? loadGold('demo/gold.book.yaml', AUTHOR) : []),
  ];
  const queryVectors = readQueryVectors('demo/corpus/query-vectors.json');
  assert.ok(queryVectors);

  assert.deepEqual([...queryVectors.byId.keys()].sort(), gold.map((g) => g.id).sort());
  // And each vector is the embedding of the query text in tree: an edit to a
  // gold query under the same id fails here, keylessly, until demo:build
  // re-embeds it (demo:run refuses the same way).
  for (const g of gold) {
    assert.equal(queryVectors.hashes.get(g.id), queryContentHash(g.query), `query vector for '${g.id}' was embedded from other text`);
  }
});
