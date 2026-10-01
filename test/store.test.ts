// Offline tests for the schema-4 store, the teaching adapters, the embed-string
// rule, the served projection, and the v3 → v4 migration. No key, no network.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { config } from '../archive.config.js';
import {
  fromArchiveRecord,
  fromPrivateNote,
  slugOf,
  toArchiveRecord,
  toPrivateNote,
} from '../src/adapters/teaching.js';
import type { Entity, Fragment } from '../src/contract.js';
import { buildCorpus, buildPrivateNotes, embedText, noteEmbedText } from '../src/corpus.js';
import { embedStringFor } from '../src/embed-string.js';
import { assertPublicSafeField, assertSemanticProjection } from '../src/public-safe.js';
import {
  indexFileFromLegacyEntries,
  INDEX_SCHEMA_VERSION,
  legacyEntriesFromIndexFile,
  migrateV3ToV4,
  readIndex,
  readIndexFile,
  toServedIndex,
  validateIndex,
  validateServedIndex,
  writeIndex,
  writeIndexFile,
  type IndexFile,
} from '../src/store.js';
import type { ArchiveRecord, IndexEntry, PrivateNote } from '../src/types.js';

function record(overrides: Partial<ArchiveRecord> = {}): ArchiveRecord {
  return {
    id: 'essay:on-listening',
    type: 'essay',
    slug: 'on-listening',
    title: 'On Listening',
    url: 'https://example.com/essays/on-listening/',
    summary: 'Attention before opinion.',
    body: 'Listening means suspending the verdict.',
    themes: ['attention'],
    ...overrides,
  };
}

function note(): PrivateNote {
  const text = 'The bridge originally modulated up a whole step.';
  return {
    id: 'note:harbor-lights-session',
    title: 'Harbor Lights — writing session',
    label: assertPublicSafeField('Harbor Lights session', { field: 'label', path: 'n', privateText: text }),
    url: 'https://example.com/lyrics/harbor-lights/',
    locator: assertPublicSafeField('notebook, p. 12', { field: 'locator', path: 'n', privateText: text }),
    text,
  };
}

const vec = (v: number[]) => ({ model: 'test-model', dimensions: v.length, vector: v, contentHash: 'x' });

test('adapters: a record and a note round-trip through entity + fragment losslessly', () => {
  const r = record({ date: '2024-05-01' });
  const { entity, fragment } = fromArchiveRecord(r);
  assert.equal(entity.id, r.id);
  assert.equal(fragment.id, 'essay:on-listening#whole');
  assert.deepEqual(fragment.locator, [{ scheme: 'whole', value: '' }]);
  assert.deepEqual(fragment.disclosure, { raw: 'public', exposure: 'text' });
  assert.deepEqual(toArchiveRecord(entity, fragment), r);
  // A record without a date comes back without a date key (not `date: undefined`).
  const plain = fromArchiveRecord(record());
  assert.deepEqual(toArchiveRecord(plain.entity, plain.fragment), record());
  assert.equal(slugOf('essay:on-listening'), 'on-listening');

  const n = note();
  const priv = fromPrivateNote(n);
  assert.equal(priv.entity.title, 'Harbor Lights session');
  assert.deepEqual(priv.entity.disclosure, { raw: 'private', exposure: 'locator' });
  assert.deepEqual(priv.fragment.locator, [{ scheme: 'note', value: 'notebook, p. 12' }]);
  assert.equal(priv.fragment.id, 'note:harbor-lights-session#notebook-p-12');
  // The private title lives inside the fragment text and nowhere else.
  assert.equal(priv.fragment.text, `${n.title}\n\n${n.text}`);
  assert.ok(!JSON.stringify(priv.entity).includes('writing session'));
  assert.deepEqual(toPrivateNote(priv.entity, priv.fragment), n);
});

test('embed-string: reproduces the 2.x embed bytes for the shipped example corpus', () => {
  for (const r of buildCorpus(config)) {
    const { entity, fragment } = fromArchiveRecord(r);
    assert.equal(embedStringFor(fragment, entity), embedText(r), r.id);
  }
  for (const n of buildPrivateNotes(config)) {
    const { entity, fragment } = fromPrivateNote(n);
    assert.equal(embedStringFor(fragment, entity), noteEmbedText(n), n.id);
  }
});

test('store: legacy entries round-trip through a schema-4 file; v3 and junk fail fast', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ae-store4-'));
  const path = join(dir, 'index.json');
  const entries: IndexEntry[] = [
    { ...vec([1, 0]), sourceType: 'record', record: record() },
    { ...vec([0, 1]), sourceType: 'note', note: note() },
  ];
  writeIndexFile(entries, path);
  const onDisk = JSON.parse(readFileSync(path, 'utf8')) as IndexFile;
  assert.equal(onDisk.version, INDEX_SCHEMA_VERSION);
  assert.equal(onDisk.entities.length, 2);
  assert.deepEqual(readIndexFile(path), entries);
  assert.deepEqual(readIndexFile(join(dir, 'missing.json')), []);

  // A v3 file is refused with the migration remedy, not re-embedding.
  writeFileSync(path, JSON.stringify({ version: 3, entries }), 'utf8');
  assert.throws(() => readIndexFile(path), /schema version 3, not schema version 4.*migrate:index/);
  // Anything else gets the rebuild message.
  writeFileSync(path, JSON.stringify(entries), 'utf8');
  assert.throws(() => readIndexFile(path), /not schema version 4.*npm run index/);
  writeFileSync(path, 'not json', 'utf8');
  assert.throws(() => readIndexFile(path), /not valid JSON/);
  writeFileSync(path, JSON.stringify({ version: 4, entities: [], entries: [{ model: 'm' }] }), 'utf8');
  assert.throws(() => readIndexFile(path), /malformed entry.*npm run index/);
});

function gist(text: string, fragmentText: string) {
  return assertSemanticProjection(text, { path: 't', fragmentText });
}

function privateBook(): IndexFile {
  const entity: Entity = {
    id: 'book:example',
    type: 'book',
    title: 'Example',
    attribution: [{ name: 'A. Author', role: 'author' }],
    url: 'https://example.com/book/',
    identifiers: [],
    disclosure: { raw: 'private', exposure: 'semantic' },
    policy: { requireReview: false },
  };
  const p1Text = 'Chapter one, in which the letter arrives and nobody opens it.';
  const p1: Fragment = {
    id: 'book:example#p1',
    entityId: entity.id,
    locator: [{ scheme: 'page', value: '1' }],
    text: p1Text,
    disclosure: { raw: 'private', exposure: 'semantic' },
    projection: {
      lint: 'passed',
      gist: gist('An unopened letter sits at the centre of the opening.', p1Text),
      source: 'generated',
      review: 'unreviewed',
      contentHash: 'h1',
      model: 'm',
      promptVersion: 'gist/1',
    },
    sourceReview: 'reviewed',
  };
  const p2: Fragment = {
    id: 'book:example#p2',
    entityId: entity.id,
    locator: [{ scheme: 'page', value: '2' }],
    text: 'Page two, private, released as a location only.',
    disclosure: { raw: 'private', exposure: 'locator' },
    summary: 'should be blanked',
  };
  const p3: Fragment = {
    id: 'book:example#p3',
    entityId: entity.id,
    locator: [{ scheme: 'page', value: '3' }],
    text: 'Page three, never served.',
    disclosure: { raw: 'private', exposure: 'none' },
  };
  const ghost: Entity = {
    ...entity,
    id: 'book:ghost',
    title: 'Ghost',
    disclosure: { raw: 'private', exposure: 'none' },
  };
  const g1: Fragment = {
    id: 'book:ghost#p1',
    entityId: ghost.id,
    locator: [{ scheme: 'page', value: '1' }],
    text: 'An entity with nothing served disappears from the served index.',
    disclosure: { raw: 'private', exposure: 'none' },
  };
  return {
    version: INDEX_SCHEMA_VERSION,
    entities: [entity, ghost],
    entries: [p1, p2, p3, g1].map((fragment, i) => ({ ...vec([i, 1]), contentHash: `c${i}`, fragment })),
  };
}

test('store: validateIndex enforces the §12 invariants on a private index', () => {
  const ok = privateBook();
  assert.equal(validateIndex(ok).entries.length, 4);

  const dangling = privateBook();
  dangling.entries[0]!.fragment = { ...dangling.entries[0]!.fragment, entityId: 'book:nowhere' };
  assert.throws(() => validateIndex(dangling), /names unknown entity 'book:nowhere'/);

  const layerChange = privateBook();
  layerChange.entries[1]!.fragment = {
    ...layerChange.entries[1]!.fragment,
    disclosure: { raw: 'public', exposure: 'locator' },
  };
  assert.throws(() => validateIndex(layerChange), /never changes the layer/);

  const illegalCell = privateBook();
  (illegalCell.entries[1]!.fragment as { disclosure: unknown }).disclosure = { raw: 'private', exposure: 'text' };
  assert.throws(() => validateIndex(illegalCell), /malformed entry/);

  const unservable = privateBook();
  unservable.entries[0]!.fragment = {
    ...unservable.entries[0]!.fragment,
    projection: { ...unservable.entries[0]!.fragment.projection!, vetoed: true },
  };
  assert.throws(() => validateIndex(unservable), /'semantic' without a servable gist/);

  const twice = privateBook();
  twice.entities.push(twice.entities[0]!);
  assert.throws(() => validateIndex(twice), /lists entity 'book:example' twice/);
});

test('store: toServedIndex strips what the policy does not release, and the validator checks it', () => {
  const served = toServedIndex(privateBook());
  // The all-none entity and the none fragment are gone.
  assert.deepEqual(served.entities.map((e) => e.id), ['book:example']);
  assert.deepEqual(served.entries.map((e) => e.fragment.id), ['book:example#p1', 'book:example#p2']);
  assert.ok(!('policy' in served.entities[0]!));
  const [semantic, locator] = served.entries.map((e) => e.fragment);
  // Private text never survives; the gist does, with only its four served fields.
  assert.equal(semantic!.text, '');
  assert.deepEqual(semantic!.projection, {
    lint: 'passed',
    gist: 'An unopened letter sits at the centre of the opening.',
    source: 'generated',
    review: 'unreviewed',
  });
  assert.ok(!('sourceReview' in semantic!));
  assert.equal(locator!.text, '');
  assert.equal(locator!.summary, '');
  assert.equal(locator!.projection, undefined);
  for (const entry of served.entries) assert.ok(!('contentHash' in entry));
  const json = JSON.stringify(served);
  assert.ok(!json.includes('nobody opens it'));
  assert.ok(!json.includes('released as a location only'));
  assert.ok(!json.includes('never served'));
  assert.ok(!json.includes('nothing served disappears'));

  // The served validator accepts the projection and rejects tampering.
  assert.equal(validateServedIndex(served).entries.length, 2);
  const leaked = JSON.parse(json) as ServedIndexLike;
  leaked.entries[1]!.fragment.text = 'smuggled';
  assert.throws(() => validateServedIndex(leaked), /still carries text/);
  const withHash = JSON.parse(json) as ServedIndexLike;
  (withHash.entries[0] as Record<string, unknown>).contentHash = 'c0';
  assert.throws(() => validateServedIndex(withHash), /still carries contentHash/);
  const withModel = JSON.parse(json) as ServedIndexLike;
  (withModel.entries[0]!.fragment.projection as Record<string, unknown>).model = 'm';
  assert.throws(() => validateServedIndex(withModel), /projection still carries 'model'/);
  const unmarked = JSON.parse(json) as ServedIndexLike;
  delete (unmarked as Partial<ServedIndexLike>).served;
  assert.throws(() => validateServedIndex(unmarked), /not marked as a served index/);
  // A private index passed as served is refused at the first thing it still carries.
  assert.throws(() => validateServedIndex({ ...privateBook(), served: true }), /still carries policy/);
});

interface ServedIndexLike {
  served?: true;
  entries: Array<{ fragment: { text: string; projection?: Record<string, unknown> } } & Record<string, unknown>>;
}

test('store: the v3 → v4 migration keeps vectors, hashes, and order; refuses other versions', () => {
  const v3 = {
    version: 3,
    entries: [
      { ...vec([0.5, 0.5]), contentHash: 'aaaa', sourceType: 'record', record: record({ date: '2020-01-01' }) },
      { ...vec([0.1, 0.9]), contentHash: 'bbbb', sourceType: 'note', note: note() },
    ],
  };
  const v4 = migrateV3ToV4(v3, 'fixture');
  assert.equal(v4.version, 4);
  assert.deepEqual(v4.entities.map((e) => e.id), ['essay:on-listening', 'note:harbor-lights-session']);
  assert.deepEqual(v4.entries.map((e) => [e.contentHash, e.vector]), [['aaaa', [0.5, 0.5]], ['bbbb', [0.1, 0.9]]]);
  assert.deepEqual(legacyEntriesFromIndexFile(v4), v3.entries);
  assert.deepEqual(indexFileFromLegacyEntries(v3.entries as IndexEntry[]), v4);
  assert.throws(() => migrateV3ToV4({ version: 4, entities: [], entries: [] }), /schema version 4, not 3/);
  assert.throws(() => migrateV3ToV4({ version: 3, entries: [{ sourceType: 'record', record: {} }] }), /malformed v3 entry/);

  // The native read/write pair preserves a private index exactly.
  const dir = mkdtempSync(join(tmpdir(), 'ae-store4-native-'));
  const path = join(dir, 'private.json');
  writeIndex(privateBook(), path);
  assert.deepEqual(readIndex(path), privateBook());
});
