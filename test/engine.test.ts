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
  repairCitationsToEvidence,
  validateAnswer,
} from '../src/answer.js';
import { buildCorpus, buildPrivateNotes, embedText, stripMarkdown } from '../src/corpus.js';
import { batchInputs, truncateForEmbedding, MAX_INPUT_BYTES } from '../src/embedding.js';
import { judgeAnswer, judgeAnswerMode, judgeRetrieval, loadGold } from '../src/evaluate.js';
import { assembleEvidence, toRoutingHint } from '../src/no-leak.js';
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

function makeNote(overrides: Partial<PrivateNote> = {}): PrivateNote {
  return {
    id: 'note:harbor-lights-session',
    label: 'Harbor Lights — writing session',
    url: 'https://example.com/lyrics/harbor-lights/',
    locator: 'notebook, p. 12',
    text: 'The bridge originally modulated up a whole step.',
    ...overrides,
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

  // Private notes additionally require about + locator.
  mkdirSync(join(root, 'notebook'));
  writeFileSync(join(root, 'notebook', 'n.md'), '---\ntitle: "A note"\n---\nprivate text\n', 'utf8');
  assert.throws(
    () => buildPrivateNotes({ ...config, privateNotesDir: join(root, 'notebook') }),
    /n\.md needs 'about'.*'locator'/,
  );
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

test('store: index file round-trips; unversioned or malformed files fail fast', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ae-store-'));
  const path = join(dir, 'index.json');
  const entries = [recordEntry(makeRecord(), [1, 0]), noteEntry(makeNote(), [0, 1])];

  writeIndexFile(entries, path);
  assert.deepEqual(readIndexFile(path), entries);
  assert.deepEqual(readIndexFile(join(dir, 'missing.json')), []);

  // Pre-versioning shape (a bare array) and junk both get the rebuild message.
  writeFileSync(path, JSON.stringify(entries), 'utf8');
  assert.throws(() => readIndexFile(path), /not schema version 2.*npm run index/);
  writeFileSync(path, 'not json', 'utf8');
  assert.throws(() => readIndexFile(path), /not valid JSON/);

  // Versioned but structurally bad entries get the rebuild message too.
  writeFileSync(
    path,
    JSON.stringify({ version: 2, entries: [{ sourceType: 'record', record: { id: 'x' }, model: 'm' }] }),
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
  assert.ok(gold.some((g) => g.expectAnswerMode === 'not-found'), 'gold set must include refusals');
  assert.ok(
    gold.some((g) => g.expectAnswerMode === 'related-material'),
    'gold set must exercise the boundary',
  );
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
});
