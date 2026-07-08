// One-shot v2 → v3 migration for the COMMITTED demo index artifacts
// (demo/corpus/index.json, demo/corpus/index.synthetic.json).
//
// v3 split PrivateNote's `title` (private, embedded) from `label` (the
// public-safe field that travels) — NEXT-STEPS.md A1. At v2 build time the
// label WAS the frontmatter title, so `title := label` is exact, and the
// embed text (title + body, src/corpus.ts noteEmbedText) is byte-identical
// to what produced the committed vectors: nothing is re-embedded, vectors
// and contentHashes are untouched. This script exists as provenance for an
// edit to committed artifacts (see demo/artifacts.test.ts); it is
// idempotent-by-refusal and safe to delete once run.
//
// Usage: node scripts/migrate-demo-index-v3.mjs

import { readFileSync, writeFileSync } from 'node:fs';

const FILES = ['demo/corpus/index.json', 'demo/corpus/index.synthetic.json'];

for (const path of FILES) {
  const file = JSON.parse(readFileSync(path, 'utf8'));
  if (file.version !== 2) {
    throw new Error(`${path} is schema version ${file.version}, not 2 — refusing to migrate.`);
  }
  const entries = file.entries.map((entry) => {
    if (entry.sourceType !== 'note') return entry;
    const { id, label, url, locator, text } = entry.note;
    return { ...entry, note: { id, title: label, label, url, locator, text } };
  });
  writeFileSync(path, JSON.stringify({ version: 3, entries }) + '\n', 'utf8');
  const notes = entries.filter((e) => e.sourceType === 'note').length;
  console.log(`${path}: migrated to v3 (${notes} note entries gained 'title')`);
}
