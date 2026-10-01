// npm run migrate:index [-- path ...] — schema 3 → 4 for index files, in place,
// without re-embedding. Defaults to the demo's committed artifacts.
//
// v4 stores every entity once and every entry as a Fragment with its resolved
// disclosure (docs/CONTRACT.md §12). The teaching adapters reproduce the exact
// embed bytes the committed vectors and contentHashes were taken over
// (src/embed-string.ts), so nothing here touches a number. This script exists
// as provenance for an edit to committed artifacts (demo/artifacts.test.ts
// pins the hashes); it is idempotent-by-refusal: a v4 file is left alone.

import { readFileSync } from 'node:fs';

import { migrateV3ToV4, writeIndex } from '../src/store.js';

const DEFAULT_FILES = ['demo/corpus/index.json', 'demo/corpus/index.synthetic.json'];

const files = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_FILES;

for (const path of files) {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
  if (parsed.version === 4) {
    console.log(`${path}: already schema version 4; nothing to do.`);
    continue;
  }
  const migrated = migrateV3ToV4(parsed, path);
  writeIndex(migrated, path);
  console.log(
    `${path}: migrated to schema version 4 (${migrated.entities.length} entities, ${migrated.entries.length} fragments; vectors and hashes untouched)`,
  );
}
