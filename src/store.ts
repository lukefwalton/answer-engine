// The index on disk: one versioned JSON file holding every source — public
// records and private notes — with its vector. Both layers share one vector
// space; the sourceType discriminator is what lets retrieval keep them in
// separate streams (the privacy boundary starts here). At personal-archive
// scale a single file plus brute-force cosine is the honest, simple answer.
//
// The private notes' text is in this file, so the index is private even when
// your corpus is public — it stays gitignored.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { IndexEntry } from './types.js';

export const INDEX_PATH = resolve('artifacts/index.json');

/** Bump when IndexEntry changes shape; old artifacts then fail fast with a
 *  rebuild message instead of generic type errors deep in retrieval. */
export const INDEX_SCHEMA_VERSION = 2;

const REBUILD = 'Delete artifacts/index.json and rerun `npm run index`.';

function entryIsValid(e: Partial<IndexEntry>): boolean {
  if (
    typeof e?.model !== 'string' ||
    typeof e.dimensions !== 'number' ||
    !Array.isArray(e.vector) ||
    typeof e.contentHash !== 'string'
  ) {
    return false;
  }
  if (e.sourceType === 'record') {
    return typeof e.record?.id === 'string' && typeof e.record.url === 'string';
  }
  if (e.sourceType === 'note') {
    return typeof e.note?.id === 'string' && typeof e.note.url === 'string';
  }
  return false;
}

export function readIndexFile(path: string = INDEX_PATH): IndexEntry[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`index at ${path} is not valid JSON. ${REBUILD}`);
  }
  const file = parsed as { version?: unknown; entries?: unknown };
  if (typeof parsed !== 'object' || parsed === null || file.version !== INDEX_SCHEMA_VERSION) {
    throw new Error(
      `index at ${path} is not schema version ${INDEX_SCHEMA_VERSION}. ${REBUILD}`,
    );
  }
  if (!Array.isArray(file.entries)) {
    throw new Error(`index at ${path} has no entries array. ${REBUILD}`);
  }
  // Spot-check the fields the CLIs dereference, so a hand-edited or partially
  // corrupted artifact fails here with the remedy, not later with a type error.
  for (const e of file.entries as Partial<IndexEntry>[]) {
    if (!entryIsValid(e)) {
      throw new Error(`index at ${path} has a malformed entry. ${REBUILD}`);
    }
  }
  return file.entries as IndexEntry[];
}

export function writeIndexFile(entries: readonly IndexEntry[], path: string = INDEX_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: INDEX_SCHEMA_VERSION, entries }) + '\n', 'utf8');
}

/** Stable id for an entry's source, whichever layer it came from. */
export function entrySourceId(entry: IndexEntry): string {
  return entry.sourceType === 'record' ? entry.record.id : entry.note.id;
}

/** Cosine across vectors from different models or dimensions is meaningless.
 *  Fail fast at load time with the remedy, instead of crashing mid-retrieval. */
export function assertHomogeneousIndex(entries: readonly IndexEntry[]): void {
  const first = entries[0];
  if (!first) return;
  for (const e of entries) {
    if (e.model !== first.model || e.dimensions !== first.dimensions) {
      throw new Error(
        `index mixes embedding specs (${first.model}/${first.dimensions} vs ` +
          `${e.model}/${e.dimensions} for '${entrySourceId(e)}'). ${REBUILD}`,
      );
    }
  }
}
