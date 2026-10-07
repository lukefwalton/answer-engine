// node --import tsx scripts/stamp-query-vectors.ts — one-off, keyless:
// demo/corpus/query-vectors.json from version 1 to version 2, stamping each
// committed vector with the hash of the gold text it was embedded from
// (queryContentHash in demo/query-vectors.ts). No vector changes.
//
// Sound only when no gold query's text changed between the embedding and the
// stamp. Checked against git history when this ran (the vectors were last
// written in 166ad22; the gold files changed notes and labels since, and no
// `query:` line), and recorded here as provenance, as
// scripts/migrate-index-v3-v4.ts is for the index. Refuses a file that is not
// version 1 and an id the gold files do not carry; a gold id with no vector is
// left for `npm run demo:build` to embed.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadGold } from '../src/evaluate.js';
import { config } from '../demo/config.js';
import { queryContentHash, QUERY_VECTORS_PATH, writeQueryVectors } from '../demo/query-vectors.js';

const GOLD_FILES = ['demo/gold.yaml', 'demo/gold.synthetic.yaml', 'demo/gold.book.yaml'];

function main(): void {
  const path = process.argv[2] ? resolve(process.argv[2]) : QUERY_VECTORS_PATH;
  const file = JSON.parse(readFileSync(path, 'utf8')) as {
    version?: unknown;
    model?: unknown;
    dimensions?: unknown;
    queries?: { id?: unknown; vector?: unknown }[];
  };
  if (file.version !== 1) {
    throw new Error(`${path} is version ${String(file.version)}, not 1; nothing to stamp.`);
  }
  if (typeof file.model !== 'string' || typeof file.dimensions !== 'number' || !Array.isArray(file.queries)) {
    throw new Error(`${path} is not a query-vectors file.`);
  }
  // The text as the build embeds it: `{{author}}` substituted with the demo's
  // configured author, exactly as goldForBuild does. A gold file that does not
  // exist yet is skipped; one that exists and fails to load throws its own
  // message, so a malformed file is never mistaken for an absent one.
  const text = new Map<string, string>();
  for (const gold of GOLD_FILES) {
    if (!existsSync(gold)) continue;
    for (const q of loadGold(gold, config.authorName)) {
      if (text.has(q.id)) throw new Error(`gold id '${q.id}' appears in more than one demo gold file; ids are unique across them.`);
      text.set(q.id, q.query);
    }
  }
  const stamped = file.queries.map((q) => {
    if (typeof q.id !== 'string' || !Array.isArray(q.vector)) throw new Error(`${path}: malformed entry.`);
    const query = text.get(q.id);
    if (query === undefined) throw new Error(`${path}: '${q.id}' is not in any gold file; remove it or restore the query.`);
    return { id: q.id, vector: q.vector as number[], contentHash: queryContentHash(query) };
  });
  writeQueryVectors(file.model, file.dimensions, stamped, path);
  console.log(`stamped ${stamped.length} query vectors in ${path} (version 2); no vector changed.`);
}

main();
