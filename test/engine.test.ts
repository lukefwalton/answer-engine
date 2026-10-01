// Offline, deterministic engine tests. No API key, no network.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { config } from '../archive.config.js';
import {
  assertCitationsGroundedInEvidence,
  deriveMode,
  finalizeAnswer,
  repairCitationsToEvidence,
  validateAnswer,
} from '../src/answer.js';
import { buildCorpus, buildPrivateNotes, embedText, stripMarkdown } from '../src/corpus.js';
import { batchInputs, truncateForEmbedding, MAX_INPUT_BYTES } from '../src/embedding.js';
import {
  judgeAnswer,
  judgeAnswerMode,
  judgeRetrieval,
  loadGold,
  loadGoldFile,
  sweepCanaries,
  parseEvalReport,
  parseEvalReportJson,
} from '../src/evaluate.js';
import { filterGoldQueries, parseQueryIdList } from '../src/eval-select.js';
import { toAnswerEvidence } from '../src/evidence.js';
import { fromPrivateNote, toPrivateNote } from '../src/adapters/teaching.js';
import { project, search } from '../src/no-leak.js';
import {
  assertPublicSafeField,
  assertSemanticProjection,
  PUBLIC_SAFE_MAX_CHARS,
  renderRelatedMaterialAnswer,
} from '../src/public-safe.js';
import { buildSystemPrompt, buildUserPrompt, MAX_PROMPT_BODY_CHARS } from '../src/prompt.js';
import { buildRetrievalIndex, containsPhrase, cosine, partitionByRaw, retrieve } from '../src/retrieve.js';
import {
  assertHomogeneousIndex,
  indexFileFromLegacyEntries,
  readIndexFile,
  writeIndexFile,
} from '../src/store.js';
import type { AnswerEvidence, ArchiveRecord, IndexEntry, PrivateNote } from '../src/types.js';

function makeRecord(overrides: Partial<ArchiveRecord> = {}): ArchiveRecord {
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

/** Traveling fields go through the real lint, so fixtures can't dodge the
 *  brand — plain-string overrides are linted against the note's text. */
function makeNote(
  overrides: Partial<Omit<PrivateNote, 'label' | 'locator'>> & { label?: string; locator?: string } = {},
): PrivateNote {
  const text = overrides.text ?? 'The bridge originally modulated up a whole step.';
  const path = overrides.id ?? 'note:harbor-lights-session';
  return {
    id: 'note:harbor-lights-session',
    title: 'Harbor Lights — writing session',
    url: 'https://example.com/lyrics/harbor-lights/',
    ...overrides,
    label: assertPublicSafeField(overrides.label ?? 'Harbor Lights — writing session', {
      field: 'label',
      path,
      privateText: text,
    }),
    locator: assertPublicSafeField(overrides.locator ?? 'notebook, p. 12', {
      field: 'locator',
      path,
      privateText: text,
    }),
    text,
  };
}

function recordEntry(record: ArchiveRecord, vector: number[]): IndexEntry {
  return {
    sourceType: 'record',
    record,
    model: 'test-model',
    dimensions: vector.length,
    vector,
    contentHash: 'x',
  };
}

function noteEntry(note: PrivateNote, vector: number[]): IndexEntry {
  return {
    sourceType: 'note',
    note,
    model: 'test-model',
    dimensions: vector.length,
    vector,
    contentHash: 'x',
  };
}

/** The in-package consumer's evidence shape, built directly: records as given,
 *  notes reduced to hints (hintId, label, url, locator; no text). */
function evidenceOf(records: ArchiveRecord[], notes: PrivateNote[] = []): AnswerEvidence {
  return {
    records,
    hints: notes.map((n) => ({ hintId: n.id, label: n.label, url: n.url, locator: n.locator })),
  };
}

/** A note reduced to the hint the in-package consumer sees (no text). */
function hintOf(note: PrivateNote) {
  return { hintId: note.id, label: note.label as string, url: note.url, locator: note.locator as string };
}

/** A retrieval index from legacy record/note entries (through the adapters). */
function indexOf(entries: IndexEntry[]) {
  return buildRetrievalIndex(indexFileFromLegacyEntries(entries));
}

const RECORD_CITE = {
  kind: 'record' as const,
  recordId: 'essay:on-listening',
  url: 'https://example.com/essays/on-listening/',
};
const HINT_CITE = {
  kind: 'hint' as const,
  hintId: 'note:harbor-lights-session',
  url: 'https://example.com/lyrics/harbor-lights/',
};

test('corpus: reads the bundled example content, both layers', () => {
  const records = buildCorpus(config);
  assert.equal(records.length, 4);
  const essay = records.find((r) => r.id === 'essay:on-listening');
  assert.ok(essay);
  assert.equal(essay.url, 'https://example.com/essays/on-listening/');
  assert.ok(essay.summary.length > 0);
  assert.deepEqual(essay.themes, ['attention', 'criticism']);
  // Lyrics use `meaning` for the summary.
  const song = records.find((r) => r.id === 'song:harbor-lights');
  assert.ok(song?.summary.includes('staying put'));

  const notes = buildPrivateNotes(config);
  assert.equal(notes.length, 2);
  const session = notes.find((n) => n.id === 'note:harbor-lights-session');
  assert.ok(session);
  assert.equal(session.url, 'https://example.com/lyrics/harbor-lights/');
  assert.ok(session.text.includes('bridge'));
  // The private title and the traveling label are separate fields; the
  // bundled notes declare both (and here they match, which is a choice).
  assert.equal(session.title, 'Harbor Lights — writing session');
  assert.equal(session.label, 'Harbor Lights — writing session');
});

test('corpus: a missing collection directory fails loudly, not silently', () => {
  assert.throws(
    () =>
      buildCorpus({
        ...config,
        collections: [{ dir: 'does-not-exist', urlPrefix: '/x/', type: 'essay' }],
      }),
    /cannot read collection 'essay'.*does-not-exist/,
  );
});

test('corpus: malformed frontmatter and missing required fields name the file', () => {
  const root = mkdtempSync(join(tmpdir(), 'ae-corpus-'));
  mkdirSync(join(root, 'essays'));
  writeFileSync(join(root, 'essays', 'broken.md'), '---\ntitle: "unclosed\n---\nbody\n', 'utf8');
  const collections = [{ dir: 'essays', urlPrefix: '/essays/', type: 'essay' }];
  assert.throws(
    () => buildCorpus({ ...config, contentRoot: root, collections }),
    /failed to parse .*broken\.md/,
  );

  writeFileSync(join(root, 'essays', 'broken.md'), '---\ndate: 2026-01-01\n---\nbody\n', 'utf8');
  assert.throws(
    () => buildCorpus({ ...config, contentRoot: root, collections }),
    /broken\.md has no 'title'.*draft: true/,
  );

  // Private notes additionally require about + locator...
  mkdirSync(join(root, 'notebook'));
  writeFileSync(join(root, 'notebook', 'n.md'), '---\ntitle: "A note"\n---\nprivate text\n', 'utf8');
  assert.throws(
    () => buildPrivateNotes({ ...config, privateNotesDir: join(root, 'notebook') }),
    /n\.md needs 'about'.*'locator'/,
  );

  // ...and an explicit public-safe label: the title never travels by default.
  writeFileSync(
    join(root, 'notebook', 'n.md'),
    '---\ntitle: "A note"\nabout: https://example.com/x/\nlocator: "p. 1"\n---\nprivate text\n',
    'utf8',
  );
  assert.throws(
    () => buildPrivateNotes({ ...config, privateNotesDir: join(root, 'notebook') }),
    /n\.md needs 'label'.*'title' stays private/,
  );
});

test('corpus: a note may request its exposure; anything but semantic, locator, or none names the file', () => {
  const root = mkdtempSync(join(tmpdir(), 'ae-exposure-'));
  mkdirSync(join(root, 'notebook'));
  const front = (exposure: string) =>
    `---\ntitle: "A note"\nlabel: "A note"\nabout: https://example.com/x/\nlocator: "p. 1"\nexposure: ${exposure}\n---\nprivate text\n`;
  writeFileSync(join(root, 'notebook', 'semantic.md'), front('semantic'), 'utf8');
  writeFileSync(join(root, 'notebook', 'none.md'), front('none'), 'utf8');
  writeFileSync(join(root, 'notebook', 'plain.md'), front('locator').replace('exposure: locator\n', ''), 'utf8');
  const notes = buildPrivateNotes({ ...config, privateNotesDir: join(root, 'notebook') });
  assert.deepEqual(
    notes.map((n) => [n.id, n.exposure]),
    [
      ['note:none', 'none'],
      ['note:plain', undefined],
      ['note:semantic', 'semantic'],
    ],
  );
  // Through the adapter: the request is the entity default; the fragment is resolved without a gist.
  const semantic = fromPrivateNote(notes.find((n) => n.id === 'note:semantic')!);
  assert.deepEqual(semantic.entity.disclosure, { raw: 'private', exposure: 'semantic' });
  assert.deepEqual(semantic.fragment.disclosure, { raw: 'private', exposure: 'locator' });
  assert.equal(toPrivateNote(semantic.entity, semantic.fragment).exposure, 'semantic');
  const plain = fromPrivateNote(notes.find((n) => n.id === 'note:plain')!);
  assert.equal('exposure' in toPrivateNote(plain.entity, plain.fragment), false);

  writeFileSync(join(root, 'notebook', 'text.md'), front('text'), 'utf8');
  assert.throws(
    () => buildPrivateNotes({ ...config, privateNotesDir: join(root, 'notebook') }),
    /text\.md: 'exposure' must be semantic, locator, or none \(got "text"\)/,
  );
});

test('corpus: the public-safe lint rejects traveling fields that quote private text', () => {
  const body =
    'The bridge originally modulated up a whole step and we scrapped it in the second session.';

  // A 5-word run of the body in a label is a quotation, not a pointer.
  assert.throws(
    () =>
      assertPublicSafeField('Notes: originally modulated up a whole step', {
        field: 'label',
        path: 'n.md',
        privateText: body,
      }),
    /n\.md: 'label' quotes private text at words 2–6: a traveling field must not contain 5 consecutive words/,
  );
  // Four shared words is citation-grade overlap and passes — the demo
  // corpus's own locators depend on exactly this margin (PUBLIC_SAFE_NGRAM_WORDS).
  assert.equal(
    assertPublicSafeField('modulated up a whole octave instead', {
      field: 'label',
      path: 'n.md',
      privateText: body,
    }),
    'modulated up a whole octave instead',
  );
  // Normalization sees through case and punctuation.
  assert.throws(
    () =>
      assertPublicSafeField('Originally, MODULATED — up; a WHOLE…', {
        field: 'locator',
        path: 'n.md',
        privateText: body,
      }),
    /quotes private text/,
  );

  assert.throws(
    () => assertPublicSafeField('two\nlines', { field: 'label', path: 'n.md', privateText: body }),
    /single line/,
  );
  assert.throws(
    () =>
      assertPublicSafeField('x'.repeat(PUBLIC_SAFE_MAX_CHARS + 1), {
        field: 'label',
        path: 'n.md',
        privateText: body,
      }),
    /max 120/,
  );
  assert.throws(
    () => assertPublicSafeField('   ', { field: 'locator', path: 'n.md', privateText: body }),
    /must not be empty/,
  );

  // The bundled corpora hold their own bar: every shipped label and locator
  // passes the lint (buildPrivateNotes runs it on every note it returns).
  assert.ok(buildPrivateNotes(config).length > 0);
  const demoDirs = ['./demo/corpus/private', './demo/corpus/synthetic'];
  for (const privateNotesDir of demoDirs) {
    assert.ok(buildPrivateNotes({ ...config, privateNotesDir }).length > 0);
  }
});

test('corpus: stripMarkdown flattens syntax but keeps link text', () => {
  assert.equal(stripMarkdown('# Title\n\n**bold** and [a link](https://x.com).'), 'Title bold and a link.');
});

test('corpus: embedText includes title, summary, themes, and body', () => {
  const text = embedText(makeRecord());
  for (const piece of ['On Listening', 'Attention before opinion.', 'Themes: attention', 'suspending']) {
    assert.ok(text.includes(piece), `missing: ${piece}`);
  }
});

test('embedding: truncation is UTF-8 safe and batching respects both limits', () => {
  const truncated = truncateForEmbedding('é'.repeat(MAX_INPUT_BYTES));
  assert.ok(Buffer.byteLength(truncated, 'utf8') <= MAX_INPUT_BYTES);
  assert.ok(!truncated.includes('�'));

  const big = 'x'.repeat(600 * 1024);
  const batches = batchInputs([
    { id: 'a', text: big },
    { id: 'b', text: big },
    { id: 'c', text: 'small' },
  ]);
  assert.equal(batches.length, 2); // a alone won't fit with b under 1 MB
});

test('retrieve: cosine, boosts, score floor, and the two-stream split', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.ok(containsPhrase('what about snow today', 'snow'));
  assert.ok(!containsPhrase('what about snow today', 'now'));

  const close = recordEntry(makeRecord(), [1, 0]);
  const named = recordEntry(
    makeRecord({ id: 'song:paper-crown', slug: 'paper-crown', title: 'Paper Crown', themes: [] }),
    [0.8, 0.6],
  );
  const far = recordEntry(makeRecord({ id: 'essay:far', slug: 'far', title: 'Far' }), [0, 1]);
  const note = noteEntry(makeNote(), [0.9, 0.45]);

  const hits = retrieve([1, 0], 'what is paper crown about', indexOf([close, named, far, note]));
  const { public: pub, private: priv } = partitionByRaw(hits);
  // Exact title match outranks the pure semantic neighbor; weak hit floored out.
  assert.deepEqual(pub.map((h) => h.entity.id), ['song:paper-crown', 'essay:on-listening']);
  assert.equal(pub[0]!.breakdown.exactMatch, 0.3);
  assert.ok(pub[0]!.cosine < pub[0]!.score);
  // Notes are capped as their own layer — present, never crowded out by records —
  // and under the default plugins they ride on cosine alone (2.x behaviour).
  assert.deepEqual(priv.map((h) => h.entity.id), ['note:harbor-lights-session']);
  assert.deepEqual(Object.keys(priv[0]!.breakdown), ['cosine']);
});

test('retrieve: theme boost rewards curated frontmatter vocabulary', () => {
  const themed = recordEntry(makeRecord(), [1, 0]);
  const plain = recordEntry(
    makeRecord({ id: 'essay:other', slug: 'other', title: 'Other', themes: [] }),
    [1, 0],
  );
  const hits = retrieve([1, 0], 'where is attention discussed', indexOf([plain, themed]));
  assert.equal(hits[0]!.entity.id, 'essay:on-listening');
  assert.ok(hits[0]!.score > hits[1]!.score);
  assert.equal(hits[0]!.breakdown.theme, 0.15);
  const unthemed = retrieve([1, 0], 'where is focus discussed', indexOf([plain, themed]));
  assert.ok(unthemed.every((h) => h.breakdown.theme === undefined));
});

test('no-leak: project() crosses a private hit as WHERE and structurally cannot carry the text', () => {
  const note = makeNote();
  const index = indexOf([recordEntry(makeRecord(), [1, 0]), noteEntry(note, [1, 0])]);
  const hits = retrieve([1, 0], 'q', index).map(project);

  const privateHit = hits.find((h) => h.raw === 'private')!;
  assert.equal(privateHit.exposure, 'locator');
  assert.equal(privateHit.locatorLabel, 'notebook, p. 12');
  assert.equal(privateHit.entity.title, note.label);
  assert.ok(!('text' in privateHit));
  // The boundary, asserted: the private prose never travels. (The label may
  // repeat the title — that is the author's per-note choice, linted at build.)
  assert.ok(!JSON.stringify(privateHit).includes('modulated'));
  // Private hits carry a coarse score and no breakdown (CONTRACT.md §4).
  assert.equal(privateHit.breakdown, undefined);
  assert.equal(privateHit.score, 1);

  const publicHit = hits.find((h) => h.raw === 'public')!;
  assert.equal(publicHit.exposure, 'text');
  assert.ok(publicHit.exposure === 'text' && publicHit.text.includes('suspending the verdict'));
  assert.equal(publicHit.breakdown?.cosine, 1);

  const evidence = toAnswerEvidence(hits);
  assert.ok(!JSON.stringify(evidence.hints).includes('modulated'));
  assert.deepEqual(evidence.hints, [
    { hintId: 'note:harbor-lights-session#notebook-p-12', label: note.label, url: note.url, locator: 'notebook, p. 12' },
  ]);
  assert.deepEqual(evidence.gists, {}); // a locator hit has no gist to carry
  assert.equal(evidence.records[0]!.id, 'essay:on-listening#whole');
});

test('no-leak: a semantic hit carries its gist beside the hints, never in the prompt, and search() skips none', () => {
  const gist = assertSemanticProjection('A session note about changing the key of a bridge.', {
    path: 't',
    fragmentText: 'The bridge originally modulated up a whole step.',
  });
  const note = makeNote({ exposure: 'semantic' });
  const file = indexFileFromLegacyEntries([recordEntry(makeRecord(), [1, 0]), noteEntry(note, [1, 0])]);
  // The build attaches the projection and resolves again; do the same by hand.
  const semantic = file.entries.find((e) => e.fragment.disclosure.raw === 'private')!;
  semantic.fragment.projection = {
    lint: 'passed',
    gist,
    source: 'generated',
    review: 'unreviewed',
    contentHash: 'h',
  };
  semantic.fragment.disclosure = { raw: 'private', exposure: 'semantic' };
  const hits = search([1, 0], 'q', buildRetrievalIndex(file));
  const hit = hits.find((h) => h.raw === 'private')!;
  assert.equal(hit.exposure, 'semantic');
  assert.ok(hit.exposure === 'semantic' && hit.gist === gist && hit.gistSource === 'generated');

  const evidence = toAnswerEvidence(hits);
  assert.equal(evidence.hints.length, 1);
  assert.ok(!JSON.stringify(evidence.hints).includes('changing the key'));
  assert.deepEqual(evidence.gists, { 'note:harbor-lights-session#notebook-p-12': gist });
  // The prompt builder's signature takes records and hints: the gist has no way in.
  const user = buildUserPrompt('how was the bridge written?', evidence.records, evidence.hints);
  assert.ok(!user.includes('changing the key'));
  assert.ok(!user.includes('modulated'));
  // The template renders it after the mode is final, after the fixed sentence.
  const cite = { kind: 'hint' as const, hintId: 'note:harbor-lights-session#notebook-p-12', url: note.url };
  const answer = finalizeAnswer({ mode: 'related-material', answer: 'The note says it modulated.', citations: [cite] }, evidence);
  assert.match(
    answer.answer,
    /^There is private material related to this: Harbor Lights — writing session \(notebook, p\. 12\)\. It can't be quoted here — the citation links to the public page it belongs to\. What Harbor Lights — writing session \(notebook, p\. 12\) is about, as a description the author authorized \(not a quotation\): A session note about changing the key of a bridge\.$/,
  );
  assert.ok(!answer.answer.includes('modulated'));

  // A `none` fragment is in the private index and is never served: retrieve() sees it, search() does not.
  const none = indexFileFromLegacyEntries([noteEntry(makeNote({ id: 'note:hidden', exposure: 'none' }), [1, 0])]);
  assert.equal(none.entries[0]!.fragment.disclosure.exposure, 'none');
  const index = buildRetrievalIndex(none);
  assert.equal(retrieve([1, 0], 'q', index).length, 1);
  assert.deepEqual(search([1, 0], 'q', index), []);
  // Naming exposures explicitly still cannot ask for `none`.
  assert.throws(() => search([1, 0], 'q', index, { filters: { exposure: ['none' as never] } }), /not a served exposure/);
});

test('prompt: renders records with bodies and hints without text', () => {
  const system = buildSystemPrompt(config);
  assert.ok(system.includes(config.archiveName));
  assert.ok(system.includes(config.authorName));
  assert.ok(system.includes('Canon vs process'));
  assert.ok(system.includes('hints are NEVER evidence'));

  const { hints } = toAnswerEvidence(retrieve([1, 0], 'q', indexOf([noteEntry(makeNote(), [1, 0])])).map(project));
  const user = buildUserPrompt('why listen?', [makeRecord()], hints);
  assert.ok(user.includes('recordId: essay:on-listening'));
  assert.ok(user.includes('suspending the verdict')); // record body travels
  assert.ok(user.includes('hintId: note:harbor-lights-session#notebook-p-12'));
  assert.ok(user.includes('notebook, p. 12'));
  assert.ok(!user.includes('modulated')); // private text cannot appear

  const long = makeRecord({ body: 'x'.repeat(MAX_PROMPT_BODY_CHARS + 500) });
  assert.ok(buildUserPrompt('q', [long], []).includes('[…truncated]'));
});

test('answer: validateAnswer enforces the mode/answer contract in both directions', () => {
  const good = validateAnswer({
    mode: 'supported',
    answer: 'Listening comes first.',
    citations: [RECORD_CITE, HINT_CITE],
  });
  assert.equal(good.mode, 'supported');

  assert.throws(() => validateAnswer({ mode: 'maybe', answer: '', citations: [] }), /not a valid mode/);
  assert.throws(() => validateAnswer({ mode: 'not-found', answer: 'guess', citations: [] }), /no prose/);
  assert.throws(() => validateAnswer({ mode: 'partial', answer: '  ', citations: [] }), /requires prose/);
  assert.throws(() => validateAnswer({ mode: 'supported', answer: '', citations: [HINT_CITE] }), /requires prose/);
  // The one deliberate gap: related-material prose is engine-rendered, so
  // the model may (and, told the prose is standardized, often does) leave it
  // empty. finalizeAnswer re-enforces the prose contract after templating.
  assert.equal(
    validateAnswer({ mode: 'related-material', answer: '', citations: [HINT_CITE] }).mode,
    'related-material',
  );
});

test('answer: mode is derived from the citation mix, not taken on faith', () => {
  assert.equal(deriveMode([RECORD_CITE, HINT_CITE]), 'supported');
  assert.equal(deriveMode([RECORD_CITE]), 'partial');
  assert.equal(deriveMode([HINT_CITE]), 'related-material');
  assert.equal(deriveMode([]), 'not-found');

  // The model claimed 'supported' citing only a record: repair downgrades.
  const repaired = repairCitationsToEvidence(
    { mode: 'supported', answer: 'x', citations: [RECORD_CITE] },
    evidenceOf([makeRecord()], [makeNote()]),
  );
  assert.equal(repaired.mode, 'partial');

  // 'supported' with no citations derives to not-found — and the contract
  // travels with the mode: the orphaned prose is cleared too.
  const cleared = repairCitationsToEvidence(
    { mode: 'supported', answer: 'orphaned prose', citations: [] },
    evidenceOf([makeRecord()]),
  );
  assert.deepEqual(cleared, { mode: 'not-found', answer: '', citations: [] });
  assertCitationsGroundedInEvidence(cleared, evidenceOf([makeRecord()]));
});

test('answer: repair snaps mangled citations, converts wrong kinds, dedupes', () => {
  const evidence = evidenceOf([makeRecord()], [makeNote()]);

  // Right id, wrong url; plus the same record cited again by url only.
  const repaired = repairCitationsToEvidence(
    {
      mode: 'partial',
      answer: 'x',
      citations: [
        { kind: 'record', recordId: 'essay:on-listening', url: 'https://wrong.example/' },
        { kind: 'record', recordId: 'bogus', url: 'https://example.com/essays/on-listening/' },
      ],
    },
    evidence,
  );
  assert.equal(repaired.citations.length, 1);
  assertCitationsGroundedInEvidence(repaired, evidence);

  // The note's public URL cited as a record: repair converts it to a hint.
  const converted = repairCitationsToEvidence(
    {
      mode: 'partial',
      answer: 'x',
      citations: [{ kind: 'record', recordId: 'nope', url: 'https://example.com/lyrics/harbor-lights/' }],
    },
    evidence,
  );
  assert.deepEqual(converted.citations, [HINT_CITE]);
  assert.equal(converted.mode, 'related-material');
});

test('answer: repair does not guess among hints that share a url', () => {
  const sharedUrl = 'https://example.com/lyrics/harbor-lights/';
  const evidence = evidenceOf(
    [makeRecord()],
    [
      makeNote({ id: 'note:harbor-lights-session', url: sharedUrl }),
      makeNote({ id: 'note:harbor-lights-overdub', url: sharedUrl, locator: 'studio log, p. 4' }),
    ],
  );

  const ambiguousHint = repairCitationsToEvidence(
    {
      mode: 'related-material',
      answer: 'x',
      citations: [{ kind: 'hint', hintId: 'note:wrong', url: sharedUrl }],
    },
    evidence,
  );
  assert.deepEqual(ambiguousHint.citations, [{ kind: 'hint', hintId: 'note:wrong', url: sharedUrl }]);
  assert.throws(() => assertCitationsGroundedInEvidence(ambiguousHint, evidence), /does not match/);

  const ambiguousKindConversion = repairCitationsToEvidence(
    {
      mode: 'partial',
      answer: 'x',
      citations: [{ kind: 'record', recordId: 'record:wrong-kind', url: sharedUrl }],
    },
    evidence,
  );
  assert.deepEqual(ambiguousKindConversion.citations, [{ kind: 'record', recordId: 'record:wrong-kind', url: sharedUrl }]);
  assert.throws(() => assertCitationsGroundedInEvidence(ambiguousKindConversion, evidence), /does not match/);
});

test('answer: grounding rejects invented citations and mode/mix mismatches', () => {
  const evidence = evidenceOf([makeRecord()], [makeNote()]);

  assert.throws(
    () =>
      assertCitationsGroundedInEvidence(
        { mode: 'partial', answer: 'x', citations: [{ kind: 'record', recordId: 'essay:invented', url: 'https://x.com/' }] },
        evidence,
      ),
    /does not match/,
  );
  assert.throws(
    () => assertCitationsGroundedInEvidence({ mode: 'partial', answer: 'x', citations: [] }, evidence),
    /must cite/,
  );
  assert.throws(
    () => assertCitationsGroundedInEvidence({ mode: 'not-found', answer: '', citations: [RECORD_CITE] }, evidence),
    /no citations/,
  );
  assert.throws(
    () =>
      assertCitationsGroundedInEvidence(
        { mode: 'supported', answer: 'x', citations: [RECORD_CITE] },
        evidence,
      ),
    /does not match its citation mix/,
  );
});

test('public-safe: the related-material template points, never asserts', () => {
  const hints = [
    hintOf(makeNote()),
    hintOf(
      makeNote({ id: 'note:paper-crown-draft', label: 'Paper Crown — early draft', locator: 'notebook, p. 31' }),
    ),
  ];

  assert.equal(
    renderRelatedMaterialAnswer([HINT_CITE], hints),
    'There is private material related to this: Harbor Lights — writing session ' +
      "(notebook, p. 12). It can't be quoted here — the citation links to the " +
      'public page it belongs to.',
  );
  const both = renderRelatedMaterialAnswer(
    [HINT_CITE, { kind: 'hint', hintId: 'note:paper-crown-draft', url: 'https://example.com/lyrics/harbor-lights/' }],
    hints,
  );
  assert.ok(both.includes('notebook, p. 12'));
  assert.ok(both.includes('Paper Crown — early draft (notebook, p. 31)'));
  assert.ok(both.includes('citations link to the public pages'));
  // The prose never carries a raw URL — the citation object does (gold q07).
  assert.ok(!/https?:\/\//.test(both));

  assert.throws(() => renderRelatedMaterialAnswer([], hints), /at least one hint citation/);
  assert.throws(() => renderRelatedMaterialAnswer([RECORD_CITE], hints), /at least one hint citation/);
  assert.throws(
    () => renderRelatedMaterialAnswer([{ kind: 'hint', hintId: 'note:unknown', url: 'https://x.com/' }], hints),
    /matches no hint in evidence/,
  );
});

test('answer: finalizeAnswer makes related-material prose deterministic', () => {
  const evidence = evidenceOf([makeRecord()], [makeNote()]);

  // A confabulated summary of the private note — real hint citation, fake
  // backing. Before A2 this passed the gate verbatim; now the prose cannot
  // survive into the mode.
  const confabulated = finalizeAnswer(
    {
      mode: 'related-material',
      answer: 'The note says the bridge originally modulated up a whole step.',
      citations: [HINT_CITE],
    },
    evidence,
  );
  assert.equal(confabulated.mode, 'related-material');
  assert.ok(!confabulated.answer.includes('modulated'));
  assert.match(confabulated.answer, /^There is private material related to this/);
  assert.ok(confabulated.answer.includes('notebook, p. 12'));

  // An answer that only BECOMES related-material through repair's kind
  // conversion is templated too.
  const converted = finalizeAnswer(
    {
      mode: 'partial',
      answer: 'The notebook explains the whole step change.',
      citations: [{ kind: 'record', recordId: 'nope', url: 'https://example.com/lyrics/harbor-lights/' }],
    },
    evidence,
  );
  assert.equal(converted.mode, 'related-material');
  assert.match(converted.answer, /^There is private material related to this/);
  assert.ok(!converted.answer.includes('whole step'));

  // Record-backed prose is untouched — the template governs one mode only.
  const partial = finalizeAnswer(
    { mode: 'partial', answer: 'Listening means suspending the verdict.', citations: [RECORD_CITE] },
    evidence,
  );
  assert.equal(partial.answer, 'Listening means suspending the verdict.');
  const supported = finalizeAnswer(
    { mode: 'supported', answer: 'Canon plus a session moment.', citations: [RECORD_CITE, HINT_CITE] },
    evidence,
  );
  assert.equal(supported.answer, 'Canon plus a session moment.');

  // Refusals pass through bare.
  assert.deepEqual(
    finalizeAnswer({ mode: 'not-found', answer: '', citations: [] }, evidence),
    { mode: 'not-found', answer: '', citations: [] },
  );

  // The empty-prose path end to end (the shape the model actually returns
  // once told its related-material prose is standardized): validate admits
  // it, finalize renders the template.
  const emptyProse = finalizeAnswer(
    validateAnswer({ mode: 'related-material', answer: '', citations: [HINT_CITE] }),
    evidence,
  );
  assert.match(emptyProse.answer, /^There is private material related to this/);

  // But the gap does not leak past the mode it exists for: if repair
  // re-derives an empty-prose answer OUT of related-material, the sourced
  // prose contract is enforced at the door...
  assert.throws(
    () =>
      finalizeAnswer(
        { mode: 'related-material', answer: '', citations: [RECORD_CITE] },
        evidence,
      ),
    /'partial' answer requires prose/,
  );
  // ...and with no citations at all it normalizes to a bare refusal.
  assert.deepEqual(
    finalizeAnswer({ mode: 'related-material', answer: '', citations: [] }, evidence),
    { mode: 'not-found', answer: '', citations: [] },
  );
});

test('store: index file round-trips; unversioned or malformed files fail fast', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ae-store-'));
  const path = join(dir, 'index.json');
  const entries = [recordEntry(makeRecord(), [1, 0]), noteEntry(makeNote(), [0, 1])];

  writeIndexFile(entries, path);
  assert.deepEqual(readIndexFile(path), entries);
  assert.deepEqual(readIndexFile(join(dir, 'missing.json')), []);

  // Pre-versioning shape (a bare array) and junk both get the rebuild message.
  writeFileSync(path, JSON.stringify(entries), 'utf8');
  assert.throws(() => readIndexFile(path), /not schema version 4.*npm run index/);
  writeFileSync(path, 'not json', 'utf8');
  assert.throws(() => readIndexFile(path), /not valid JSON/);

  // Versioned but structurally bad entries get the rebuild message too.
  writeFileSync(
    path,
    JSON.stringify({ version: 4, entities: [], entries: [{ fragment: { id: 'x' }, model: 'm' }] }),
    'utf8',
  );
  assert.throws(() => readIndexFile(path), /malformed entry.*npm run index/);

  // A fragment claiming the unrepresentable cell (private + text) under a v4
  // header fails the same way: the cell is checked at load, not trusted.
  writeFileSync(
    path,
    JSON.stringify({
      version: 4,
      entities: [{ id: 'note:x', type: 'note', title: 'x', url: 'https://example.com/x/', attribution: [], identifiers: [], disclosure: { raw: 'private', exposure: 'locator' } }],
      entries: [{ model: 'm', dimensions: 1, vector: [1], contentHash: 'h', fragment: { id: 'note:x#n', entityId: 'note:x', locator: [{ scheme: 'note', value: 'p. 1' }], text: 'secret', disclosure: { raw: 'private', exposure: 'text' } } }],
    }),
    'utf8',
  );
  assert.throws(() => readIndexFile(path), /malformed entry.*npm run index/);

  // A v3 file is pointed at the migration, not at a paid rebuild.
  writeFileSync(path, JSON.stringify({ version: 3, entries }), 'utf8');
  assert.throws(() => readIndexFile(path), /schema version 3, not schema version 4.*migrate:index/);
});

test('store: assertHomogeneousIndex rejects mixed embedding specs', () => {
  const a = recordEntry(makeRecord(), [1, 0]);
  const b = { ...noteEntry(makeNote(), [1, 0]), model: 'other-model' };
  assertHomogeneousIndex([a, a]);
  assert.throws(() => assertHomogeneousIndex([a, b]), /mixes embedding specs/);
});

test('eval: gold set loads, substitutes the author, and only references real sources', () => {
  const gold = loadGold('eval/gold.yaml', config.authorName);
  assert.ok(gold.length >= 8);
  // All four modes must stay represented — including 'supported', whose
  // free prose citing a hint is the residue the A2 template can't close.
  for (const mode of ['supported', 'partial', 'related-material', 'not-found'] as const) {
    assert.ok(
      gold.some((g) => g.expectAnswerMode === mode),
      `gold set must include an '${mode}' case`,
    );
  }
  // {{author}} placeholders resolve to the configured name.
  assert.ok(gold.some((g) => g.query.includes(config.authorName)));
  assert.ok(!gold.some((g) => g.query.includes('{{author}}')));

  const ids = new Set([
    ...buildCorpus(config).map((r) => r.id),
    ...buildPrivateNotes(config).map((n) => n.id),
  ]);
  for (const g of gold) {
    assert.ok(g.id.length > 0, 'each gold query needs an id');
    for (const id of [...(g.expectSources ?? []), ...(g.forbidSources ?? [])]) {
      assert.ok(ids.has(id), `gold references unknown source '${id}'`);
    }
  }
  const goldIds = gold.map((g) => g.id);
  assert.equal(new Set(goldIds).size, goldIds.length, 'gold ids must be unique');

  // The canary list is the private wording the queries forbid, in one place,
  // and every canary is absent from every public record.
  const { canaries } = loadGoldFile('eval/gold.yaml', config.authorName);
  assert.ok(canaries.length >= 4);
  for (const r of buildCorpus(config)) {
    for (const c of canaries) assert.ok(!new RegExp(c, 'i').test(embedText(r)), `canary /${c}/ appears in public record ${r.id}`);
  }
  const forbidden = new Set(gold.flatMap((g) => g.forbidAnswerPatterns ?? []));
  for (const c of canaries) assert.ok(forbidden.has(c), `canary /${c}/ should also be a forbidAnswerPattern somewhere`);
});

test('eval: the canary sweep checks every served gist and each entity\'s gists together', () => {
  const lint = (text: string, fragmentText: string) => assertSemanticProjection(text, { path: 't', fragmentText });
  const projection = (gist: ReturnType<typeof lint>) => ({
    lint: 'passed' as const,
    gist,
    source: 'generated' as const,
    review: 'unreviewed' as const,
    contentHash: 'h',
  });
  const entry = (id: string, entityId: string, exposure: 'semantic' | 'locator', gist?: ReturnType<typeof lint>) => ({
    fragment: {
      id,
      entityId,
      disclosure: { raw: 'private' as const, exposure },
      ...(gist !== undefined ? { projection: projection(gist) } : {}),
    },
  });
  const clean = lint('A note about a key change in a bridge.', 'The bridge originally modulated up a whole step.');
  const leaky = lint('The ferry horn sounds as the keeper waits.', 'Some other private text entirely.');
  const half1 = lint('A note on the lighthouse.', 'x');
  const half2 = lint('Keeper of the light appears later.', 'y');
  const unspaced = lint('署名の重みに気づく女性の場面。', 'z');

  const index = {
    entries: [
      entry('note:a#1', 'note:a', 'semantic', clean),
      entry('note:b#1', 'note:b', 'semantic', leaky),
      entry('note:c#1', 'note:c', 'semantic', half1),
      entry('note:c#2', 'note:c', 'semantic', half2),
      entry('note:d#1', 'note:d', 'locator', leaky), // not served as a gist: resolved locator
      entry('note:e#1', 'note:e', 'semantic', unspaced),
    ],
  };
  const canaries = ['ferry horn', 'lighthouse\\.? keeper', '署名の重み'];
  const sweep = sweepCanaries(index, canaries);
  assert.equal(sweep.gists, 5);
  assert.equal(sweep.pass, false);
  assert.deepEqual(sweep.issues, [
    "canary /ferry horn/ appears in the served gist of 'note:b#1'",
    "canary /署名の重み/ appears in the served gist of 'note:e#1'",
    "canary /lighthouse\\.? keeper/ appears across the served gists of 'note:c' (composition)",
  ]);
  assert.deepEqual(sweepCanaries({ entries: [entry('note:a#1', 'note:a', 'semantic', clean)] }, canaries), {
    pass: true,
    issues: [],
    gists: 1,
  });
  assert.equal(sweepCanaries(index, []).pass, true);

  // loadGoldFile validates the list.
  const dir = mkdtempSync(join(tmpdir(), 'ae-gold-'));
  const good = join(dir, 'good.yaml');
  writeFileSync(good, 'canaries: [one]\nqueries:\n  - id: a\n    query: q\n    expectAnswerMode: not-found\n', 'utf8');
  assert.deepEqual(loadGoldFile(good).canaries, ['one']);
  const bad = join(dir, 'bad.yaml');
  writeFileSync(bad, 'canaries: ["("]\nqueries:\n  - id: a\n    query: q\n    expectAnswerMode: not-found\n', 'utf8');
  assert.throws(() => loadGoldFile(bad), /canaries contains invalid regex/);
  const shape = join(dir, 'shape.yaml');
  writeFileSync(shape, 'canaries: nope\nqueries:\n  - id: a\n    query: q\n    expectAnswerMode: not-found\n', 'utf8');
  assert.throws(() => loadGoldFile(shape), /'canaries' must be a list/);
});

test('eval: judgeRetrieval and judgeAnswer enforce the gold contract', () => {
  const hits = retrieve([1, 0], 'q', indexOf([recordEntry(makeRecord(), [1, 0]), noteEntry(makeNote(), [1, 0])]));
  const gold = {
    id: 'test',
    query: 'q',
    expectAnswerMode: 'supported' as const,
    expectSources: ['essay:on-listening', 'note:harbor-lights-session'],
    forbidSources: ['song:paper-crown'],
  };
  assert.equal(judgeRetrieval(gold, hits).pass, true);
  assert.match(
    judgeRetrieval({ ...gold, expectSources: ['essay:missing'] }, hits).issues[0]!,
    /expected source 'essay:missing' not retrieved/,
  );
  assert.match(
    judgeRetrieval({ ...gold, forbidSources: ['essay:on-listening'] }, hits).issues[0]!,
    /forbidden source/,
  );
  assert.equal(judgeAnswerMode(gold, 'supported').pass, true);
  assert.match(judgeAnswerMode(gold, 'not-found').issues[0]!, /expected 'supported'/);
  assert.equal(
    judgeAnswer(
      { ...gold, expectAnswerMode: 'related-material', forbidRecordCitations: true },
      {
        mode: 'related-material',
        answer: 'See the notebook.',
        citations: [{ kind: 'hint', hintId: 'note:harbor-lights-session', url: 'https://example.com' }],
      },
    ).pass,
    true,
  );
  assert.match(
    judgeAnswer(
      { id: 'test', query: 'q', expectAnswerMode: 'related-material' },
      {
        mode: 'related-material',
        answer: 'See the notebook.',
        citations: [
          { kind: 'hint', hintId: 'note:harbor-lights-session', url: 'https://example.com' },
          { kind: 'record', recordId: 'song:harbor-lights', url: 'https://example.com/song' },
        ],
      },
    ).issues[0]!,
    /hint-only citations/,
  );
  assert.match(
    judgeAnswer(
      {
        id: 'test',
        query: 'q',
        expectAnswerMode: 'related-material',
        forbidAnswerPatterns: ['https?://'],
      },
      {
        mode: 'related-material',
        answer: 'See https://example.com/lyrics/harbor-lights/',
        citations: [{ kind: 'hint', hintId: 'note:harbor-lights-session', url: 'https://example.com' }],
      },
    ).issues[0]!,
    /forbidden pattern/,
  );
  assert.match(
    judgeAnswer(
      { ...gold, expectAnswerMode: 'partial' },
      {
        mode: 'partial',
        answer: 'From the song.',
        citations: [
          { kind: 'record', recordId: 'song:harbor-lights', url: 'https://example.com/song' },
          { kind: 'hint', hintId: 'note:harbor-lights-session', url: 'https://example.com' },
        ],
      },
    ).issues[0]!,
    /record-only citations/,
  );
  // expectAnswerPatterns is the must-match mirror: every pattern must hit.
  const routed = {
    mode: 'related-material' as const,
    answer: 'There is private material related to this: notebook, p. 12.',
    citations: [
      { kind: 'hint' as const, hintId: 'note:harbor-lights-session', url: 'https://example.com' },
    ],
  };
  assert.equal(
    judgeAnswer(
      {
        id: 'test',
        query: 'q',
        expectAnswerMode: 'related-material',
        expectAnswerPatterns: ['^There is private material', 'notebook, p\\. 12'],
      },
      routed,
    ).pass,
    true,
  );
  assert.match(
    judgeAnswer(
      {
        id: 'test',
        query: 'q',
        expectAnswerMode: 'related-material',
        expectAnswerPatterns: ['notebook, p\\. 31'],
      },
      routed,
    ).issues[0]!,
    /did not match expected pattern/,
  );
});

test('eval: parseQueryIdList and filterGoldQueries support targeted runs', () => {
  const sample = [
    {
      id: 'q06',
      query: 'staying',
      expectAnswerMode: 'partial' as const,
      expectSources: ['song:harbor-lights'],
    },
    {
      id: 'q07',
      query: 'bridge',
      expectAnswerMode: 'related-material' as const,
      expectSources: ['note:harbor-lights-session'],
    },
  ];
  assert.deepEqual(parseQueryIdList('q06, q07'), ['q06', 'q07']);
  assert.equal(filterGoldQueries(sample, { ids: ['q07'] }).length, 1);
  assert.throws(() => filterGoldQueries(sample, { ids: ['q99'] }), /unknown gold query id/);
  assert.throws(
    () => filterGoldQueries(sample, { fromReportIds: ['q99'] }),
    /report references unknown gold query id/,
  );
});

test('eval: loadGold rejects invalid answer patterns at load time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gold-'));
  for (const key of ['forbidAnswerPatterns', 'expectAnswerPatterns']) {
    const path = join(dir, `gold-${key}.yaml`);
    writeFileSync(
      path,
      `queries:
  - id: q01
    query: test
    expectAnswerMode: partial
    ${key}: ['(']
`,
      'utf8',
    );
    assert.throws(() => loadGold(path), new RegExp(`${key} contains invalid regex`));
  }
});

test('eval: parseEvalReport rejects malformed result entries loudly', () => {
  assert.throws(
    () =>
      parseEvalReport(
        {
          ranAt: '2026-06-13T00:00:00.000Z',
          full: false,
          selectedTotal: 1,
          total: 1,
          passed: 0,
          failed: 1,
          results: [{}],
        },
        'bad-report.json',
      ),
    /bad-report\.json: results\[0\]\.id must be a string/,
  );
});

test('eval: parseEvalReport preserves aborted metadata for fail-fast reports', () => {
  const report = parseEvalReport({
    ranAt: '2026-06-13T00:00:00.000Z',
    full: true,
    selectedTotal: 10,
    total: 1,
    passed: 0,
    failed: 1,
    aborted: true,
    results: [
      {
        id: 'q03',
        query: 'test',
        pass: false,
        issues: ['expected source not retrieved'],
      },
    ],
  });
  assert.equal(report.aborted, true);
  assert.equal(report.selectedTotal, 10);
  assert.equal(report.total, 1);
});

test('eval: parseEvalReportJson rejects syntactically invalid JSON with path context', () => {
  assert.throws(
    () => parseEvalReportJson('{not json', 'broken-report.json'),
    /invalid eval report at broken-report\.json: not valid JSON/,
  );
});

test('eval: parseEvalReport rejects inconsistent count metadata', () => {
  assert.throws(
    () =>
      parseEvalReport(
        {
          ranAt: '2026-06-13T00:00:00.000Z',
          full: false,
          selectedTotal: 2,
          total: 2,
          passed: 2,
          failed: 0,
          results: [{ id: 'q01', query: 'a', pass: true, issues: [] }],
        },
        'counts-report.json',
      ),
    /counts-report\.json: total \(2\) does not match results\.length \(1\)/,
  );
});
