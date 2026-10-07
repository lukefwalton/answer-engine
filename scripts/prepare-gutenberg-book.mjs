#!/usr/bin/env node
// scripts/prepare-gutenberg-book.mjs — turn a Project Gutenberg plain-text
// novel into the markdown file the demo's book layer reads
// (demo/corpus/private-books/<slug>.md): frontmatter from the flags, the
// chapters as `## Chapter N. Title` headings, everything else dropped (the
// Gutenberg header and license, any preface before the first chapter,
// `[Illustration]` markers). Nothing is rewritten: the chapter text is the
// file's, line for line.
//
// Usage:
//   node scripts/prepare-gutenberg-book.mjs pg55.txt \
//     --slug the-wonderful-wizard-of-oz --title "The Wonderful Wizard of Oz" \
//     --author "L. Frank Baum" --date 1900 --gutenberg 55 \
//     --about https://www.gutenberg.org/ebooks/55 --expect 24 \
//     --check-canaries demo/gold.book.yaml \
//     -o demo/corpus/private-books/the-wonderful-wizard-of-oz.md
//
// Chapter headings are recognised in the two layouts Gutenberg uses:
// `Chapter I` / `CHAPTER 1.` with the title on the same line or the next
// non-blank line, and `1. The Title`. A candidate counts only when its number
// is the next in sequence, so a "Chapter 3" mentioned in running text is left
// alone. The headings found are printed so they can be checked by eye;
// --expect N refuses any other count. --check-canaries reports which of a
// gold file's canaries do not occur in the prepared text (a canary that never
// occurs guards nothing).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';

function usage(message) {
  console.error(`prepare-gutenberg-book: ${message}`);
  console.error('usage: prepare-gutenberg-book.mjs <text> --slug <slug> --title <title> --author <name> [--author <name>] --about <url> [--date YYYY] [--gutenberg N] [--version <text>] [--expect N] [--max-chars N] [--check-canaries <gold.yaml>] [-o <out.md>]');
  process.exit(2);
}

function parseArgs(argv) {
  const args = { authors: [], expect: 0, maxChars: 60000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) usage(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--slug': args.slug = next(); break;
      case '--title': args.title = next(); break;
      case '--author': args.authors.push(next()); break;
      case '--about': args.about = next(); break;
      case '--date': args.date = next(); break;
      case '--gutenberg': args.gutenberg = next(); break;
      case '--version': args.version = next(); break;
      case '--expect': args.expect = Number(next()); break;
      case '--max-chars': args.maxChars = Number(next()); break;
      case '--check-canaries': args.canaries = next(); break;
      case '-o': case '--out': args.out = next(); break;
      case '-h': case '--help': usage('help'); break;
      default:
        if (a.startsWith('-')) usage(`unknown flag ${a}`);
        if (args.input) usage('one input file');
        args.input = a;
    }
  }
  if (!args.input) usage('an input text file is required');
  for (const key of ['slug', 'title', 'about']) if (!args[key]) usage(`--${key} is required`);
  if (args.authors.length === 0) usage('at least one --author is required');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(args.slug)) usage('--slug must be lower-case letters, digits, and hyphens');
  if (!Number.isInteger(args.expect) || args.expect < 0) usage('--expect must be a whole number');
  if (!Number.isInteger(args.maxChars) || args.maxChars <= 0) usage('--max-chars must be a positive whole number');
  return args;
}

const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
function chapterNumber(token) {
  if (/^\d+$/.test(token)) return Number(token);
  let total = 0;
  const upper = token.toUpperCase();
  for (let i = 0; i < upper.length; i += 1) {
    const value = ROMAN[upper[i]];
    const nextValue = ROMAN[upper[i + 1]] ?? 0;
    if (!value) return NaN;
    total += value < nextValue ? -value : value;
  }
  return total;
}

/** The text between Gutenberg's START and END markers (or the whole file). */
function body(text) {
  const lines = text.split(/\r?\n/);
  let start = lines.findIndex((l) => /^\*\*\*\s*START OF/i.test(l));
  let end = lines.findIndex((l) => /^\*\*\*\s*END OF/i.test(l));
  if (start < 0) start = -1;
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end);
}

const HEADING_A = /^\s*(?:CHAPTER|Chapter)\s+([IVXLCDMivxlcdm]+|\d+)\b\.?\s*[—:-]?\s*(.*?)\s*$/;
const HEADING_B = /^\s*(\d{1,3})\.\s+(\S.*?)\s*$/;
const ILLUSTRATION = /^\s*\[Illustration[^\]]*\]\s*$/;

/** Cut the lines into chapters. A heading counts only in sequence. */
function chapters(lines) {
  const found = [];
  let current = null;
  let expected = 1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (ILLUSTRATION.test(line)) continue;
    let m = HEADING_A.exec(line);
    let number = m ? chapterNumber(m[1]) : NaN;
    let title = m ? m[2] : '';
    if (!m || number !== expected) {
      m = HEADING_B.exec(line);
      number = m ? Number(m[1]) : NaN;
      title = m ? m[2] : '';
    }
    if (m && number === expected) {
      if (!title) {
        // The title is the next non-blank line.
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j += 1;
        if (j < lines.length && !HEADING_A.test(lines[j]) && !HEADING_B.test(lines[j])) {
          title = lines[j].trim();
          i = j;
        }
      }
      current = { number, title: title.replace(/\s+/g, ' ').trim(), lines: [] };
      found.push(current);
      expected += 1;
      continue;
    }
    if (current) current.lines.push(line);
  }
  return found;
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function frontmatter(args) {
  const lines = ['---', `title: ${yamlString(args.title)}`, `about: ${yamlString(args.about)}`, 'authors:'];
  for (const author of args.authors) lines.push(`  - ${yamlString(author)}`);
  if (args.date) lines.push(`date: ${yamlString(args.date)}`);
  if (args.version) lines.push(`version: ${yamlString(args.version)}`);
  else if (args.gutenberg) lines.push(`version: ${yamlString(`Project Gutenberg eBook #${args.gutenberg}`)}`);
  if (args.gutenberg) lines.push('identifiers:', '  - scheme: gutenberg', `    value: ${yamlString(args.gutenberg)}`);
  lines.push('exposure: semantic', 'publicTitle: true', `maxFragmentChars: ${args.maxChars}`, '---');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const text = readFileSync(args.input, 'utf8');
  const found = chapters(body(text));
  if (found.length === 0) {
    console.error('prepare-gutenberg-book: no chapter headings found (expected `Chapter I` or `1. Title` lines).');
    process.exit(1);
  }
  console.error(`${found.length} chapters:`);
  for (const c of found) console.error(`  ${String(c.number).padStart(2)}  ${c.title || '(untitled)'}  (${c.lines.join('\n').trim().length} chars)`);
  if (args.expect && found.length !== args.expect) {
    console.error(`prepare-gutenberg-book: expected ${args.expect} chapters, found ${found.length}; check the headings above.`);
    process.exit(1);
  }
  const longest = Math.max(...found.map((c) => c.lines.join('\n').trim().length));
  if (longest > args.maxChars) {
    console.error(`prepare-gutenberg-book: the longest chapter is ${longest} characters, above --max-chars ${args.maxChars}; it would be sub-split (ids like #ch8.s2). Raise --max-chars to keep one fragment per chapter.`);
    process.exit(1);
  }

  const out = [frontmatter(args), ''];
  for (const c of found) {
    out.push(`## Chapter ${c.number}${c.title ? `. ${c.title}` : ''}`, '', c.lines.join('\n').trim(), '');
  }
  const markdown = `${out.join('\n')}\n`;

  if (args.canaries) {
    const gold = parseYaml(readFileSync(args.canaries, 'utf8'));
    const canaries = Array.isArray(gold?.canaries) ? gold.canaries : [];
    const chapterText = found.map((c) => c.lines.join('\n')).join('\n');
    const missing = canaries.map((c, i) => (new RegExp(c, 'i').test(chapterText) ? null : i)).filter((i) => i !== null);
    if (missing.length > 0) {
      console.error(`prepare-gutenberg-book: ${missing.length} of ${canaries.length} canaries in ${args.canaries} do not occur in the text: indexes ${missing.join(', ')}. Replace them with wording that does.`);
      process.exitCode = 1;
    } else {
      console.error(`${canaries.length} canaries in ${args.canaries} all occur in the text.`);
    }
  }

  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, markdown, 'utf8');
    console.error(`wrote ${args.out}`);
  } else {
    process.stdout.write(markdown);
  }
}

main();
