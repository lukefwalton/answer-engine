import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadGold } from '../src/evaluate.js';
import { readIndexFile } from '../src/store.js';
import { readQueryVectors } from './query-vectors.js';

const EXPECTED_NATURAL_SOURCES = [
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
  const natural = readIndexFile('demo/corpus/index.json');
  const actual = natural
    .map((entry) => (entry.sourceType === 'record' ? entry.record.id : entry.note.id))
    .sort();
  assert.deepEqual(
    actual,
    EXPECTED_NATURAL_SOURCES,
    `committed demo index source ids changed; update the public-domain provenance and allowlist deliberately\n` +
      `actual: ${actual.join(', ')}`,
  );

  const synthetic = readIndexFile('demo/corpus/index.synthetic.json');
  assert.deepEqual(
    synthetic.map((entry) => (entry.sourceType === 'note' ? entry.note.id : entry.record.id)),
    ['note:syn-amos-justice-margin'],
    'committed synthetic spire changed; keep it to the single flagged near-tie unless the demo is recalibrated',
  );
});

test('committed demo query vectors match the gold suite ids', () => {
  const gold = [
    ...loadGold('demo/gold.yaml', 'Smith Collection'),
    ...loadGold('demo/gold.synthetic.yaml', 'Smith Collection'),
  ];
  const queryVectors = readQueryVectors('demo/corpus/query-vectors.json');
  assert.ok(queryVectors);

  assert.deepEqual([...queryVectors.byId.keys()].sort(), gold.map((g) => g.id).sort());
});
