// Offline tests for the 3.0.0 contract's first step: the gist lint, policy
// resolution, fragmenting, and locator rendering. No API key, no network.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Entity, SemanticProjection } from '../src/contract.js';
import { isServableGist, resolveDisclosure } from '../src/ingest/disclosure.js';
import { fragmentByHeadings, fragmentByPageMarkers, splitLong } from '../src/ingest/fragment.js';
import { formatTimecode, locatorKey, renderLocatorLabel } from '../src/locator.js';
import {
  assertPublicSafeField,
  assertPublicSafeMetadata,
  assertSemanticProjection,
  entityLintText,
  GIST_MAX_CHARS,
  hasUnspacedScript,
  normalizeWords,
  privateTextMatcher,
  PublicSafeLintError,
} from '../src/public-safe.js';

const PAGE_184 =
  'Priya read the document twice before she understood what her signature would commit her to: ' +
  'a version of the evening that none of the people in the room had seen. The others were already ' +
  'reaching for pens. She asked, quietly, who would answer for it if the account turned out to be wrong.';
const PAGE_183 =
  'The negotiation had run past midnight. Coffee had gone cold in paper cups along the table, and ' +
  'the lawyer kept checking a phone that never rang.';

test('gist lint: a describing gist passes and returns the brand unchanged', () => {
  const gist =
    'A late-night signing in which one party realises the paper binds her to events she did not witness, ' +
    'and asks who will be accountable if the record is false.';
  const linted = assertSemanticProjection(gist, { path: 'book#p184', fragmentText: PAGE_184 });
  assert.equal(linted, gist);
});

test('gist lint: five shared words is quotation, four is description', () => {
  assert.throws(
    () =>
      assertSemanticProjection('She wonders who would answer for it if the account is false.', {
        path: 'book#p184',
        fragmentText: PAGE_184,
      }),
    /book#p184: gist quotes the fragment's text at words 3–7: a projection must not contain 5 consecutive words/,
  );
  // Four words shared ("would answer for it") passes; the window is five.
  assert.equal(
    typeof assertSemanticProjection('She wonders who would answer for the record if it is false.', {
      path: 'book#p184',
      fragmentText: PAGE_184,
    }),
    'string',
  );
});

test('gist lint: the entity text catches a gist that quotes the page before', () => {
  const gist = 'A tense scene: the negotiation had run past midnight and nobody trusted the document.';
  // Against the fragment alone it passes (the run is from page 183).
  assertSemanticProjection(gist, { path: 'book#p184', fragmentText: PAGE_184 });
  assert.throws(
    () =>
      assertSemanticProjection(gist, {
        path: 'book#p184',
        fragmentText: PAGE_184,
        entityText: `${PAGE_183}\n\n${PAGE_184}`,
      }),
    /quotes the entity's text at words 4–8/,
  );
});

test('gist lint: a failure names the position of the run, never the run, and is a PublicSafeLintError', () => {
  // The message is what `npm run index`, CI, and a consumer's loader print;
  // the run is private text, so it stays out (STANDARDS §4).
  const gist = 'She wonders who would answer for it if the account is false.';
  assert.throws(
    () => assertSemanticProjection(gist, { path: 'book#p184', fragmentText: PAGE_184 }),
    (err: unknown) =>
      err instanceof PublicSafeLintError &&
      !/who would answer/.test(err.message) &&
      !/account/.test(err.message) &&
      /words 3–7/.test(err.message),
  );
  // The same for the traveling-string lint.
  assert.throws(
    () => assertPublicSafeField('Notes: who would answer for it', { field: 'label', path: 'n', privateText: PAGE_184 }),
    (err: unknown) => err instanceof PublicSafeLintError && !/answer/.test(err.message) && /words 2–6/.test(err.message),
  );
  // Shape failures are lint failures too.
  assert.throws(() => assertSemanticProjection('', { path: 'x', fragmentText: PAGE_184 }), PublicSafeLintError);
});

test('entityLintText: fragment-id order, whatever order the fragments arrive in', () => {
  const inOrder = entityLintText([
    { id: 'book:x#p1', text: 'one' },
    { id: 'book:x#p2', text: 'two' },
  ]);
  const reversed = entityLintText([
    { id: 'book:x#p2', text: 'two' },
    { id: 'book:x#p1', text: 'one' },
  ]);
  assert.equal(inOrder, 'one\n\ntwo');
  assert.equal(reversed, inOrder);
});

test('gist lint: shape checks fail loudly with the path', () => {
  assert.throws(
    () => assertSemanticProjection('', { path: 'x', fragmentText: PAGE_184 }),
    /x: gist must not be empty/,
  );
  assert.throws(
    () => assertSemanticProjection('one\ntwo', { path: 'x', fragmentText: PAGE_184 }),
    /one paragraph/,
  );
  assert.throws(
    () => assertSemanticProjection('a'.repeat(GIST_MAX_CHARS + 1), { path: 'x', fragmentText: PAGE_184 }),
    /is 401 chars \(max 400\)/,
  );
  // The caps are tunable per entity.
  assert.throws(
    () => assertSemanticProjection('a'.repeat(101), { path: 'x', fragmentText: PAGE_184, maxChars: 100 }),
    /max 100/,
  );
  assert.throws(
    () =>
      assertSemanticProjection('she asked quietly who would', {
        path: 'x',
        fragmentText: PAGE_184,
        ngramWords: 4,
      }),
    /4 consecutive words/,
  );
});

test('gist lint: normalization is Unicode-aware and counts characters for unspaced scripts', () => {
  assert.deepEqual(normalizeWords('Café — Déjà vu, 2026!'), ['café', 'déjà', 'vu', '2026']);
  assert.ok(hasUnspacedScript('東京の夜'));
  assert.ok(!hasUnspacedScript('Tokyo at night'));

  const japanese =
    '彼女は書類を二度読み、自分の署名が何を約束するのかをようやく理解した。部屋にいた誰も見ていない夜の出来事を、彼らは記録として残そうとしていた。';
  // A word-run check is vacuous here (the passage is one "word"); the
  // character run catches a lifted clause, reported by position.
  assert.deepEqual(privateTextMatcher(japanese)('自分の署名が何を約束するのかを'), { unit: 'characters', n: 12, start: 1 });
  assert.equal(privateTextMatcher(japanese)('署名の重みに気づく女性'), null);
  assert.throws(
    () =>
      assertSemanticProjection('彼女は、自分の署名が何を約束するのかをようやく理解した場面。', {
        path: 'book#p1',
        fragmentText: japanese,
      }),
    /12 consecutive characters/,
  );
  // A description in different words passes.
  assertSemanticProjection('署名の重みに気づく女性と、見ていない出来事を記録に残そうとする人々の場面。', {
    path: 'book#p1',
    fragmentText: japanese,
  });
});

test('public-safe lint: the Unicode normalizer preserves the 2.x verdicts on ASCII', () => {
  const body = 'The bridge originally modulated up a whole step and we scrapped it in the second session.';
  assert.throws(
    () =>
      assertPublicSafeField('Notes: originally modulated up a whole step', {
        field: 'label',
        path: 'n.md',
        privateText: body,
      }),
    /quotes private text at words 2–6/,
  );
  assert.equal(
    assertPublicSafeField('modulated up a whole octave instead', { field: 'label', path: 'n.md', privateText: body }),
    'modulated up a whole octave instead',
  );
  // Accented letters are letters, not separators: "déjà" is one word.
  assert.deepEqual(privateTextMatcher('and déjà vu all over again now')('déjà vu all over again now'), {
    unit: 'words',
    n: 5,
    start: 1,
  });
});

function entity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: 'book:example',
    type: 'book',
    title: 'Example',
    attribution: [{ name: 'A. Author', role: 'author' }],
    url: 'https://example.com/book/',
    identifiers: [],
    disclosure: { raw: 'private', exposure: 'semantic' },
    ...overrides,
  };
}

function passed(overrides: Partial<SemanticProjection> = {}): SemanticProjection {
  const gist = assertSemanticProjection('A description of the passage, in other words.', {
    path: 'fixture',
    fragmentText: PAGE_184,
  });
  return {
    lint: 'passed',
    gist,
    source: 'generated',
    review: 'unreviewed',
    contentHash: 'abc',
    ...overrides,
  } as SemanticProjection;
}

test('disclosure: isServableGist is the one predicate, and every clause bites', () => {
  const e = entity();
  assert.equal(isServableGist({}, e), false);
  assert.equal(isServableGist({ projection: passed() }, e), true);
  assert.equal(
    isServableGist({ projection: { lint: 'failed', draft: 'x', source: 'generated', review: 'unreviewed', contentHash: 'h' } }, e),
    false,
  );
  assert.equal(isServableGist({ projection: passed({ vetoed: true }) }, e), false);
  assert.equal(isServableGist({ projection: passed({ stale: true }) }, e), false);
  const strict = entity({ policy: { requireReview: true } });
  assert.equal(isServableGist({ projection: passed() }, strict), false);
  assert.equal(isServableGist({ projection: passed({ review: 'reviewed' }) }, strict), true);
});

test('disclosure: resolution inherits, overrides, and only ever downgrades', () => {
  const e = entity();
  // Entity default `semantic` with a servable gist resolves to semantic.
  assert.deepEqual(resolveDisclosure(e, { projection: passed() }), { raw: 'private', exposure: 'semantic' });
  // No gist: downgraded to locator, never upgraded, never thrown.
  assert.deepEqual(resolveDisclosure(e, {}), { raw: 'private', exposure: 'locator' });
  // A fragment override may be more permissive than the entity default.
  const locked = entity({ disclosure: { raw: 'private', exposure: 'locator' } });
  assert.deepEqual(resolveDisclosure(locked, { exposure: 'semantic', projection: passed() }), {
    raw: 'private',
    exposure: 'semantic',
  });
  // none stays none, whatever the projection says.
  assert.deepEqual(resolveDisclosure(e, { exposure: 'none', projection: passed() }), {
    raw: 'private',
    exposure: 'none',
  });
  // raw always comes from the entity; a public entity may expose text.
  const pub = entity({ id: 'essay:x', disclosure: { raw: 'public', exposure: 'text' } });
  assert.deepEqual(resolveDisclosure(pub, {}), { raw: 'public', exposure: 'text' });
  assert.deepEqual(resolveDisclosure(pub, { exposure: 'semantic' }), { raw: 'public', exposure: 'locator' });
  // private + text is a misauthored input, named by path.
  assert.throws(
    () => resolveDisclosure(e, { exposure: 'text' }, { path: 'manuscript.md#ch1' }),
    /manuscript\.md#ch1: requests exposure 'text' on the private entity 'book:example'/,
  );
});

test('fragment: headings become chapter locators; long chapters sub-split into sections', () => {
  const md = [
    'Front matter before any heading.',
    '',
    '# Chapter 1',
    'First paragraph of one.',
    '',
    'Second paragraph of one.',
    '',
    '## An Interlude',
    'Interlude text.',
    '',
    '# CHAPTER XII',
    'Twelve.',
  ].join('\n');
  const pieces = fragmentByHeadings(md);
  assert.deepEqual(
    pieces.map((p) => [locatorKey(p.locator), p.heading ?? null]),
    [
      ['sfront', null],
      ['ch1', 'Chapter 1'],
      ['ch2', 'An Interlude'],
      ['chXII', 'CHAPTER XII'],
    ],
  );
  assert.equal(pieces[1]!.text, 'First paragraph of one.\n\nSecond paragraph of one.');

  const small = fragmentByHeadings(md, { maxFragmentChars: 30 });
  const keys = small.map((p) => locatorKey(p.locator));
  assert.deepEqual(keys.slice(0, 4), ['sfront.para1', 'sfront.para2', 'ch1.s1', 'ch1.s2']);
  for (const p of small) assert.ok(p.text.length <= 30, `${locatorKey(p.locator)} is ${p.text.length} chars`);
});

test('fragment: page markers and form feeds become page locators', () => {
  const ff = 'Page one text.\fPage two text.\f\fPage four text.';
  assert.deepEqual(
    fragmentByPageMarkers(ff, { firstPage: 183 }).map((p) => [locatorKey(p.locator), p.text]),
    [
      ['p183', 'Page one text.'],
      ['p184', 'Page two text.'],
      ['p186', 'Page four text.'],
    ],
  );
  const marked = ['Preface line.', '<<<page 184>>>', 'Body of 184.', '<<<page 185>>>', 'Body of 185.'].join('\n');
  assert.deepEqual(
    fragmentByPageMarkers(marked).map((p) => locatorKey(p.locator)),
    ['sfront', 'p184', 'p185'],
  );
  // A single paragraph longer than the cap is cut at whitespace, never mid-word.
  const long = { locator: [{ scheme: 'page', value: '1' }], text: 'word '.repeat(40).trim() };
  const parts = splitLong(long, 23);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.text.length <= 23);
    assert.ok(!part.text.includes('wor '), 'cut mid-word');
  }
  assert.deepEqual(parts[0]!.locator, [
    { scheme: 'page', value: '1' },
    { scheme: 'section', value: '1' },
  ]);
});

test('locator: labels and keys per scheme, coarse to fine', () => {
  assert.equal(renderLocatorLabel([{ scheme: 'whole', value: '' }]), 'whole record');
  assert.equal(renderLocatorLabel([{ scheme: 'page', value: '184' }]), 'p. 184');
  assert.equal(renderLocatorLabel([{ scheme: 'page', value: '78', end: '88' }]), 'pp. 78–88');
  assert.equal(
    renderLocatorLabel([
      { scheme: 'chapter', value: '12' },
      { scheme: 'section', value: '3' },
    ]),
    'ch. 12, §3',
  );
  assert.equal(renderLocatorLabel([{ scheme: 'timecode', value: '750', end: '845' }]), '12:30–14:05');
  assert.equal(renderLocatorLabel([{ scheme: 'timecode', value: '3725.9' }]), '1:02:05');
  assert.equal(renderLocatorLabel([{ scheme: 'note', value: 'notebook, p. 12' }]), 'notebook, p. 12');
  assert.equal(renderLocatorLabel([{ scheme: 'verse', value: '3' }]), 'verse 3');
  assert.throws(() => renderLocatorLabel([]), /at least one locator/);

  assert.equal(formatTimecode('59.99'), '0:59');
  // A malformed value fails without being echoed: the renderer runs inside the lint at index load.
  assert.throws(
    () => formatTimecode('twelve thirty'),
    (err: unknown) => err instanceof Error && /not decimal seconds/.test(err.message) && !/twelve/.test(err.message),
  );
  assert.throws(() => renderLocatorLabel([{ scheme: 'timecode', value: '750', end: 'later' }]), /not decimal seconds/);
  assert.equal(locatorKey([{ scheme: 'timecode', value: '750', end: '845' }]), 't750-845');
  assert.equal(locatorKey([{ scheme: 'page', value: '184' }]), 'p184');
  assert.equal(locatorKey([{ scheme: 'whole', value: '' }]), 'whole');
  assert.equal(locatorKey([{ scheme: 'note', value: 'Notebook, p. 12' }]), 'notebook-p-12');
  assert.equal(
    locatorKey([
      { scheme: 'chapter', value: '12' },
      { scheme: 'section', value: '3' },
    ]),
    'ch12.s3',
  );
});

test('public-safe metadata lint: every authored string a private hit carries, against the entity text', () => {
  const body = 'The negotiation had run past midnight before anyone asked who would answer for it.';
  const base: Parameters<typeof assertPublicSafeMetadata>[0] = {
    id: 'book:x',
    title: 'A Short Title',
    attribution: [{ name: 'A. Author', role: 'author' }],
  };
  const frag = (over: Partial<Parameters<typeof assertPublicSafeMetadata>[1][number]> = {}) => ({
    id: 'book:x#p1',
    text: body,
    locator: [{ scheme: 'page', value: '1' }],
    ...over,
  });
  const ctx = { path: 'index at t' };

  // Structural values (page numbers, the empty value of `whole`, timecodes) pass.
  assertPublicSafeMetadata(base, [frag()], ctx);
  assertPublicSafeMetadata(base, [frag({ locator: [{ scheme: 'whole', value: '' }] })], ctx);
  assertPublicSafeMetadata(base, [frag({ locator: [{ scheme: 'timecode', value: '750', end: '845' }] })], ctx);

  // A speaker name or a theme that quotes the text is caught like a title.
  assert.throws(
    () => assertPublicSafeMetadata(base, [frag({ attribution: [{ name: 'asked who would answer for it' }] })], ctx),
    /index at t: fragment 'book:x#p1': 'speaker name' quotes private text at words 1–5/,
  );
  assert.throws(
    () => assertPublicSafeMetadata({ ...base, themes: ['who would answer for it'] }, [frag()], ctx),
    /entity 'book:x': 'theme' quotes private text/,
  );
  // A `section` value is authored text and is checked as such.
  assert.throws(
    () =>
      assertPublicSafeMetadata(base, [frag({ locator: [{ scheme: 'section', value: 'run past midnight before anyone asked' }] })], ctx),
    /'locator value \(section\)' quotes private text/,
  );
  // The whole entity is the comparison text: a title may not quote page two either.
  assert.throws(
    () =>
      assertPublicSafeMetadata({ ...base, title: 'Before anyone asked who would' }, [
        frag({ text: 'Page one says little.' }),
        frag({ id: 'book:x#p2', text: body, locator: [{ scheme: 'page', value: '2' }] }),
      ], ctx),
    /'title' quotes private text/,
  );

  // Scripts without word spacing are checked in characters.
  const japanese = '交渉は真夜中を過ぎても続き、誰がその責任を負うのかを尋ねる者はいなかった。';
  assertPublicSafeMetadata({ ...base, title: '署名者たち' }, [frag({ text: japanese })], ctx);
  assert.throws(
    () => assertPublicSafeMetadata({ ...base, title: '交渉は真夜中を過ぎても続き、誰が' }, [frag({ text: japanese })], ctx),
    /'title' quotes private text at characters \d+–\d+: a traveling field must not contain 12 consecutive characters/,
  );
});

test('public-safe metadata lint: policy.lint sets the window for the entity', () => {
  const body = 'The negotiation had run past midnight before anyone asked who would answer for it.';
  const base = { id: 'book:x', title: 'A Short Title', attribution: [] };
  const frag = { id: 'book:x#p1', text: body, locator: [{ scheme: 'page', value: '1' }] };
  // Four shared words pass at the shipped window and fail at an authored four.
  assertPublicSafeMetadata({ ...base, title: 'Who would answer for them' }, [frag], { path: 't' });
  assert.throws(
    () =>
      assertPublicSafeMetadata({ ...base, title: 'Who would answer for them', policy: { lint: { ngramWords: 4 } } }, [frag], {
        path: 't',
      }),
    /'title' quotes private text at words 1–4: a traveling field must not contain 4 consecutive words/,
  );
});

test('public-safe metadata lint: policy.publicTitle skips the run check on the title, nothing else', () => {
  const transcript = 'Welcome back to perfect pitch nature or nurture, the episode where we settle it.';
  const base = {
    id: 'transcript:perfect-pitch',
    title: 'Perfect Pitch Nature or Nurture',
    attribution: [{ name: 'Luke F. Walton', role: 'host' }],
  };
  const frag = { id: 'transcript:perfect-pitch#t0-10', text: transcript, locator: [{ scheme: 'timecode', value: '0', end: '10' }] };
  // The host read the title aloud: without the declaration that is a quotation...
  assert.throws(() => assertPublicSafeMetadata(base, [frag], { path: 't' }), /'title' quotes private text/);
  // ...with it, the title is public by construction and passes.
  assertPublicSafeMetadata({ ...base, policy: { publicTitle: true } }, [frag], { path: 't' });
  // Shape still holds, and every other string is still checked.
  assert.throws(
    () => assertPublicSafeMetadata({ ...base, title: 'two\nlines', policy: { publicTitle: true } }, [frag], { path: 't' }),
    /'title' must be a single line/,
  );
  assert.throws(
    () =>
      assertPublicSafeMetadata(
        { ...base, policy: { publicTitle: true }, attribution: [{ name: 'the episode where we settle it' }] },
        [frag],
        { path: 't' },
      ),
    /'creator name' quotes private text/,
  );
});
