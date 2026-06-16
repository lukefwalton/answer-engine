// scaling/query-vectors.ts — the committed gold-query embeddings.
//
// The core eval CLI (src/cli/eval.ts) embeds every gold query at run time, so
// it always needs a key. The demo's headline must reproduce WITHOUT one, so the
// gold-query vectors are precomputed by scaling:build and committed here beside
// the index. The runner reads them instead of calling the embedding API; a key
// is only ever needed to regenerate them or to run the --full answer pass.
//
// Same homogeneity discipline as the index (src/store.ts): a query embedded in
// a different model or width than the index is a meaningless cosine, so the
// file carries its (model, dimensions) and the runner checks them.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const QUERY_VECTORS_PATH = resolve('scaling/corpus/query-vectors.json');
export const QUERY_VECTORS_VERSION = 1;

export interface QueryVectorsFile {
  version: number;
  model: string;
  dimensions: number;
  queries: { id: string; vector: number[] }[];
}

export interface LoadedQueryVectors {
  model: string;
  dimensions: number;
  byId: Map<string, number[]>;
}

const REBUILD = 'Run `npm run scaling:build` with an OPENAI_API_KEY (see docs/scaling-demo/build-handoff.md).';

/** Read the committed query vectors, or null if not built yet. Throws on a
 *  present-but-malformed file so a corrupt artifact fails loudly with a remedy. */
export function readQueryVectors(path: string = QUERY_VECTORS_PATH): LoadedQueryVectors | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`query vectors at ${path} are not valid JSON. ${REBUILD}`);
  }
  const file = parsed as Partial<QueryVectorsFile>;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    file.version !== QUERY_VECTORS_VERSION ||
    typeof file.model !== 'string' ||
    typeof file.dimensions !== 'number' ||
    !Array.isArray(file.queries)
  ) {
    throw new Error(`query vectors at ${path} are not schema version ${QUERY_VECTORS_VERSION}. ${REBUILD}`);
  }
  const byId = new Map<string, number[]>();
  for (const q of file.queries) {
    // Validate to the same depth the store does for the index: a corrupt vector
    // must fail loudly at read with the rebuild hint, not later as bad cosine.
    if (
      typeof q?.id !== 'string' ||
      !Array.isArray(q.vector) ||
      q.vector.length !== file.dimensions ||
      !q.vector.every((x) => typeof x === 'number' && Number.isFinite(x))
    ) {
      const which = typeof q?.id === 'string' ? ` for '${q.id}'` : '';
      throw new Error(`query vectors at ${path} have a malformed entry${which}. ${REBUILD}`);
    }
    byId.set(q.id, q.vector);
  }
  return { model: file.model, dimensions: file.dimensions, byId };
}

export function writeQueryVectors(
  model: string,
  dimensions: number,
  queries: { id: string; vector: number[] }[],
  path: string = QUERY_VECTORS_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const file: QueryVectorsFile = { version: QUERY_VECTORS_VERSION, model, dimensions, queries };
  writeFileSync(path, `${JSON.stringify(file)}\n`, 'utf8');
}
