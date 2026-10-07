// The committed book layer, when it has been built (build-handoff.md §6):
// one public-domain novel as a private entity, one fragment per chapter,
// every chapter served as a gist, the served view stripped, the canaries
// clean. Skipped, not failed, until the keyed build has run.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

import { loadGoldFile, sweepCanaries } from '../src/evaluate.js';
import { readIndex, toServedIndex, validateServedIndex } from '../src/store.js';

const BOOK = 'demo/corpus/index.book.json';
const GOLD = 'demo/gold.book.yaml';
const ENTITY = 'book:the-wonderful-wizard-of-oz';
const CHAPTERS = 24;

const skip = existsSync(BOOK) ? false : `${BOOK} is not built yet (build-handoff.md §6)`;

test('committed book layer: one private entity, one fragment per chapter, every chapter served as a gist', { skip }, () => {
  const file = readIndex(BOOK);
  assert.deepEqual(file.entities.map((e) => e.id), [ENTITY]);
  const entity = file.entities[0]!;
  assert.deepEqual(entity.disclosure, { raw: 'private', exposure: 'semantic' });
  assert.equal(entity.policy?.publicTitle, true);
  assert.ok(entity.attribution.some((a) => a.name === 'L. Frank Baum'));

  const chapters = file.entries.map((e) => e.fragment.locator);
  assert.equal(chapters.length, CHAPTERS, `the novel has ${CHAPTERS} chapters; a sub-split chapter means maxFragmentChars was too low`);
  assert.deepEqual(
    chapters.map((l) => l.map((x) => `${x.scheme}:${x.value}`).join('.')).sort(),
    Array.from({ length: CHAPTERS }, (_, i) => `chapter:${i + 1}`).sort(),
  );
  for (const entry of file.entries) {
    assert.deepEqual(
      entry.fragment.disclosure,
      { raw: 'private', exposure: 'semantic' },
      `${entry.fragment.id} is not served as a gist: edit its draft in demo/corpus/projections.json and rebuild`,
    );
  }
});

test('committed book layer: the served view carries gists and provenance, never the text; the sweep is clean', { skip }, () => {
  const file = readIndex(BOOK);
  const served = validateServedIndex(toServedIndex(file), `${BOOK} (served view)`);
  const serialized = JSON.stringify(served);
  for (const entry of file.entries) {
    // The first sentence of every chapter is absent from the served view.
    const opening = entry.fragment.text.split('\n\n').pop()!.slice(0, 60);
    assert.ok(!serialized.includes(opening), `${entry.fragment.id}: chapter text reached the served view`);
  }
  const { canaries } = loadGoldFile(GOLD, 'Smith Collection');
  assert.ok(canaries.length >= 3, 'the book gold carries canaries');
  const sweep = sweepCanaries(served, canaries);
  assert.deepEqual(sweep.issues, []);
  assert.equal(sweep.gists, CHAPTERS);
});
