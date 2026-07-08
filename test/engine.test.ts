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
  parseEvalReport,
  parseEvalReportJson,
} from '../src/evaluate.js';
import { filterGoldQueries, parseQueryIdList } from '../src/eval-select.js';
import { assembleEvidence, toRoutingHint } from '../src/no-leak.js';
import {
  assertPublicSafeField,
  PUBLIC_SAFE_MAX_CHARS,
  renderRelatedMaterialAnswer,
} from '../src/public-safe.js';
import { buildSystemPrompt, buildUserPrompt, MAX_PROMPT_BODY_CHARS } from '../src/prompt.js';
import { containsPhrase, cosine, hasThemeMatch, retrieve } from '../src/retrieve.js';
import { assertHomogeneousIndex, readIndexFile, writeIndexFile } from '../src/store.js';
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

function evidenceOf(records: ArchiveRecord[], notes: PrivateNote[] = []): AnswerEvidence {
  return assembleEvidence(records, notes);
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
    /n\.md: 'label' quotes the note's private body \("originally modulated up a whole"\)/,
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
    /quotes the note's private body/,
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

  const hits = retrieve([1, 0], 'what is paper crown about', [close, named, far, note]);
  // Exact title match outranks the pure semantic neighbor; weak hit floored out.
  assert.deepEqual(hits.records.map((h) => h.record.id), ['song:paper-crown', 'essay:on-listening']);
  // Notes ride a separate stream — present, but never mixed into records.
  assert.deepEqual(hits.notes.map((h) => h.note.id), ['note:harbor-lights-session']);
});

test('retrieve: theme boost rewards curated frontmatter vocabulary', () => {
  const record = makeRecord();
  assert.ok(hasThemeMatch(record, 'where is attention discussed'));
  assert.ok(!hasThemeMatch(record, 'where is focus discussed'));

  const themed = recordEntry(record, [1, 0]);
  const plain = recordEntry(
    makeRecord({ id: 'essay:other', slug: 'other', title: 'Other', themes: [] }),
    [1, 0],
  );
  const hits = retrieve([1, 0], 'where is attention discussed', [plain, themed]);
  assert.equal(hits.records[0]!.record.id, 'essay:on-listening');
  assert.ok(hits.records[0]!.score > hits.records[1]!.score);
});

test('no-leak: a routing hint carries WHERE and structurally cannot carry the text', () => {
  const note = makeNote();
  const hint = toRoutingHint(note);
  assert.deepEqual(hint, {
    hintId: note.id,
    label: note.label,
    url: note.url,
    locator: note.locator,
  });
  // The boundary, asserted: nothing on the hint contains the private prose.
  assert.ok(!JSON.stringify(hint).includes('modulated'));

  const evidence = assembleEvidence([makeRecord()], [note]);
  assert.ok(!JSON.stringify(evidence.hints).includes('modulated'));
});

test('prompt: renders records with bodies and hints without text', () => {
  const system = buildSystemPrompt(config);
  assert.ok(system.includes(config.archiveName));
  assert.ok(system.includes(config.authorName));
  assert.ok(system.includes('Canon vs process'));
  assert.ok(system.includes('hints are NEVER evidence'));

  const user = buildUserPrompt('why listen?', [makeRecord()], [toRoutingHint(makeNote())]);
  assert.ok(user.includes('recordId: essay:on-listening'));
  assert.ok(user.includes('suspending the verdict')); // record body travels
  assert.ok(user.includes('hintId: note:harbor-lights-session'));
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
    toRoutingHint(makeNote()),
    toRoutingHint(
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
  assert.throws(() => readIndexFile(path), /not schema version 3.*npm run index/);
  writeFileSync(path, 'not json', 'utf8');
  assert.throws(() => readIndexFile(path), /not valid JSON/);

  // Versioned but structurally bad entries get the rebuild message too.
  writeFileSync(
    path,
    JSON.stringify({ version: 3, entries: [{ sourceType: 'record', record: { id: 'x' }, model: 'm' }] }),
    'utf8',
  );
  assert.throws(() => readIndexFile(path), /malformed entry.*npm run index/);

  // A v2-shaped note smuggled under a v3 header (no title) fails the same way.
  const [, v2Note] = entries;
  const { title: _title, ...v2Shape } = (v2Note as Extract<IndexEntry, { sourceType: 'note' }>).note;
  writeFileSync(
    path,
    JSON.stringify({ version: 3, entries: [{ ...v2Note, note: v2Shape }] }),
    'utf8',
  );
  assert.throws(() => readIndexFile(path), /malformed entry.*npm run index/);
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
});

test('eval: judgeRetrieval and judgeAnswer enforce the gold contract', () => {
  const hits = {
    records: [{ record: makeRecord(), score: 0.5, semantic: 0.5 }],
    notes: [{ note: makeNote(), score: 0.4, semantic: 0.4 }],
  };
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
