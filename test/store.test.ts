// Offline tests for the schema-4 store, the teaching adapters, the embed-string
// rule, the served projection, and the v3 → v4 migration. No key, no network.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
import { locatorKey } from '../src/locator.js';
import { assertPublicSafeField, assertSemanticProjection } from '../src/public-safe.js';
import {
  indexFileFromLegacyEntries,
  INDEX_SCHEMA_VERSION,
  legacyEntriesFromIndexFile,
  migrateV3ToV4,
  readIndex,
  readIndexFile,
  readServedIndex,
  toServedIndex,
  validateIndex,
  validateServedIndex,
  writeIndex,
  writeIndexFile,
  writeServedIndex,
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

// ─── The load-time lint over authored private metadata ───────────────────────

const NOTE_BODY = 'The bridge originally modulated up a whole step and we scrapped it in the second session.';

/** A private note as the adapter writes it: the entity title is the label; the
 *  fragment text is the private title, a blank line, the body. */
function privateNoteIndex(
  overrides: {
    title?: string;
    privateTitle?: string;
    locatorValue?: string;
    version?: string;
    creator?: string;
  } = {},
): IndexFile {
  const title = overrides.title ?? 'Harbor Lights session';
  const privateTitle = overrides.privateTitle ?? 'Harbor Lights — writing session';
  const entity: Entity = {
    id: 'note:harbor-lights-session',
    type: 'note',
    title,
    attribution: overrides.creator !== undefined ? [{ name: overrides.creator }] : [],
    ...(overrides.version !== undefined ? { version: overrides.version } : {}),
    url: 'https://example.com/lyrics/harbor-lights/',
    identifiers: [],
    disclosure: { raw: 'private', exposure: 'locator' },
  };
  const locator = [{ scheme: 'note', value: overrides.locatorValue ?? 'notebook, p. 12' }];
  const fragment: Fragment = {
    id: `${entity.id}#${locatorKey(locator)}`,
    entityId: entity.id,
    locator,
    text: `${privateTitle}\n\n${NOTE_BODY}`,
    disclosure: { raw: 'private', exposure: 'locator' },
  };
  return { version: INDEX_SCHEMA_VERSION, entities: [entity], entries: [{ ...vec([1, 0]), fragment }] };
}

test('store: a private index is linted at load for authored strings that quote its text', () => {
  // The honest shape passes.
  assert.equal(validateIndex(privateNoteIndex()).entities.length, 1);

  // A title that repeats the fragment's heading paragraph is the author
  // publishing the title, not a quotation of the body: the shipped demo note
  // "Private Amos marginalia on divine justice" is six words and sits as the
  // first paragraph of its own text.
  const heading = 'Private Amos marginalia on divine justice';
  assert.equal(validateIndex(privateNoteIndex({ title: heading, privateTitle: heading })).entities.length, 1);

  // A title that quotes five words of the body is caught, naming the field and the run.
  assert.throws(
    () => validateIndex(privateNoteIndex({ title: 'Originally modulated up a whole step' }), 'artifacts/index.json'),
    /index at artifacts\/index\.json: entity 'note:harbor-lights-session': 'title' quotes private text \("originally modulated up a whole"\)/,
  );
  // So is a locator value; the note scheme is echoed verbatim into locatorLabel.
  assert.throws(
    () => validateIndex(privateNoteIndex({ locatorValue: 'see: we scrapped it in the second session' })),
    /fragment 'note:harbor-lights-session#[^']*': 'locator value \(note\)' quotes private text/,
  );
  // And a version, a creator name: every authored string a hit carries.
  assert.throws(() => validateIndex(privateNoteIndex({ version: 'draft\ntwo' })), /'version' must be a single line/);
  assert.throws(
    () => validateIndex(privateNoteIndex({ creator: 'scrapped it in the second session' })),
    /'creator name' quotes private text/,
  );
  // The private title is private text too: a label that lifts a run from it
  // without being it is a quotation, not a pointer.
  assert.throws(
    () =>
      validateIndex(
        privateNoteIndex({
          title: 'Harbor Lights — the night we almost quit (session)',
          privateTitle: 'Harbor Lights — the night we almost quit',
        }),
      ),
    /'title' quotes private text/,
  );

  // A public entity's metadata is public by construction and is not checked.
  const r = record({ title: 'Listening means suspending the verdict', body: 'Listening means suspending the verdict.' });
  const pub = fromArchiveRecord(r);
  const publicFile: IndexFile = {
    version: INDEX_SCHEMA_VERSION,
    entities: [pub.entity],
    entries: [{ ...vec([1, 0]), fragment: pub.fragment }],
  };
  assert.equal(validateIndex(publicFile).entities.length, 1);
});

test('store: an index that would be refused at load is refused at write, and the legacy view never casts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ae-store-lint-'));
  const path = join(dir, 'index.json');
  const bad = privateNoteIndex({ title: 'Originally modulated up a whole step' });

  // writeIndex validates first and leaves nothing behind.
  assert.throws(() => writeIndex(bad, path), /'title' quotes private text/);
  assert.equal(existsSync(path), false);

  // A hand edit on disk fails at the next load, before any consumer sees it.
  writeFileSync(path, JSON.stringify(bad), 'utf8');
  assert.throws(() => readIndex(path), /'title' quotes private text/);
  assert.throws(() => readIndexFile(path), /'title' quotes private text/);

  // The transitional view re-lints instead of rebranding a stored string.
  const [entity] = bad.entities;
  const [entry] = bad.entries;
  assert.throws(() => toPrivateNote(entity!, entry!.fragment), /'label' quotes private text/);
  assert.throws(() => legacyEntriesFromIndexFile(bad), /'label' quotes private text/);
  const good = privateNoteIndex();
  assert.equal(toPrivateNote(good.entities[0]!, good.entries[0]!.fragment).label, 'Harbor Lights session');

  // writeServedIndex runs the served validator the same way.
  const served = toServedIndex(privateBook());
  const servedPath = join(dir, 'served.json');
  writeServedIndex(served, servedPath);
  assert.equal(readServedIndex(servedPath).entries.length, 2);
  const unstripped = { ...served, entries: [{ ...served.entries[0]!, fragment: { ...served.entries[0]!.fragment, text: 'leak' } }] };
  assert.throws(() => writeServedIndex(unstripped as typeof served, servedPath), /still carries text/);
});

test('migrate:index fails with the remedy, not a stack trace, and migrates a v3 file once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ae-migrate-'));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'scripts/migrate-index-v3-v4.ts', ...args], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });

  const missing = run(join(dir, 'nope.json'));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /migrate:index failed: index at .*nope\.json does not exist\. Pass the path/);
  assert.ok(!/at .*\.ts:\d+/.test(missing.stderr), 'no stack trace');

  const junk = join(dir, 'junk.json');
  writeFileSync(junk, 'not json', 'utf8');
  const bad = run(junk);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /is not valid JSON\. Restore it from version control, or rebuild it/);

  const v3 = join(dir, 'v3.json');
  const entries: IndexEntry[] = [
    { ...vec([1, 0]), sourceType: 'record', record: record() },
    { ...vec([0, 1]), sourceType: 'note', note: note() },
  ];
  writeFileSync(v3, JSON.stringify({ version: 3, entries }), 'utf8');
  const migrated = run(v3);
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.match(migrated.stdout, /migrated to schema version 4 \(2 entities, 2 fragments; vectors and hashes untouched\)/);
  assert.deepEqual(readIndexFile(v3), entries);
  const again = run(v3);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already schema version 4; nothing to do/);
});
