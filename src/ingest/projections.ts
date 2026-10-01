// The author's projections file (docs/CONTRACT.md §5): every stored gist,
// keyed by fragment id, in the same custody class as the index it describes.
// The teaching build keeps it at artifacts/projections.json, gitignored with
// the index. The author works in this file: edit a gist and set `source` to
// `edited`; set `vetoed: true`; set `review` to `reviewed`. The next
// `npm run index` re-lints every gist against the current text, keeps the
// edits, and resolves each fragment's exposure from what it finds.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { SemanticProjection } from '../contract.js';

export const PROJECTIONS_PATH = resolve('artifacts/projections.json');
export const PROJECTIONS_SCHEMA_VERSION = 1;

export interface ProjectionsFile {
  version: typeof PROJECTIONS_SCHEMA_VERSION;
  projections: Record<string, SemanticProjection>;
}

/** sha1 of the fragment text a gist was drafted or edited against, 16 hex
 *  chars. Model and prompt version are stored beside it on the projection: a
 *  generated gist is current when all three match; an edited gist is stale
 *  when the text alone moved, whatever model drafted the original. The index
 *  validator checks it on every `semantic` fragment at load (src/store.ts). */
export function projectionContentHash(fragmentText: string): string {
  return createHash('sha1').update(fragmentText).digest('hex').slice(0, 16);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * The first thing wrong with a projection's shape, as a phrase naming the field
 * at `at` and the type it needed, or null. Field names only, never values: the
 * phrase becomes an error message that build tools print, and a projection's
 * values are private material. The gist's brand is restored by the lint, never
 * here.
 */
export function projectionProblem(p: unknown, at = 'projection'): string | null {
  if (!isRecord(p)) return `${at} must be an object`;
  if (p.source !== 'generated' && p.source !== 'edited') return `${at}.source must be 'generated' or 'edited'`;
  if (p.review !== 'unreviewed' && p.review !== 'reviewed') return `${at}.review must be 'unreviewed' or 'reviewed'`;
  for (const key of ['vetoed', 'stale'] as const) {
    if (p[key] !== undefined && typeof p[key] !== 'boolean') return `${at}.${key} must be a boolean`;
  }
  if (typeof p.contentHash !== 'string') return `${at}.contentHash must be a string`;
  for (const key of ['model', 'promptVersion', 'generatedAt'] as const) {
    if (p[key] !== undefined && typeof p[key] !== 'string') return `${at}.${key} must be a string`;
  }
  if (p.lint === 'passed') return typeof p.gist === 'string' ? null : `${at}.gist must be a string when lint is 'passed'`;
  if (p.lint === 'failed') return typeof p.draft === 'string' ? null : `${at}.draft must be a string when lint is 'failed'`;
  return `${at}.lint must be 'passed' or 'failed'`;
}

/** Shape only; see projectionProblem. */
export function projectionIsValid(p: unknown): p is SemanticProjection {
  return projectionProblem(p) === null;
}

export function validateProjections(parsed: unknown, path = 'projections'): ProjectionsFile {
  if (!isRecord(parsed) || parsed.version !== PROJECTIONS_SCHEMA_VERSION || !isRecord(parsed.projections)) {
    throw new Error(
      `${path} is not a version ${PROJECTIONS_SCHEMA_VERSION} projections file ` +
        `({ version, projections: { [fragmentId]: projection } }). Fix it or delete it to redraft every gist.`,
    );
  }
  for (const [id, p] of Object.entries(parsed.projections)) {
    const problem = projectionProblem(p, 'it');
    if (problem !== null) {
      throw new Error(
        `${path}: projection '${id}' is malformed (${problem}). Each needs source (generated|edited), review ` +
          `(unreviewed|reviewed), contentHash, and lint 'passed' with a gist or lint 'failed' with a draft.`,
      );
    }
  }
  return parsed as unknown as ProjectionsFile;
}

/** A missing file is an empty store. */
export function readProjections(path: string = PROJECTIONS_PATH): Map<string, SemanticProjection> {
  if (!existsSync(path)) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not valid JSON. Fix it or delete it to redraft every gist.`);
  }
  return new Map(Object.entries(validateProjections(parsed, path).projections));
}

/** Written sorted by fragment id and pretty-printed: the author edits this file. */
export function writeProjections(projections: ReadonlyMap<string, SemanticProjection>, path: string = PROJECTIONS_PATH): void {
  const file: ProjectionsFile = {
    version: PROJECTIONS_SCHEMA_VERSION,
    projections: Object.fromEntries([...projections.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
  validateProjections(file, path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}
