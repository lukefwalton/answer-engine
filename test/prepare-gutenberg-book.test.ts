// scripts/prepare-gutenberg-book.mjs on fixture texts in both Gutenberg
// heading layouts. The real novel is not in the repo; the script's job is to
// turn it into the demo's book file without rewriting a word, and this is
// what checks that before anyone runs it on the real file.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { config } from '../archive.config.js';
import { buildPrivateBooks } from '../src/corpus.js';

const SCRIPT = resolve('scripts/prepare-gutenberg-book.mjs');

const LAYOUT_A = [
  'The Project Gutenberg eBook of An Invented Novel',
  '',
  'Title: An Invented Novel',
  'Author: Person A',
  'Release date: January 1, 2000 [eBook #99999]',
  '',
  '*** START OF THE PROJECT GUTENBERG EBOOK AN INVENTED NOVEL ***',
  '',
  'AN INVENTED NOVEL',
  '',
  'Introduction',
  '',
  'This preface is not a chapter and must not become one.',
  '',
  '[Illustration]',
  '',
  'Chapter I',
  'The Tin Box',
  '',
  'Mara kept the ledger in a tin box under the stairs.',
  'Every entry in it was a lie she could account for.',
  '',
  '[Illustration: The box.]',
  '',
  'Chapter II.',
  'The Officer',
  '',
  'The officer arrived on a Tuesday, as Chapter 3 of the manual required.',
  '',
  'He read the list twice.',
  '',
  '*** END OF THE PROJECT GUTENBERG EBOOK AN INVENTED NOVEL ***',
  '',
  'This license text must not be in the book.',
  '',
].join('\n');

const LAYOUT_B = [
  '*** START OF THE PROJECT GUTENBERG EBOOK AN INVENTED NOVEL ***',
  '',
  '1. The Tin Box',
  '',
  'Mara kept the ledger in a tin box under the stairs.',
  '',
  '2. The Officer',
  '',
  'The officer arrived on a Tuesday.',
  '',
  '*** END OF THE PROJECT GUTENBERG EBOOK AN INVENTED NOVEL ***',
].join('\n');

function run(args: string[], input: string, extra: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ae-pg-'));
  writeFileSync(join(dir, 'novel.txt'), input);
  for (const [name, content] of Object.entries(extra)) writeFileSync(join(dir, name), content);
  const result = spawnSync(
    process.execPath,
    [SCRIPT, join(dir, 'novel.txt'), '--slug', 'an-invented-novel', '--title', 'An Invented Novel', '--author', 'Person A', '--about', 'https://example.com/novel/', ...args],
    { encoding: 'utf8', cwd: dir },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, dir };
}

test('prepare-gutenberg-book: Chapter I / title-on-next-line layout, header, preface, illustrations, and license dropped', () => {
  const { status, stdout, stderr, dir } = run(['--date', '1900', '--gutenberg', '99999', '--expect', '2', '-o', join('books', 'an-invented-novel.md')], LAYOUT_A);
  assert.equal(status, 0, stderr);
  assert.match(stderr, /2 chapters:/);
  assert.match(stderr, /1 {2}The Tin Box/);
  assert.match(stderr, /2 {2}The Officer/);
  assert.equal(stdout, '');

  const books = buildPrivateBooks({ ...config, privateBooksDir: join(dir, 'books') });
  assert.equal(books.length, 1);
  const [book] = books;
  assert.equal(book!.id, 'book:an-invented-novel');
  assert.equal(book!.title, 'An Invented Novel');
  assert.equal(book!.url, 'https://example.com/novel/');
  assert.deepEqual(book!.attribution, [{ name: 'Person A', role: 'author' }]);
  assert.equal(book!.date, '1900');
  assert.equal(book!.version, 'Project Gutenberg eBook #99999');
  assert.deepEqual(book!.identifiers, [{ scheme: 'gutenberg', value: '99999' }]);
  assert.equal(book!.exposure, 'semantic');
  assert.equal(book!.publicTitle, true);
  assert.deepEqual(
    book!.pieces.map((p) => [p.locator[0]!.value, p.heading, p.text]),
    [
      ['1', 'Chapter 1. The Tin Box', 'Mara kept the ledger in a tin box under the stairs. Every entry in it was a lie she could account for.'],
      ['2', 'Chapter 2. The Officer', 'The officer arrived on a Tuesday, as Chapter 3 of the manual required. He read the list twice.'],
    ],
  );
  const joined = book!.pieces.map((p) => p.text).join(' ');
  for (const dropped of ['preface', 'Illustration', 'license', 'Release date']) assert.ok(!joined.includes(dropped), `dropped text survived: ${dropped}`);
});

test('prepare-gutenberg-book: "1. Title" layout; --expect refuses the wrong count; --check-canaries names missing ones by index', () => {
  const ok = run(['--expect', '2'], LAYOUT_B);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^---\ntitle: "An Invented Novel"\nabout: "https:\/\/example.com\/novel\/"\nauthors:\n {2}- "Person A"\nexposure: semantic\npublicTitle: true\nmaxFragmentChars: 60000\n---\n/);
  assert.match(ok.stdout, /## Chapter 1\. The Tin Box\n\nMara kept the ledger/);
  assert.match(ok.stdout, /## Chapter 2\. The Officer\n\nThe officer arrived/);

  const wrong = run(['--expect', '3'], LAYOUT_B);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /expected 3 chapters, found 2/);

  const gold = "canaries:\n  - 'tin box under the stairs'\n  - 'a sentence that is not in the novel'\nqueries:\n  - id: x\n    query: q\n    expectAnswerMode: not-found\n";
  const canaries = run(['--check-canaries', 'gold.yaml'], LAYOUT_B, { 'gold.yaml': gold });
  assert.equal(canaries.status, 1);
  assert.match(canaries.stderr, /1 of 2 canaries in gold\.yaml do not occur in the text: indexes 1\./);
  assert.ok(!canaries.stderr.includes('not in the novel'), 'a canary is named by index, never by wording');

  const none = run([], 'no headings here at all\n');
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no chapter headings found/);
});
