// The counterpart to no-leak.ts: that file owns what must NOT travel toward
// the model; this one owns the shape of what MAY come back out. Today that is
// one thing — the related-material answer, rendered here instead of written
// by the model, so the mode can only point at private material and never
// assert its contents (NEXT-STEPS.md A2).

import type { Citation, RoutingHint } from './types.js';

/**
 * Deterministic related-material prose, built ONLY from the cited hints'
 * public-safe fields (label, locator). No model prose survives into this
 * mode, which is what turns "route, don't restate" from a prompt instruction
 * into a structural guarantee: a confabulated summary of a private note is
 * inexpressible, not merely discouraged.
 *
 * Deliberately NO raw URL in the prose — the citation object carries the
 * link, and the gold suite forbids URLs in this mode's answer (q07).
 *
 * Callers pass grounded citations (assertCitationsGroundedInEvidence has
 * run), so the lookups below cannot miss; the throws are for misuse, loud on
 * purpose.
 */
export function renderRelatedMaterialAnswer(
  citations: readonly Citation[],
  hints: readonly RoutingHint[],
): string {
  const cited = citations.filter((c) => c.kind === 'hint');
  if (cited.length === 0) {
    throw new Error('renderRelatedMaterialAnswer requires at least one hint citation');
  }
  const refs = cited.map((c) => {
    const hint = hints.find((h) => h.hintId === c.hintId);
    if (!hint) {
      throw new Error(`related-material citation '${c.hintId}' matches no hint in evidence`);
    }
    return `${hint.label} (${hint.locator})`;
  });
  const tail =
    refs.length === 1
      ? 'the citation links to the public page it belongs to'
      : 'the citations link to the public pages they belong to';
  return `There is private material related to this: ${refs.join('; ')}. It can't be quoted here — ${tail}.`;
}
