// Keyless end-to-end of the demo build (demo/build-lib.ts): an invented
// fixture corpus in a temp directory, a deterministic fake embedder, and a
// scripted drafter. This is the path the keyed `npm run demo:build` runs:
// three layers from markdown, the book's gists drafted and linted, every
// disclosure resolved, vectors reused by content hash, the served view
// stripped, the canary sweep clean. No API key, no network.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadGoldFile, sweepCanaries } from '../src/evaluate.js';
import type { EmbedRequest } from '../src/embedding.js';
import type { GistDrafter, GistDraftRequest } from '../src/ingest/gist.js';
import { readProjections } from '../src/ingest/projections.js';
import { assertSemanticProjection, PublicSafeLintError } from '../src/public-safe.js';
import { readIndex, toServedIndex, validateServedIndex } from '../src/store.js';
import type { ArchiveConfig } from '../src/types.js';
import { buildDemo } from './build-lib.js';
import type { DemoBuildPaths, Embedder } from './build-lib.js';
import { readQueryVectors } from './query-vectors.js';

const CH1 =
  'Mara kept the harbour lantern ledger in a tin box under the stairs, and every entry in it was a lie she could account for. ' +
  'The box had belonged to her mother, who had kept a different kind of ledger.';
const CH2 =
  'The customs officer arrived on a Tuesday with a list of names and no appetite for breakfast. ' +
  'He read the list aloud twice, and the second time he left out her brother.';
const GIST_1 = 'A woman keeps a falsified harbour record in a container that once belonged to her mother.';
const GIST_2 = 'An official turns up early in the week carrying a roster, recites it twice, and drops one person from the second reading.';

const ESSAY_ONE = 'Harbours are where a town admits what it depends on. The quay is a ledger too, kept in rope and tar.';
const ESSAY_TWO = 'Repetition is a craft: the same knot tied a thousand times becomes a different knot.';
const SERMON = 'The tide does not forgive the harbour; it returns to it. That is the whole of the sermon, and the rest is commentary.';
const MARGIN = 'A marginal note on the tide sermon, written to sit just above the public essay on harbours.';

function fixture(options: { synthetic?: boolean; book?: boolean } = {}): { root: string; config: ArchiveConfig; paths: DemoBuildPaths } {
  const root = mkdtempSync(join(tmpdir(), 'ae-demo-build-'));
  mkdirSync(join(root, 'public', 'essays'), { recursive: true });
  mkdirSync(join(root, 'private'));
  writeFileSync(join(root, 'public', 'essays', 'one.md'), `---\ntitle: On Harbours\nsummary: The quay as a ledger.\nthemes: [harbours]\n---\n${ESSAY_ONE}\n`);
  writeFileSync(join(root, 'public', 'essays', 'two.md'), `---\ntitle: On Repetition\nsummary: Craft and the knot.\nthemes: [craft]\n---\n${ESSAY_TWO}\n`);
  writeFileSync(
    join(root, 'private', 'sermon.md'),
    `---\ntitle: "Sermon on the tide"\nlabel: "Sermon on the tide"\nabout: https://example.com/sermons/\nlocator: "sermons, I"\n---\n${SERMON}\n`,
  );
  if (options.synthetic ?? true) {
    mkdirSync(join(root, 'synthetic'));
    writeFileSync(
      join(root, 'synthetic', 'syn.md'),
      `---\ntitle: "Marginal note"\nlabel: "Marginal note"\nabout: https://example.com/sermons/\nlocator: "margin"\nsynthetic: true\n---\n${MARGIN}\n`,
    );
  }
  if (options.book ?? true) {
    mkdirSync(join(root, 'books'));
    writeFileSync(
      join(root, 'books', 'the-lantern-ledger.md'),
      `---\ntitle: The Lantern Ledger\nabout: https://example.com/books/the-lantern-ledger/\nauthors: [Person A]\nexposure: semantic\npublicTitle: true\n---\n## Chapter 1\n\n${CH1}\n\n## Chapter 2\n\n${CH2}\n`,
    );
  }
  writeFileSync(
    join(root, 'gold.yaml'),
    'queries:\n  - id: essay-one\n    query: What does the first essay say about harbours?\n    expectAnswerMode: partial\n    expectSources: [essay:one]\n' +
      '  - id: refuse\n    query: How should tensor kernels be scheduled?\n    expectAnswerMode: not-found\n',
  );
  writeFileSync(
    join(root, 'gold.synthetic.yaml'),
    'queries:\n  - id: syn-route\n    query: Where is the marginal note on the tide?\n    expectAnswerMode: related-material\n    expectSources: [note:syn]\n',
  );
  writeFileSync(
    join(root, 'gold.book.yaml'),
    "canaries:\n  - 'tin box under the stairs'\n  - 'no appetite for breakfast'\nqueries:\n  - id: book-ch1\n    query: What is kept in the tin box?\n    expectAnswerMode: related-material\n    expectSources: ['book:the-lantern-ledger#ch1']\n",
  );
  const config: ArchiveConfig = {
    archiveName: 'Fixture',
    authorName: 'Person A',
    baseUrl: 'https://example.com',
    contentRoot: root,
    collections: [{ dir: 'public/essays', urlPrefix: '/essays/', type: 'essay' }],
    privateNotesDir: join(root, 'private'),
    embeddingModel: 'fake-embed',
    answerModel: 'fake-chat',
    gist: { model: 'fake-draft', allowedNames: { 'book:the-lantern-ledger': ['Mara'] } },
  };
  const out = join(root, 'out');
  const paths: DemoBuildPaths = {
    natural: join(out, 'index.json'),
    synthetic: join(out, 'index.synthetic.json'),
    book: join(out, 'index.book.json'),
    projections: join(out, 'projections.json'),
    queryVectors: join(out, 'query-vectors.json'),
    naturalGold: join(root, 'gold.yaml'),
    syntheticGold: join(root, 'gold.synthetic.yaml'),
    bookGold: join(root, 'gold.book.yaml'),
  };
  return { root, config, paths };
}

/** Four deterministic dimensions from a hash of the text; every call recorded. */
function fakeEmbedder(): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  const embed: Embedder = async (jobs: readonly EmbedRequest[]) => {
    calls.push(jobs.map((j) => j.id));
    const out = new Map<string, number[]>();
    for (const job of jobs) {
      const digest = createHash('sha1').update(job.text).digest();
      out.set(job.id, [0, 1, 2, 3].map((i) => (digest[i]! - 128) / 128));
    }
    return out;
  };
  return Object.assign(embed, { calls });
}

/** Answers by fragment id (the same answer on a retry); every request recorded. */
function scriptedDrafter(gists: Record<string, string>): GistDrafter & { requests: GistDraftRequest[] } {
  const requests: GistDraftRequest[] = [];
  return {
    model: 'fake-draft',
    requests,
    async draft(request) {
      requests.push(request);
      const gist = gists[request.fragmentId];
      if (gist === undefined) throw new Error(`scripted drafter has no gist for '${request.fragmentId}'`);
      return gist;
    },
  };
}

function build(f: ReturnType<typeof fixture>, embed: Embedder, drafter: GistDrafter) {
  return buildDemo({
    config: f.config,
    syntheticNotesDir: join(f.root, 'synthetic'),
    bookDir: join(f.root, 'books'),
    paths: f.paths,
    embed,
    drafter,
  });
}

test('demo build: three layers from markdown; the book drafted, resolved, stripped, and swept, keyless', async () => {
  const f = fixture();
  const embed = fakeEmbedder();
  const drafter = scriptedDrafter({ 'book:the-lantern-ledger#ch1': GIST_1, 'book:the-lantern-ledger#ch2': GIST_2 });
  const summary = await build(f, embed, drafter);

  assert.deepEqual(summary.counts, { records: 2, notes: 1, syntheticNotes: 1, books: 1 });
  assert.deepEqual(summary.written, { natural: 3, spire: 1, book: 2, queries: 4 });
  assert.deepEqual(summary.embedded, { natural: 3, spire: 1, book: 2, queries: 4 });
  assert.equal(summary.drafts.drafted, 2);
  assert.deepEqual(summary.unservable, []);
  // One embedding pass over every source and query, distinguished by id.
  assert.equal(embed.calls.length, 1);
  assert.equal(embed.calls[0]!.length, 10);
  // Only the book's fragments reached the drafter: nothing else asked for a gist.
  assert.deepEqual(
    drafter.requests.map((r) => r.fragmentId),
    ['book:the-lantern-ledger#ch1', 'book:the-lantern-ledger#ch2'],
  );
  assert.deepEqual(drafter.requests[0]!.allowedNames, ['Mara']);

  const natural = readIndex(f.paths.natural);
  assert.deepEqual(natural.entities.map((e) => e.id), ['essay:one', 'essay:two', 'note:sermon']);
  assert.deepEqual(
    natural.entries.map((e) => [e.fragment.id, e.model, e.dimensions]),
    [
      ['essay:one#whole', 'fake-embed', 4],
      ['essay:two#whole', 'fake-embed', 4],
      ['note:sermon#sermons-i', 'fake-embed', 4],
    ],
  );
  const spire = readIndex(f.paths.synthetic);
  assert.deepEqual(spire.entries.map((e) => e.fragment.id), ['note:syn#margin']);

  const book = readIndex(f.paths.book);
  assert.deepEqual(book.entities.map((e) => e.id), ['book:the-lantern-ledger']);
  assert.deepEqual(book.entities[0]!.policy, { publicTitle: true });
  assert.deepEqual(book.entries.map((e) => e.fragment.id), ['book:the-lantern-ledger#ch1', 'book:the-lantern-ledger#ch2']);
  for (const entry of book.entries) {
    assert.deepEqual(entry.fragment.disclosure, { raw: 'private', exposure: 'semantic' });
    assert.equal(entry.fragment.projection?.lint, 'passed');
  }
  assert.equal(book.entries[0]!.fragment.projection?.lint === 'passed' && book.entries[0]!.fragment.projection.gist, GIST_1);
  // The author-facing file holds the same two gists.
  const projections = readProjections(f.paths.projections);
  assert.deepEqual([...projections.keys()], ['book:the-lantern-ledger#ch1', 'book:the-lantern-ledger#ch2']);

  // The served view: text gone, gists kept, strip verified by the load-time check.
  const served = validateServedIndex(toServedIndex(book), 'served');
  const serialized = JSON.stringify(served);
  for (const phrase of ['tin box under the stairs', 'no appetite for breakfast', 'The box had belonged']) {
    assert.ok(!serialized.includes(phrase), `served book must not carry: ${phrase}`);
  }
  assert.ok(served.entries.every((e) => e.fragment.text === '' && e.fragment.projection?.lint === 'passed'));
  assert.ok(serialized.includes(GIST_1) && serialized.includes(GIST_2));

  // The sweep: every released gist against the book gold's canaries.
  const { canaries } = loadGoldFile(f.paths.bookGold, 'Person A');
  const sweep = sweepCanaries(served, canaries);
  assert.deepEqual(sweep, { pass: true, issues: [], gists: 2 });

  const qv = readQueryVectors(f.paths.queryVectors);
  assert.ok(qv);
  assert.deepEqual([...qv.byId.keys()].sort(), ['book-ch1', 'essay-one', 'refuse', 'syn-route']);
  assert.equal(qv.model, 'fake-embed');
  assert.equal(qv.dimensions, 4);
});

test('demo build: a second run with nothing changed embeds nothing, drafts nothing, and rewrites the same bytes', async () => {
  const f = fixture();
  const gists = { 'book:the-lantern-ledger#ch1': GIST_1, 'book:the-lantern-ledger#ch2': GIST_2 };
  await build(f, fakeEmbedder(), scriptedDrafter(gists));
  const before = Object.fromEntries(
    Object.values(f.paths)
      .filter((p) => p.startsWith(join(f.root, 'out')))
      .map((p) => [p, readFileSync(p, 'utf8')]),
  );

  const embed = fakeEmbedder();
  const drafter = scriptedDrafter(gists);
  const summary = await build(f, embed, drafter);
  assert.equal(embed.calls.length, 0, 'nothing to embed means the embedder is never opened');
  assert.equal(drafter.requests.length, 0, 'a current gist is kept, not redrafted');
  assert.deepEqual(summary.embedded, { natural: 0, spire: 0, book: 0, queries: 0 });
  assert.equal(summary.drafts.skipped, 2);
  for (const [p, content] of Object.entries(before)) {
    assert.equal(readFileSync(p, 'utf8'), content, `${p} changed on a no-op rebuild`);
  }
});

test('demo build: an edited essay re-embeds that fragment alone; a new gold query embeds that query alone', async () => {
  const f = fixture();
  const gists = { 'book:the-lantern-ledger#ch1': GIST_1, 'book:the-lantern-ledger#ch2': GIST_2 };
  await build(f, fakeEmbedder(), scriptedDrafter(gists));
  const qvBefore = readQueryVectors(f.paths.queryVectors)!;

  writeFileSync(join(f.root, 'public', 'essays', 'one.md'), `---\ntitle: On Harbours\nsummary: The quay as a ledger.\nthemes: [harbours]\n---\n${ESSAY_ONE} A second paragraph, added later.\n`);
  // One new query, and one existing query whose text was edited under its id.
  writeFileSync(
    join(f.root, 'gold.yaml'),
    readFileSync(join(f.root, 'gold.yaml'), 'utf8').replace('How should tensor kernels be scheduled?', 'How should GPU kernels be scheduled?') +
      '  - id: essay-two\n    query: What does the second essay say about knots?\n    expectAnswerMode: partial\n    expectSources: [essay:two]\n',
  );
  const embed = fakeEmbedder();
  const summary = await build(f, embed, scriptedDrafter(gists));
  assert.deepEqual(embed.calls, [['essay:one#whole', 'query:refuse', 'query:essay-two']]);
  assert.deepEqual(summary.embedded, { natural: 1, spire: 0, book: 0, queries: 2 });

  // The untouched vectors are the committed ones, byte for byte; the edited
  // query's vector and hash moved with its text.
  const qvAfter = readQueryVectors(f.paths.queryVectors)!;
  for (const id of ['essay-one', 'syn-route', 'book-ch1']) {
    assert.deepEqual(qvAfter.byId.get(id), qvBefore.byId.get(id));
    assert.equal(qvAfter.hashes.get(id), qvBefore.hashes.get(id));
  }
  assert.notDeepEqual(qvAfter.byId.get('refuse'), qvBefore.byId.get('refuse'));
  assert.notEqual(qvAfter.hashes.get('refuse'), qvBefore.hashes.get('refuse'));
  assert.ok(qvAfter.byId.has('essay-two'));
  const natural = readIndex(f.paths.natural);
  assert.equal(natural.entries.find((e) => e.fragment.id === 'essay:two#whole')!.contentHash, natural.entries.find((e) => e.fragment.id === 'essay:two#whole')!.contentHash);
});

test('demo build: a draft that quotes fails the lint and resolves to locator; a canary in a served gist fails the sweep', async () => {
  const f = fixture();
  // The drafter quotes chapter 1 on both attempts; chapter 2 is clean.
  const quoting = `${CH1.split(' ').slice(0, 7).join(' ')}, which is what the chapter is about.`;
  const drafter = scriptedDrafter({ 'book:the-lantern-ledger#ch1': quoting, 'book:the-lantern-ledger#ch2': GIST_2 });
  const summary = await build(f, fakeEmbedder(), drafter);
  assert.equal(summary.drafts.failed, 1);
  assert.equal(summary.drafts.drafted, 1);
  assert.deepEqual(
    drafter.requests.map((r) => [r.fragmentId, r.rejected !== undefined]),
    [
      ['book:the-lantern-ledger#ch1', false],
      ['book:the-lantern-ledger#ch1', true],
      ['book:the-lantern-ledger#ch2', false],
    ],
  );
  assert.equal(summary.unservable.length, 1);
  assert.equal(summary.unservable[0]!.fragmentId, 'book:the-lantern-ledger#ch1');

  const book = readIndex(f.paths.book);
  const ch1 = book.entries.find((e) => e.fragment.id === 'book:the-lantern-ledger#ch1')!;
  const ch2 = book.entries.find((e) => e.fragment.id === 'book:the-lantern-ledger#ch2')!;
  assert.deepEqual(ch1.fragment.disclosure, { raw: 'private', exposure: 'locator' });
  assert.equal(ch1.fragment.projection?.lint, 'failed');
  assert.deepEqual(ch2.fragment.disclosure, { raw: 'private', exposure: 'semantic' });
  // Served: the failed draft is private material and does not travel.
  const served = validateServedIndex(toServedIndex(book), 'served');
  const servedCh1 = served.entries.find((e) => e.fragment.id === 'book:the-lantern-ledger#ch1')!;
  assert.equal(servedCh1.fragment.projection, undefined);
  assert.ok(!JSON.stringify(served).includes('lantern ledger in a tin'));
  assert.equal(sweepCanaries(served, loadGoldFile(f.paths.bookGold, 'Person A').canaries).gists, 1);

  // The fixture the demo rests on: a gist that quotes five words of its fragment cannot be constructed.
  assert.throws(
    () => assertSemanticProjection(`It opens: ${CH1.split(' ').slice(0, 5).join(' ')}.`, { path: 'fixture', fragmentText: CH1 }),
    PublicSafeLintError,
  );
  // And a canary that does appear in a released gist is named by index, never by wording.
  const leaking = {
    entries: [
      { fragment: { id: 'book:x#ch1', entityId: 'book:x', disclosure: { exposure: 'semantic' }, projection: { lint: 'passed', gist: 'There is a tin box under the stairs in this chapter.' } } },
    ],
  };
  const hit = sweepCanaries(leaking, ['tin box under the stairs']);
  assert.deepEqual(hit, { pass: false, issues: ["canaries[0] appears in the served gist of 'book:x#ch1'"], gists: 1 });
});

test('demo build: a layer whose artifacts exist but whose sources are gone is refused before anything is written', async () => {
  const f = fixture();
  const gists = { 'book:the-lantern-ledger#ch1': GIST_1, 'book:the-lantern-ledger#ch2': GIST_2 };
  await build(f, fakeEmbedder(), scriptedDrafter(gists));
  const snapshot = () =>
    Object.fromEntries(
      Object.values(f.paths)
        .filter((p) => p.startsWith(join(f.root, 'out')))
        .map((p) => [p, readFileSync(p, 'utf8')]),
    );
  const before = snapshot();

  // The book directory vanishes (a partial checkout): its index and its
  // gists exist, so the build refuses rather than clearing the gists and
  // leaving the index stale.
  rmSync(join(f.root, 'books'), { recursive: true });
  const embed = fakeEmbedder();
  await assert.rejects(build(f, embed, scriptedDrafter(gists)), /the book layer has no sources .* but its index exists/);
  assert.equal(embed.calls.length, 0);
  assert.deepEqual(snapshot(), before, 'nothing was written');

  // A re-cut that drops a chapter leaves its gist orphaned: named by id, refused.
  mkdirSync(join(f.root, 'books'));
  writeFileSync(
    join(f.root, 'books', 'the-lantern-ledger.md'),
    `---\ntitle: The Lantern Ledger\nabout: https://example.com/books/the-lantern-ledger/\nauthors: [Person A]\nexposure: semantic\npublicTitle: true\n---\n## Chapter 1\n\n${CH1}\n`,
  );
  await assert.rejects(
    build(f, fakeEmbedder(), scriptedDrafter(gists)),
    /carries gists for 1 fragment\(s\) that no source produces: book:the-lantern-ledger#ch2\./,
  );
  assert.deepEqual(snapshot(), before, 'nothing was written');
});

test('demo build: a layer whose directory is absent is empty, not an error', async () => {
  const f = fixture({ synthetic: false, book: false });
  const embed = fakeEmbedder();
  const drafter = scriptedDrafter({});
  const summary = await build(f, embed, drafter);
  assert.deepEqual(summary.counts, { records: 2, notes: 1, syntheticNotes: 0, books: 0 });
  assert.deepEqual(summary.written, { natural: 3, spire: 0, book: 0, queries: 2 });
  assert.ok(!existsSync(f.paths.synthetic) && !existsSync(f.paths.book) && !existsSync(f.paths.projections));
  assert.deepEqual(summary.files, [f.paths.natural, f.paths.queryVectors]);
  assert.deepEqual([...readQueryVectors(f.paths.queryVectors)!.byId.keys()].sort(), ['essay-one', 'refuse']);
  assert.equal(drafter.requests.length, 0);
});
