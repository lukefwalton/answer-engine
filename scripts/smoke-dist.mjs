#!/usr/bin/env node
// npm run test:dist — after `npm run build`, import the package the way a
// consumer does (by name, through `exports`, which Node resolves for a file
// inside the package itself) and check the surface is there and behaves.
// Keyless. This is the only test that touches dist/; `npm test` runs src/.

import assert from 'node:assert/strict';

const root = await import('@lukefwalton/answer-engine');
for (const name of [
  'project',
  'search',
  'retrieve',
  'retrieveWithCounts',
  'buildRetrievalIndex',
  'partitionByRaw',
  'assertSemanticProjection',
  'assertPublicSafeField',
  'assertPublicSafeMetadata',
  'resolveDisclosure',
  'isServableGist',
  'validateIndex',
  'validateServedIndex',
  'toServedIndex',
  'readIndex',
  'readServedIndex',
  'draftProjections',
  'createOpenAIGistDrafter',
  'fragmentByHeadings',
  'fragmentByPageMarkers',
  'renderLocatorLabel',
  'sweepCanaries',
  'judgeRetrieval',
  'toAnswerEvidence',
  'answerQuestion',
  'fromArchiveRecord',
  'fromPrivateNote',
]) {
  assert.equal(typeof root[name], 'function', `missing export: ${name}`);
}
assert.ok(Array.isArray(root.DEFAULT_PLUGINS), 'DEFAULT_PLUGINS');
assert.equal(root.INDEX_SCHEMA_VERSION, 4);

const contract = await import('@lukefwalton/answer-engine/contract');
assert.equal(typeof contract, 'object'); // types only; the module must still resolve
const ingest = await import('@lukefwalton/answer-engine/ingest');
assert.equal(typeof ingest.fragmentByHeadings, 'function');
const evaluate = await import('@lukefwalton/answer-engine/eval');
assert.equal(typeof evaluate.sweepCanaries, 'function');
const noLeak = await import('@lukefwalton/answer-engine/no-leak');
assert.equal(noLeak.project, root.project);
const retrieve = await import('@lukefwalton/answer-engine/retrieve');
assert.equal(retrieve.cosine([1, 0], [1, 0]), 1);

// The boundary, through dist: a private locator hit has no field for its text.
const entity = {
  id: 'note:x',
  type: 'note',
  title: 'A note',
  attribution: [],
  url: 'https://example.com/x/',
  identifiers: [],
  disclosure: { raw: 'private', exposure: 'locator' },
};
const fragment = {
  id: 'note:x#p-1',
  entityId: 'note:x',
  locator: [{ scheme: 'note', value: 'p. 1' }],
  text: 'the private text itself',
  disclosure: { raw: 'private', exposure: 'locator' },
};
const hit = root.project({ fragment, entity, cosine: 0.91, score: 0.91, breakdown: { cosine: 0.91 } });
assert.equal(hit.exposure, 'locator');
assert.equal(hit.raw, 'private');
assert.equal(hit.locatorLabel, 'p. 1');
assert.equal(hit.score, 0.9);
assert.equal(hit.breakdown, undefined);
assert.ok(!JSON.stringify(hit).includes('private text itself'));

console.log('dist smoke: ok');
