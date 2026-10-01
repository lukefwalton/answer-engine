// Policy resolution, at build time and only there (docs/CONTRACT.md §3).
//
// A fragment's effective exposure is decided once, when the index is built,
// and stored on the fragment. Nothing re-resolves it at query time. The
// resolver may only downgrade: a requested `semantic` becomes `locator` when
// the gist is not servable; `none` stays `none`; `text` is never granted on a
// private entity because the Disclosure type has no such member, and a
// fragment that asks for it is a misauthored input that fails loudly here.

import type { Disclosure, Entity, Exposure, SemanticProjection } from '../contract.js';

/** What ingest knows about a fragment before resolution. */
export interface FragmentInput {
  /** Requested exposure. Absent means "the entity default". */
  exposure?: Exposure;
  projection?: SemanticProjection;
}

/**
 * The one predicate that decides whether a gist may be served. Every later
 * check (project(), the index validator) cites this instead of restating it.
 */
export function isServableGist(
  fragment: { projection?: SemanticProjection },
  entity: { policy?: Entity['policy'] },
): boolean {
  const p = fragment.projection;
  if (p === undefined) return false;
  if (p.lint !== 'passed') return false;
  if (p.vetoed) return false;
  if (p.stale) return false;
  if (entity.policy?.requireReview && p.review !== 'reviewed') return false;
  return true;
}

/**
 * Resolve a fragment's effective disclosure from the entity default and the
 * fragment's request. `raw` always comes from the entity. An override may be
 * more permissive than the entity default; that is the author's act. The
 * resolver itself only downgrades.
 */
export function resolveDisclosure(
  entity: Pick<Entity, 'id' | 'disclosure' | 'policy'>,
  input: FragmentInput,
  context: { path?: string } = {},
): Disclosure {
  const where = context.path ?? entity.id;
  const requested: Exposure = input.exposure ?? entity.disclosure.exposure;
  const raw = entity.disclosure.raw;

  if (raw === 'private') {
    if (requested === 'text') {
      throw new Error(
        `${where}: requests exposure 'text' on the private entity '${entity.id}'. ` +
          `private + text is not representable; choose 'semantic', 'locator', or 'none', ` +
          `or make the entity public.`,
      );
    }
    const exposure = requested === 'semantic' && !isServableGist(input, entity) ? 'locator' : requested;
    return { raw: 'private', exposure };
  }

  const exposure = requested === 'semantic' && !isServableGist(input, entity) ? 'locator' : requested;
  return { raw: 'public', exposure };
}
