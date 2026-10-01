// The wire contract (docs/CONTRACT.md §8): the policy copy in code is the
// policy copy in the document, and toSearchResponse crosses every hit through
// project() with the counts a retrieval-only consumer reports.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { Entity, Fragment } from '../src/contract.js';
import { buildRetrievalIndex, retrieveWithCounts } from '../src/retrieve.js';
import { INDEX_SCHEMA_VERSION, type IndexFile } from '../src/store.js';
import { ARCHIVE_SEARCH_CONTRACT, ARCHIVE_SEARCH_POLICY, toSearchResponse } from '../src/wire.js';

test('wire: the policy copy in code is the normative copy in CONTRACT.md §8', () => {
  const doc = readFileSync('docs/CONTRACT.md', 'utf8');
  const section = doc.slice(doc.indexOf('## 8. The wire contract'), doc.indexOf('## 9. '));
  const block = /The fixed copy, normative:\s*```json\s*([\s\S]*?)```/.exec(section);
  assert.ok(block, 'CONTRACT.md §8 carries the fixed copy as a json block');
  assert.deepEqual(JSON.parse(block![1]!), ARCHIVE_SEARCH_POLICY);
  assert.equal(ARCHIVE_SEARCH_CONTRACT, 'archive-search/1');
});

test('wire: toSearchResponse projects every hit and reports counts, never the embedding spec', () => {
  const pub: Entity = {
    id: 'song:x',
    type: 'song',
    title: 'X',
    attribution: [],
    url: 'https://example.com/songs/x/',
    identifiers: [{ scheme: 'isrc', value: 'QZ000000001' }],
    disclosure: { raw: 'public', exposure: 'text' },
  };
  const priv: Entity = {
    id: 'transcript:ep',
    type: 'transcript',
    title: 'Ep',
    attribution: [],
    url: 'https://example.com/ep/',
    identifiers: [],
    parent: 'episode:ep',
    disclosure: { raw: 'private', exposure: 'locator' },
  };
  const f1: Fragment = {
    id: 'song:x#whole',
    entityId: pub.id,
    locator: [{ scheme: 'whole', value: '' }],
    text: 'public words',
    disclosure: pub.disclosure,
  };
  const f2: Fragment = {
    id: 'transcript:ep#t0-10',
    entityId: priv.id,
    locator: [{ scheme: 'timecode', value: '0', end: '10' }],
    text: 'private words that must not travel',
    disclosure: { raw: 'private', exposure: 'locator' },
    attribution: [{ name: 'Other', role: 'speaker', placeholder: 'unnamed' }],
  };
  const file: IndexFile = {
    version: INDEX_SCHEMA_VERSION,
    entities: [pub, priv],
    entries: [f1, f2].map((fragment) => ({ model: 'm', dimensions: 2, vector: [1, 0], contentHash: 'h', fragment })),
  };
  const index = buildRetrievalIndex(file);
  const outcome = retrieveWithCounts([1, 0], 'x', index, { limit: 10, filters: { dateFrom: '2020' }, plugins: [] });
  // Both fragments are undated, so a date bound excludes them and counts them.
  assert.equal(outcome.excludedUndated, 2);
  const empty = toSearchResponse('x', outcome, { builtAt: 't', entityCount: 2, fragmentCount: 2 });
  assert.deepEqual(empty.hits, []);
  assert.equal(empty.excludedUndated, 2);

  const full = toSearchResponse('x', retrieveWithCounts([1, 0], 'x', index, { limit: 10, plugins: [] }), {
    builtAt: 't',
    entityCount: 2,
    fragmentCount: 2,
  });
  assert.equal(full.contract, 'archive-search/1');
  assert.equal(full.matched, 2);
  assert.deepEqual(Object.keys(full.index).sort(), ['builtAt', 'entityCount', 'fragmentCount']);
  assert.equal(full.policy, ARCHIVE_SEARCH_POLICY);
  const serialized = JSON.stringify(full);
  assert.ok(!serialized.includes('private words'));
  assert.ok(!serialized.includes('"model"'));
  const privateHit = full.hits.find((h) => h.raw === 'private')!;
  assert.equal(privateHit.exposure, 'locator');
  assert.equal(privateHit.locatorLabel, '0:00–0:10');
  assert.equal(privateHit.score, 1);
  assert.equal(privateHit.breakdown, undefined);
  const publicHit = full.hits.find((h) => h.raw === 'public')!;
  assert.ok(publicHit.exposure === 'text' && publicHit.text === 'public words');
  assert.deepEqual(publicHit.entity.identifiers, [{ scheme: 'isrc', value: 'QZ000000001' }]);
});
