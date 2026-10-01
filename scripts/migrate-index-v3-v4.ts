// npm run migrate:index [-- path ...] — schema 3 → 4 for index files, in place,
// without re-embedding. Defaults to the demo's committed artifacts.
//
// v4 stores every entity once and every entry as a Fragment with its resolved
// disclosure (docs/CONTRACT.md §12). The teaching adapters reproduce the exact
// embed bytes the committed vectors and contentHashes were taken over
// (src/embed-string.ts), so nothing here touches a number. This script exists
// as provenance for an edit to committed artifacts (demo/artifacts.test.ts
// pins the hashes); it is idempotent-by-refusal: a v4 file is left alone.
//
// Failures are operator-facing and say what to do, in the store's own voice:
// a missing or unparseable file names the file and the remedy, and a migrated
// index that would not load (writeIndex validates) fails with that message.
// The store's messages name ids, fields, and positions, never a value, so
// printing one here is safe (.github/STANDARDS.md §4).

import { readFileSync } from 'node:fs';

import { migrateV3ToV4, writeIndex } from '../src/store.js';

const DEFAULT_FILES = ['demo/corpus/index.json', 'demo/corpus/index.synthetic.json'];

function readIndexJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `index at ${path} does not exist. Pass the path of the index to migrate, ` +
          `or run with no arguments for the demo's committed indexes (${DEFAULT_FILES.join(', ')}).`,
      );
    }
    throw new Error(`index at ${path} could not be read (${code ?? 'unknown error'}).`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `index at ${path} is not valid JSON. Restore it from version control, or rebuild it ` +
        `(\`npm run index\` for artifacts/index.json, \`npm run demo:build\` for the demo).`,
    );
  }
}

function main(): void {
  const files = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_FILES;
  for (const path of files) {
    const parsed = readIndexJson(path);
    if (typeof parsed === 'object' && parsed !== null && (parsed as { version?: unknown }).version === 4) {
      console.log(`${path}: already schema version 4; nothing to do.`);
      continue;
    }
    const migrated = migrateV3ToV4(parsed, path);
    writeIndex(migrated, path);
    console.log(
      `${path}: migrated to schema version 4 (${migrated.entities.length} entities, ${migrated.entries.length} fragments; vectors and hashes untouched)`,
    );
  }
}

try {
  main();
} catch (err) {
  console.error(`migrate:index failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
}
