// Offline tests for the fragment retrieval core: filters, date intervals, the
// two cap shapes, recency modes, the disclosure and theme plugins, and the
// crossing's coarse scores. No key, no network.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ALL_BUILTIN_PLUGINS,
  DEFAULT_PLUGINS,
  disclosure,
  discriminatingThemes,
  exactTitleMatch,
  queryIsAboutNow,
  recency,
  recencyFactor,
  themeMatch,
} from '../src/boosts.js';
import type { Entity, Fragment } from '../src/contract.js';
import { intervalsIntersect, parseDateInterval } from '../src/dates.js';
import { project, search } from '../src/no-leak.js';
import { assertSemanticProjection } from '../src/public-safe.js';
import {
  buildRetrievalIndex,
  partitionByRaw,
  retrieve,
  retrieveWithCounts,
  type RetrievalIndex,
} from '../src/retrieve.js';

function entity(id: string, overrides: Partial<Entity> = {}): Entity {
  const type = id.slice(0, id.indexOf(':'));
  return {
    id,
    type,
    title: id.slice(id.indexOf(':') + 1).replace(/-/g, ' '),
    attribution: [{ name: 'Alex Author', role: 'author' }],
    url: `https://example.com/${type}/${id.slice(id.indexOf(':') + 1)}/`,
    identifiers: [],
    disclosure: { raw: 'public', exposure: 'text' },
    ...overrides,
  };
}

function fragment(entityId: string, key: string, text: string, overrides: Partial<Fragment> = {}): Fragment {
  return {
    id: `${entityId}#${key}`,
    entityId,
    locator: [{ scheme: 'whole', value: '' }],
    text,
    disclosure: { raw: 'public', exposure: 'text' },
    ...overrides,
  };
}

const GIST_SOURCE = 'The letter stays sealed on the table while the household argues about who may open it.';
const gist = assertSemanticProjection('A sealed letter divides a household over who has the right to read it.', {
  path: 'fixture',
  fragmentText: GIST_SOURCE,
});

/** Four entities: two public essays (one dated 2019, one 2024), a private
 *  transcript window with a named speaker, and a private book page served as a gist. */
function corpus(): RetrievalIndex {
  const essayOld = entity('essay:old-view', { date: '2019', themes: ['love', 'habit'] });
  const essayNew = entity('essay:new-view', { date: '2024-06-01', themes: ['love'] });
  const transcript = entity('transcript:ep1', {
    title: 'Episode one',
    attribution: [{ name: 'Alex Author', role: 'host' }],
    date: '2022-03-14',
    disclosure: { raw: 'private', exposure: 'locator' },
    parent: 'episode:ep1',
  });
  const book = entity('book:novel', {
    title: 'The Novel',
    attribution: [{ name: 'Alex Author', role: 'author' }, { name: 'Co Writer', role: 'author' }],
    disclosure: { raw: 'private', exposure: 'semantic' },
    version: 'manuscript',
  });
  const entries = [
    { fragment: fragment(essayOld.id, 'whole', 'An early essay on love as habit.', { summary: 'Love as habit.' }), vector: [1, 0, 0] },
    { fragment: fragment(essayNew.id, 'whole', 'A later essay on love as attention.', { summary: 'Love as attention.' }), vector: [0.9, 0.1, 0] },
    {
      fragment: fragment(transcript.id, 't100-160', 'private words spoken on the show', {
        locator: [{ scheme: 'timecode', value: '100', end: '160' }],
        disclosure: { raw: 'private', exposure: 'locator' },
        attribution: [
          { name: 'Alex Author', role: 'speaker' },
          { name: 'Other', role: 'speaker', placeholder: 'unnamed' },
        ],
        sourceReview: 'reviewed',
      }),
      vector: [0.8, 0.2, 0],
    },
    {
      fragment: fragment(book.id, 'p12', GIST_SOURCE, {
        locator: [{ scheme: 'page', value: '12' }],
        disclosure: { raw: 'private', exposure: 'semantic' },
        projection: { lint: 'passed', gist, source: 'generated', review: 'unreviewed', contentHash: 'h' },
      }),
      vector: [0.7, 0.3, 0],
    },
  ];
  return buildRetrievalIndex({
    version: 4,
    entities: [essayOld, essayNew, transcript, book],
    entries: entries.map((e) => ({ model: 'm', dimensions: 3, contentHash: 'x', ...e })),
  });
}

const Q = [1, 0, 0];

test('dates: intervals at their precision, intersection, and rejection of non-dates', () => {
  const y = parseDateInterval('2019')!;
  assert.equal(new Date(y.start).toISOString(), '2019-01-01T00:00:00.000Z');
  assert.equal(new Date(y.end).toISOString(), '2019-12-31T23:59:59.999Z');
  const m = parseDateInterval('2019-03')!;
  assert.equal(new Date(m.end).toISOString(), '2019-03-31T23:59:59.999Z');
  const d = parseDateInterval('2019-03-14')!;
  assert.equal(new Date(d.start).toISOString(), '2019-03-14T00:00:00.000Z');
  assert.equal(new Date(d.end).toISOString(), '2019-03-14T23:59:59.999Z');
  assert.equal(parseDateInterval('2019-02-30'), null);
  assert.equal(parseDateInterval('manuscript'), null);
  assert.equal(parseDateInterval(undefined), null);
  assert.ok(intervalsIntersect(y, parseDateInterval('2019-06')!));
  assert.ok(!intervalsIntersect(y, parseDateInterval('2020')!));
});

test('retrieve: filters run before scoring; undated fragments are excluded by a bound unless asked', () => {
  const index = corpus();
  assert.deepEqual(retrieve(Q, 'q', index, { filters: { type: ['essay'] } }).map((h) => h.entity.id), ['essay:old-view', 'essay:new-view']);
  assert.deepEqual(retrieve(Q, 'q', index, { filters: { raw: 'private' } }).map((h) => h.entity.id), ['transcript:ep1', 'book:novel']);
  assert.deepEqual(retrieve(Q, 'q', index, { filters: { exposure: ['semantic'] } }).map((h) => h.entity.id), ['book:novel']);
  assert.throws(() => retrieve(Q, 'q', index, { filters: { exposure: ['none' as never] } }), /'none' is not a served exposure/);

  // creator matches entity creators; speaker matches fragment speakers; placeholders never match.
  assert.deepEqual(retrieve(Q, 'q', index, { filters: { creator: 'co writer' } }).map((h) => h.entity.id), ['book:novel']);
  assert.deepEqual(retrieve(Q, 'q', index, { filters: { speaker: 'alex author' } }).map((h) => h.entity.id), ['transcript:ep1']);
  assert.deepEqual(retrieve(Q, 'q', index, { filters: { speaker: 'other' } }), []);

  // Dates are intervals: a bound of 2019 catches the essay dated "2019"; the
  // undated book is dropped and counted, unless undated=include.
  const bounded = retrieveWithCounts(Q, 'q', index, { filters: { dateFrom: '2019', dateTo: '2019' } });
  assert.deepEqual(bounded.hits.map((h) => h.entity.id), ['essay:old-view']);
  assert.equal(bounded.excludedUndated, 1);
  const after = retrieveWithCounts(Q, 'q', index, { filters: { dateFrom: '2022-03' } });
  assert.deepEqual(after.hits.map((h) => h.entity.id), ['essay:new-view', 'transcript:ep1']);
  const inclusive = retrieve(Q, 'q', index, { filters: { dateFrom: '2022-03', undated: 'include' } });
  assert.deepEqual(inclusive.map((h) => h.entity.id), ['essay:new-view', 'transcript:ep1', 'book:novel']);
  assert.throws(() => retrieve(Q, 'q', index, { filters: { dateFrom: 'yesterday' } }), /not YYYY, YYYY-MM, or YYYY-MM-DD/);
});

test('retrieve: limit is one list; limitPerRaw caps each layer; the two are exclusive', () => {
  const index = corpus();
  const flat = retrieveWithCounts(Q, 'q', index, { limit: 2 });
  assert.equal(flat.hits.length, 2);
  assert.equal(flat.matched, 4);
  const perRaw = retrieve(Q, 'q', index, { limitPerRaw: { public: 1, private: 1 } });
  assert.deepEqual(perRaw.map((h) => h.entity.id), ['essay:old-view', 'transcript:ep1']);
  // The default is 8/8 and a private hit is never crowded out by public ones.
  const { public: pub, private: priv } = partitionByRaw(retrieve(Q, 'q', index));
  assert.equal(pub.length, 2);
  assert.equal(priv.length, 2);
  assert.throws(() => retrieve(Q, 'q', index, { limit: 2, limitPerRaw: { public: 1 } }), /either limit or limitPerRaw/);
  // The floor still applies: nothing below it is a candidate.
  assert.equal(retrieve([0, 0, 1], 'q', index).length, 0);
});

test('retrieve: default plugins are 2.x scoring; the built-ins are opt-in and itemized in the breakdown', () => {
  const index = corpus();
  const byDefault = retrieve(Q, 'what does the new view say now', index);
  // Default: exact match and theme on public fragments only; no recency, no disclosure.
  for (const h of byDefault) {
    assert.ok(!('recency' in h.breakdown));
    assert.ok(!('disclosure' in h.breakdown));
  }
  assert.equal(byDefault.find((h) => h.entity.id === 'essay:new-view')!.breakdown.exactMatch, 0.3);
  assert.equal(DEFAULT_PLUGINS.length, 2);

  const rich = retrieve(Q, 'what does the new view say now', index, { plugins: ALL_BUILTIN_PLUGINS, asOf: new Date('2024-09-01T00:00:00Z') });
  const newView = rich.find((h) => h.entity.id === 'essay:new-view')!;
  assert.equal(newView.breakdown.disclosure, 0.15);
  assert.equal(newView.breakdown.recency, 0.1); // 2024-06-01 is inside the fresh window at 2024-09-01
  const oldView = rich.find((h) => h.entity.id === 'essay:old-view')!;
  assert.equal(oldView.breakdown.recency, undefined); // 2019 is past the floor
  const transcript = rich.find((h) => h.entity.id === 'transcript:ep1')!;
  assert.equal(transcript.breakdown.disclosure, 0.15); // reviewed source
  const book = rich.find((h) => h.entity.id === 'book:novel')!;
  assert.equal(book.breakdown.disclosure, undefined); // unreviewed private
});

test('boosts: recency modes, the decay, and the current-views heuristic', () => {
  const asOf = new Date('2024-09-01T00:00:00Z');
  assert.equal(recencyFactor('2024-06-01', asOf), 1);
  assert.equal(recencyFactor('2019', asOf), 0);
  const mid = recencyFactor('2023-06-01', asOf); // ~458 days: inside the decay
  assert.ok(mid > 0 && mid < 1);
  assert.equal(recencyFactor(undefined, asOf), 0);
  assert.ok(queryIsAboutNow('what does he think now'));
  assert.ok(!queryIsAboutNow('what about snow'));

  const index = corpus();
  const plugins = [recency()];
  const auto = retrieve(Q, 'what is the view', index, { plugins, asOf });
  assert.ok(auto.every((h) => h.breakdown.recency === undefined));
  const prefer = retrieve(Q, 'what is the view', index, { plugins, asOf, recency: 'prefer-recent' });
  assert.equal(prefer.find((h) => h.entity.id === 'essay:new-view')!.breakdown.recency, 0.1);
  const none = retrieve(Q, 'what is the view now', index, { plugins, asOf, recency: 'none' });
  assert.ok(none.every((h) => h.breakdown.recency === undefined));
});

test('boosts: the theme cap excludes archive-wide themes only once the corpus is large enough', () => {
  const eight = Array.from({ length: 8 }, (_, i) =>
    entity(`essay:e${i}`, { themes: i < 4 ? ['prophecy', `unique${i}`] : [`unique${i}`] }),
  );
  // "prophecy" on 4 of 8: cap is max(4, ceil(0.4)) = 4, so it still discriminates.
  assert.ok(discriminatingThemes(eight).has('prophecy'));
  const nine = [...eight, entity('essay:e8', { themes: ['prophecy'] })];
  // On 5 of 9 it names the archive, not an entity.
  assert.ok(!discriminatingThemes(nine).has('prophecy'));
  // Production-sized: ceil(0.05 × 800) = 40 governs.
  const big = Array.from({ length: 800 }, (_, i) =>
    entity(`essay:b${i}`, { themes: i < 41 ? ['everywhere'] : i < 51 ? ['rare'] : [] }),
  );
  assert.ok(!discriminatingThemes(big).has('everywhere'));
  assert.ok(discriminatingThemes(big).has('rare'));

  // The plugin honours layers and the cap can be switched off.
  const t = themeMatch({ layers: ['public'] });
  const idx = corpus();
  const ctx = { query: 'love and habit', normalized: 'love and habit', asOf: new Date(), recency: 'auto' as const };
  const eligible = t.prepare!(idx, ctx);
  const old = idx.entries[0]!.fragment;
  assert.equal(t.score(old, idx.entities.get('essay:old-view')!, ctx, eligible), 0.15);
  const priv = idx.entries[2]!.fragment;
  assert.equal(t.score(priv, idx.entities.get('transcript:ep1')!, ctx, eligible), 0);
  assert.equal(themeMatch({ dfCap: false }).prepare!(idx, ctx), null);
  assert.equal(exactTitleMatch().score(priv, idx.entities.get('transcript:ep1')!, { ...ctx, query: 'episode one' }, undefined), 0.3);
  assert.equal(disclosure().score(priv, idx.entities.get('transcript:ep1')!, ctx, undefined), 0.15);
});

test('no-leak: search() returns hits whose type cannot carry private text; private scores are coarse', () => {
  const index = corpus();
  const hits = search([0.7, 0.3, 0], 'q', index, { plugins: ALL_BUILTIN_PLUGINS, limit: 10 });
  const book = hits.find((h) => h.entity.id === 'book:novel')!;
  assert.equal(book.exposure, 'semantic');
  assert.equal(book.raw, 'private');
  assert.ok(book.exposure === 'semantic' && book.gist === gist);
  assert.ok(book.exposure === 'semantic' && book.gistSource === 'generated' && book.gistReview === 'unreviewed');
  assert.equal(book.locatorLabel, 'p. 12');
  assert.equal(book.entity.version, 'manuscript');
  assert.equal(book.breakdown, undefined);
  assert.equal(book.score, Math.round(book.score * 20) / 20); // rounded to 0.05
  assert.ok(!JSON.stringify(book).includes('sealed on the table'));

  const transcript = hits.find((h) => h.entity.id === 'transcript:ep1')!;
  assert.equal(transcript.exposure, 'locator');
  assert.equal(transcript.locatorLabel, '1:40–2:40');
  assert.equal(transcript.date, '2022-03-14');
  assert.equal(transcript.entity.parent, 'episode:ep1');
  assert.deepEqual(transcript.attribution?.map((a) => a.name), ['Alex Author', 'Other']);
  assert.ok(!JSON.stringify(transcript).includes('spoken on the show'));
  assert.ok(!('text' in transcript));

  const essay = hits.find((h) => h.entity.id === 'essay:new-view')!;
  assert.equal(essay.exposure, 'text');
  assert.ok(essay.exposure === 'text' && essay.text.includes('attention'));
  assert.equal(essay.date, '2024-06-01');
  assert.ok(essay.breakdown && 'cosine' in essay.breakdown);

  // A semantic fragment whose gist is not servable cannot cross.
  const broken = corpus();
  const bookEntry = broken.entries.find((e) => e.fragment.entityId === 'book:novel')!;
  (bookEntry.fragment as Fragment).projection = { ...bookEntry.fragment.projection!, vetoed: true };
  const scored = retrieve([0.7, 0.3, 0], 'q', broken).find((h) => h.entity.id === 'book:novel')!;
  assert.throws(() => project(scored), /without a servable gist/);
});
