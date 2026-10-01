// The disclosure boundary. This is the whole file on purpose.
//
// Retrieval searches private text (the vectors came from it) and returns
// ScoredHit, which holds the Fragment. project() is the ONE place a hit
// crosses toward anything a model or a caller may see, and the type it
// produces cannot hold more than the fragment's resolved policy allows: the
// `locator` variant of EvidenceHit has no field for text, the `semantic`
// variant carries only a lint-passed gist, and `text` is unreachable for a
// private fragment because Disclosure has no such member. A consumer whose
// prompt builder or serializer accepts EvidenceHit cannot forward a private
// fragment's text along the typed path — a TypeScript error, not a runtime
// guard to remember. The short authored strings a hit does carry (title,
// locator label, names) are linted against the private text at build and at
// load (src/public-safe.ts), not typed. The bound on the whole claim is stated
// in docs/CONTRACT.md §4.
//
// Scores on private hits are coarse (rounded to 0.05, no breakdown): a
// full-precision cosine against a private vector is a measurement of that
// vector, and a caller who can embed its own queries would otherwise take as
// many measurements as it had queries.

import type { EvidenceHit, EvidenceHitBase, ScoredHit } from './contract.js';
import { effectiveDate } from './dates.js';
import { isServableGist } from './ingest/disclosure.js';
import { renderLocatorLabel } from './locator.js';
import { retrieve, type RetrievalIndex, type RetrieveOptions } from './retrieve.js';

export const PRIVATE_SCORE_STEP = 0.05;

function coarse(score: number): number {
  return Number((Math.round(score / PRIVATE_SCORE_STEP) * PRIVATE_SCORE_STEP).toFixed(2));
}

export function project(hit: ScoredHit): EvidenceHit {
  const { fragment, entity } = hit;
  const raw = fragment.disclosure.raw;
  const date = effectiveDate(fragment, entity);
  const base: EvidenceHitBase = {
    fragmentId: fragment.id,
    entity: {
      id: entity.id,
      type: entity.type,
      title: entity.title,
      attribution: entity.attribution,
      ...(entity.date !== undefined ? { date: entity.date } : {}),
      ...(entity.version !== undefined ? { version: entity.version } : {}),
      url: entity.url,
      identifiers: entity.identifiers,
      ...(entity.parent !== undefined ? { parent: entity.parent } : {}),
      ...(entity.themes !== undefined ? { themes: entity.themes } : {}),
    },
    raw,
    locator: fragment.locator,
    locatorLabel: renderLocatorLabel(fragment.locator),
    ...(date !== undefined ? { date } : {}),
    ...(fragment.attribution !== undefined ? { attribution: fragment.attribution } : {}),
    score: raw === 'private' ? coarse(hit.score) : hit.score,
    ...(raw === 'public' ? { breakdown: { ...hit.breakdown } } : {}),
  };

  switch (fragment.disclosure.exposure) {
    case 'text':
      if (raw === 'private') {
        // Unreachable through the Disclosure type; a runtime guard behind a
        // type costs nothing and a hand-built index is not a type.
        throw new Error(`project: fragment '${fragment.id}' is private but exposed as text`);
      }
      return {
        ...base,
        exposure: 'text',
        text: fragment.text,
        ...(fragment.summary !== undefined ? { summary: fragment.summary } : {}),
      };
    case 'semantic': {
      if (!isServableGist(fragment, entity) || fragment.projection?.lint !== 'passed') {
        throw new Error(`project: fragment '${fragment.id}' is exposed as semantic without a servable gist`);
      }
      return {
        ...base,
        exposure: 'semantic',
        gist: fragment.projection.gist,
        gistSource: fragment.projection.source,
        gistReview: fragment.projection.review,
      };
    }
    case 'locator':
      return { ...base, exposure: 'locator' };
    case 'none':
      throw new Error(`project: fragment '${fragment.id}' has exposure 'none' and is never served`);
  }
}

/** retrieve().map(project): the path a retrieval-only consumer takes, so it
 *  never holds a ScoredHit. */
export function search(
  queryVector: readonly number[],
  query: string,
  index: RetrievalIndex,
  options: RetrieveOptions = {},
): EvidenceHit[] {
  return retrieve(queryVector, query, index, options).map(project);
}
