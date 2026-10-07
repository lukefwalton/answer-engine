// Offline tests for private books: the corpus reader cuts one markdown file
// into pieces, the adapter makes one entity with many fragments, and the
// build-time lint runs on the strings a hit would carry before anything is
// drafted or embedded. The fixture is an invented novella written for this
// file. No API key, no network.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { config } from '../archive.config.js';
import { fromPrivateBook } from '../src/adapters/teaching.js';
import type { Entity } from '../src/contract.js';
import { buildPrivateBooks } from '../src/corpus.js';
import { embedStringFor } from '../src/embed-string.js';
import { collectEntities } from '../src/ingest/collect.js';
import { resolveDisclosure } from '../src/ingest/disclosure.js';
import { project } from '../src/no-leak.js';
import { INDEX_SCHEMA_VERSION, readIndex, toServedIndex, writeIndex } from '../src/store.js';
import type { FragmentEntry } from '../src/store.js';

const CHAPTER_ONE_A =
  'Mara kept the harbour lantern ledger in a tin box under the stairs, and every entry in it was a lie she could account for.';
const CHAPTER_ONE_B = 'The box had belonged to her mother, who had kept a different kind of ledger.';
/** Two paragraphs in the file; one whitespace-collapsed text once read. */
const CHAPTER_ONE = `${CHAPTER_ONE_A} ${CHAPTER_ONE_B}`;
const CHAPTER_TWO =
  'The customs officer arrived on a Tuesday with a list of names and no appetite for breakfast. ' +
  'He read the list aloud twice, and the second time he left out her brother.';
const INTERLUDE = 'A page torn from the ledger, folded twice, the ink still legible on one side.';

function front(extra: string[] = []): string {
  return [
    '---',
    'title: The Lantern Ledger',
    'about: https://example.com/books/the-lantern-ledger/',
    'authors:',
    '  - name: Person A',
    '    role: author',
    '  - Person B',
    'version: manuscript',
    'date: 2026-03',
    'identifiers:',
    '  - scheme: isbn',
    '    value: "978-0-00-000000-0"',
    'themes: [ledgers, harbours]',
    'exposure: semantic',
    ...extra,
    '---',
  ].join('\n');
}
const FRONT = front();

const BODY = [
  '# The Lantern Ledger',
  '',
  '## Chapter 1: The Tin Box',
  '',
  CHAPTER_ONE_A,
  '',
  CHAPTER_ONE_B,
  '',
  '## Chapter 2',
  '',
  `*${CHAPTER_TWO}*`,
  '',
  '## Interlude',
  '',
  INTERLUDE,
  '',
].join('\n');

function bookDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ae-books-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, 'utf8');
  return dir;
}

function read(files: Record<string, string>) {
  return buildPrivateBooks({ ...config, privateBooksDir: bookDir(files) });
}

test('books: no privateBooksDir means no books; a missing directory fails loudly', () => {
  assert.equal(config.privateBooksDir, undefined, 'the shipped config has no books');
  assert.deepEqual(buildPrivateBooks(config), []);
  assert.throws(
    () => buildPrivateBooks({ ...config, privateBooksDir: join(tmpdir(), 'ae-books-does-not-exist') }),
    /cannot read private books at .*ae-books-does-not-exist/,
  );
});

test('books: the reader cuts one file on its headings; the title heading is the title page, not a chapter', () => {
  const [book] = read({ 'the-lantern-ledger.md': `${FRONT}\n${BODY}` });
  assert.ok(book);
  assert.equal(book.id, 'book:the-lantern-ledger');
  assert.equal(book.type, 'book');
  assert.equal(book.title, 'The Lantern Ledger');
  assert.equal(book.url, 'https://example.com/books/the-lantern-ledger/');
  assert.deepEqual(book.attribution, [
    { name: 'Person A', role: 'author' },
    { name: 'Person B', role: 'author' },
  ]);
  assert.deepEqual(book.identifiers, [{ scheme: 'isbn', value: '978-0-00-000000-0' }]);
  assert.equal(book.version, 'manuscript');
  assert.equal(book.date, '2026-03');
  assert.deepEqual(book.themes, ['ledgers', 'harbours']);
  assert.equal(book.exposure, 'semantic');
  // Three pieces: two numbered chapters and one unnumbered heading counted
  // among them. The `# The Lantern Ledger` line is not a fourth.
  assert.deepEqual(
    book.pieces.map((p) => [p.locator, p.heading]),
    [
      [[{ scheme: 'chapter', value: '1' }], 'Chapter 1: The Tin Box'],
      [[{ scheme: 'chapter', value: '2' }], 'Chapter 2'],
      [[{ scheme: 'chapter', value: '3' }], 'Interlude'],
    ],
  );
  // Markdown is stripped from the text (the emphasis around chapter 2), and
  // the paragraph break inside chapter 1 collapses as a note's body does.
  assert.equal(book.pieces[0]!.text, CHAPTER_ONE);
  assert.equal(book.pieces[1]!.text, CHAPTER_TWO);
  assert.equal(book.pieces[2]!.text, INTERLUDE);
});

test('books: maxFragmentChars sub-splits a chapter; fragmentBy: pages reads page markers', () => {
  // Chapter 1 is 200 characters of markdown in two paragraphs; chapter 2 is
  // 169 in one. At 180, only chapter 1 is cut, on its paragraph boundary.
  const [split] = read({ 'ledger.md': `${front(['maxFragmentChars: 180'])}\n${BODY}` });
  assert.ok(split);
  assert.equal(split.pieces[0]!.text, CHAPTER_ONE_A);
  assert.equal(split.pieces[1]!.text, CHAPTER_ONE_B);
  assert.deepEqual(
    split.pieces.map((p) => p.locator.map((l) => `${l.scheme}:${l.value}`).join('.')),
    ['chapter:1.section:1', 'chapter:1.section:2', 'chapter:2', 'chapter:3'],
  );

  const paged = ['---', 'title: Typeset', 'about: https://example.com/t/', 'fragmentBy: pages', '---', '<<<page 184>>>', 'First page.', '<<<page 185>>>', 'Second page.', ''].join('\n');
  const [typeset] = read({ 'typeset.md': paged });
  assert.ok(typeset);
  assert.equal(typeset.exposure, undefined);
  assert.deepEqual(
    typeset.pieces.map((p) => [p.locator, p.text]),
    [
      [[{ scheme: 'page', value: '184' }], 'First page.'],
      [[{ scheme: 'page', value: '185' }], 'Second page.'],
    ],
  );

  const formFeed = ['---', 'title: Typeset', 'about: https://example.com/t/', 'fragmentBy: pages', 'firstPage: 40', '---', 'Page forty.\fPage forty-one.'].join('\n');
  const [ff] = read({ 'ff.md': formFeed });
  assert.deepEqual(ff!.pieces.map((p) => p.locator[0]!.value), ['40', '41']);

  // A bare year is a date at year precision, not a dropped field.
  const [dated] = read({ 'd.md': '---\ntitle: D\nabout: https://example.com/d/\ndate: 1900\n---\n## Chapter 1\n\ntext\n' });
  assert.equal(dated!.date, '1900');
});

test('books: malformed frontmatter names the file and the field, never a value', () => {
  const file = (extra: string, body = '## Chapter 1\n\ntext\n') =>
    `---\ntitle: T\nabout: https://example.com/t/\n${extra}\n---\n${body}`;
  assert.throws(() => read({ 'b.md': '---\ntitle: T\n---\n## Chapter 1\n\ntext\n' }), /b\.md needs 'about'/);
  assert.throws(
    () => read({ 'b.md': file('exposure: text or the first stanza') }),
    (err: unknown) =>
      err instanceof Error && /b\.md: 'exposure' must be semantic, locator, or none\./.test(err.message) && !/stanza/.test(err.message),
  );
  assert.throws(() => read({ 'b.md': file('fragmentBy: paragraphs') }), /b\.md: 'fragmentBy' must be headings/);
  assert.throws(() => read({ 'b.md': file('maxFragmentChars: lots') }), /'maxFragmentChars' must be a positive whole number/);
  assert.throws(() => read({ 'b.md': file('firstPage: 0') }), /'firstPage' must be a positive whole number/);
  assert.throws(() => read({ 'b.md': file('publicTitle: yes please') }), /'publicTitle' must be true or false/);
  assert.throws(() => read({ 'b.md': file('requireReview: 1') }), /'requireReview' must be true or false/);
  assert.throws(() => read({ 'b.md': file('authors: Person A') }), /'authors' must be a list/);
  assert.throws(() => read({ 'b.md': file('authors:\n  - role: author') }), /an 'authors' entry needs a 'name'/);
  assert.throws(() => read({ 'b.md': file('authors:\n  - name: A\n    role: 3') }), /'role' must be a string/);
  assert.throws(() => read({ 'b.md': file('identifiers:\n  - isbn') }), /'identifiers' must be a list of \{ scheme, value \}/);
  assert.throws(() => read({ 'b.md': file('type: "a:b"') }), /'type' must be a short token/);
  assert.throws(() => read({ 'b.md': file('', '\n\n') }), /b\.md has no text after its frontmatter/);
  // A draft is skipped, as in every layer.
  assert.deepEqual(read({ 'b.md': file('draft: true') }), []);
});

test('books: the adapter yields one entity with many fragments, and the metadata lint runs first', () => {
  const [book] = read({ 'the-lantern-ledger.md': `${FRONT}\n${BODY}` });
  const pairs = fromPrivateBook(book!);
  assert.equal(pairs.length, 3);
  const entity = pairs[0]!.entity;
  assert.ok(pairs.every((p) => p.entity === entity), 'every pair carries the one entity');
  assert.deepEqual(entity, {
    id: 'book:the-lantern-ledger',
    type: 'book',
    title: 'The Lantern Ledger',
    attribution: [
      { name: 'Person A', role: 'author' },
      { name: 'Person B', role: 'author' },
    ],
    date: '2026-03',
    version: 'manuscript',
    url: 'https://example.com/books/the-lantern-ledger/',
    identifiers: [{ scheme: 'isbn', value: '978-0-00-000000-0' }],
    themes: ['ledgers', 'harbours'],
    disclosure: { raw: 'private', exposure: 'semantic' },
  } satisfies Entity);
  assert.deepEqual(
    pairs.map((p) => p.fragment.id),
    ['book:the-lantern-ledger#ch1', 'book:the-lantern-ledger#ch2', 'book:the-lantern-ledger#ch3'],
  );
  // The heading is in the text, joined as a note's title is, and the
  // embedding is the text alone: a private fragment embeds nothing else.
  const first = pairs[0]!.fragment;
  assert.equal(first.text, `Chapter 1: The Tin Box\n\n${CHAPTER_ONE}`);
  assert.equal(embedStringFor(first, entity), first.text);
  assert.deepEqual(first.locator, [{ scheme: 'chapter', value: '1' }]);
  // Every fragment carries the request; the build resolves it. Without a
  // projection, `semantic` resolves to `locator`.
  for (const { fragment } of pairs) {
    assert.deepEqual(fragment.disclosure, { raw: 'private', exposure: 'semantic' });
    assert.deepEqual(resolveDisclosure(entity, { exposure: fragment.disclosure.exposure }), { raw: 'private', exposure: 'locator' });
  }
  // collectEntities groups the pairs under the one entity.
  const grouped = collectEntities(pairs);
  assert.deepEqual([...grouped.entities.keys()], ['book:the-lantern-ledger']);
  assert.equal(grouped.fragments.get('book:the-lantern-ledger')!.length, 3);

  // The policy travels from the frontmatter.
  const [reviewed] = read({ 'r.md': `---\ntitle: R\nabout: https://example.com/r/\nrequireReview: true\npublicTitle: true\n---\n## Chapter 1\n\ntext\n` });
  assert.deepEqual(fromPrivateBook(reviewed!)[0]!.entity.policy, { publicTitle: true, requireReview: true });
  assert.equal('policy' in entity, false);
});

test('books: a title that quotes the text is refused before any build, unless the author declares it public', () => {
  const title = 'What the harbour keeps at night';
  const body = `## Chapter 1\n\nThe words what the harbour keeps at night were painted on the lid of the box.\n`;
  const front = (extra = '') => `---\ntitle: ${title}\nabout: https://example.com/w/\n${extra}---\n${body}`;
  const [quoting] = read({ 'w.md': front() });
  assert.throws(
    () => fromPrivateBook(quoting!),
    (err: unknown) => err instanceof Error && /private book 'book:w': entity 'book:w': 'title' quotes private text/.test(err.message) && !/painted/.test(err.message),
  );
  const [declared] = read({ 'w.md': front('publicTitle: true\n') });
  assert.equal(fromPrivateBook(declared!).length, 1);
  // A creator's name is checked the same way.
  const [creator] = read({ 'w.md': front('publicTitle: true\nauthors: ["the harbour keeps at night, said"]\n') });
  assert.throws(() => fromPrivateBook(creator!), /'creator name' quotes private text/);
  // Two chapters numbered the same would share an id; the reader's output is refused by locator.
  const [twice] = read({ 'w.md': `---\ntitle: W\nabout: https://example.com/w/\n---\n## Chapter 3\n\none\n\n## Chapter 3\n\ntwo\n` });
  assert.throws(() => fromPrivateBook(twice!), /private book 'book:w': two pieces share the locator 'ch. 3'/);
});

test('books: through the store, a book serves locators and never its text', () => {
  const [book] = read({ 'the-lantern-ledger.md': `${FRONT}\n${BODY}`.replace('exposure: semantic', 'exposure: locator') });
  const pairs = fromPrivateBook(book!);
  const { entities, fragments } = collectEntities(pairs);
  const entries: FragmentEntry[] = fragments.get(book!.id)!.map((fragment, i) => ({
    model: 'test-embedding',
    dimensions: 2,
    vector: [1, i],
    contentHash: `hash-${i}`,
    fragment: { ...fragment, disclosure: resolveDisclosure(entities.get(book!.id)!, { exposure: fragment.disclosure.exposure }) },
  }));
  const path = join(mkdtempSync(join(tmpdir(), 'ae-books-index-')), 'index.json');
  writeIndex({ version: INDEX_SCHEMA_VERSION, entities: [...entities.values()], entries }, path);
  const loaded = readIndex(path);
  assert.equal(loaded.entries.length, 3);
  const served = toServedIndex(loaded);
  const serialized = JSON.stringify(served);
  for (const phrase of ['tin box under the stairs', 'no appetite for breakfast', 'folded twice', 'The Tin Box']) {
    assert.ok(!serialized.includes(phrase), `served index must not carry: ${phrase}`);
  }
  assert.ok(served.entries.every((e) => e.fragment.text === '' && e.fragment.projection === undefined));
  // And a hit on it carries where, not what.
  const entry = loaded.entries[1]!;
  const hit = project({ fragment: entry.fragment, entity: entities.get(book!.id)!, cosine: 0.87, score: 0.87, breakdown: { cosine: 0.87 } });
  assert.equal(hit.exposure, 'locator');
  assert.equal(hit.locatorLabel, 'ch. 2');
  assert.equal(hit.entity.title, 'The Lantern Ledger');
  assert.equal(hit.entity.url, 'https://example.com/books/the-lantern-ledger/');
  assert.deepEqual(hit.entity.identifiers, [{ scheme: 'isbn', value: '978-0-00-000000-0' }]);
  assert.equal(hit.score, 0.85);
  assert.ok(!JSON.stringify(hit).includes('breakfast'));
});
