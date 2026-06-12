import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  filterGoldQueries,
  loadFailedIdsFromReport,
  parseQueryIdList,
} from '../src/eval-select.js';
import type { GoldQuery } from '../src/evaluate.js';

const SAMPLE: GoldQuery[] = [
  {
    id: 'q06',
    query: 'staying',
    expectAnswerMode: 'partial',
    expectSources: ['song:harbor-lights'],
  },
  {
    id: 'q07',
    query: 'bridge',
    expectAnswerMode: 'related-material',
    expectSources: ['note:harbor-lights-session'],
  },
];

test('parseQueryIdList splits comma and whitespace', () => {
  assert.deepEqual(parseQueryIdList('q06, q07'), ['q06', 'q07']);
  assert.deepEqual(parseQueryIdList('q06 q06'), ['q06']);
});

test('filterGoldQueries selects by id and rejects unknown ids', () => {
  assert.equal(filterGoldQueries(SAMPLE, { ids: ['q07'] }).length, 1);
  assert.throws(() => filterGoldQueries(SAMPLE, { ids: ['q99'] }), /unknown gold query id/);
});

test('loadFailedIdsFromReport reads failing ids', () => {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'eval-report-failures.json');
  assert.deepEqual(loadFailedIdsFromReport(fixture), ['q06']);
});
