// The counterpart to no-leak.ts: that file owns what must NOT travel toward
// the model; this one owns the shape of what MAY. Two things live here:
// the build-time lint that every traveling private-note field must pass
// (the only constructor of the PublicSafe brand — NEXT-STEPS.md A1), and
// the related-material answer template, rendered here instead of written by
// the model so the mode can only point at private material and never assert
// its contents (NEXT-STEPS.md A2). The template's safety is exactly the
// lint's: it renders nothing but PublicSafe fields.

import type { Citation, PublicSafe, RoutingHint } from './types.js';

/** Traveling fields are short display strings, not prose. Anything longer
 *  has room to carry content, which is the leak shape the lint exists for. */
export const PUBLIC_SAFE_MAX_CHARS = 120;

/** 5, not 4: locators legitimately quote public bibliographic titles, and
 *  the demo corpus shares a real 4-token run ("the forgiveness of sins")
 *  between a locator and the sermon body it points into. Five consecutive
 *  tokens is where legitimate citation ends and quotation begins for these
 *  corpora; retune against yours if it flags honest locators. */
export const PUBLIC_SAFE_NGRAM_WORDS = 5;

function normalizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The sole constructor of PublicSafe: a build-time lint on a private note's
 * traveling fields (label, locator). Checks, each failing loudly with the
 * file and field: non-empty, single-line, capped length, and no run of
 * PUBLIC_SAFE_NGRAM_WORDS consecutive words shared with the note's private
 * body — a traveling field that quotes the private text is the leak, caught
 * where the author can fix it instead of in an answer.
 *
 * This is a tripwire, not a classifier. A short private phrase, or private
 * meaning in public words, passes it — what remains owned by discipline is
 * named at the population site (src/corpus.ts) and in NEXT-STEPS.md A1.
 */
export function assertPublicSafeField(
  value: string,
  context: { field: 'label' | 'locator'; path: string; privateText: string },
): PublicSafe {
  const where = `${context.path}: '${context.field}'`;
  if (!value.trim()) {
    throw new Error(`${where} must not be empty — it travels to the model as the note's display ${context.field}.`);
  }
  if (/[\r\n]/.test(value)) {
    throw new Error(`${where} must be a single line; a traveling field is a display string, not prose.`);
  }
  if (value.length > PUBLIC_SAFE_MAX_CHARS) {
    throw new Error(
      `${where} is ${value.length} chars (max ${PUBLIC_SAFE_MAX_CHARS}); a traveling field is a display string, not prose.`,
    );
  }
  const fieldWords = normalizeWords(value);
  if (fieldWords.length >= PUBLIC_SAFE_NGRAM_WORDS) {
    const bodyWords = normalizeWords(context.privateText);
    const bodyGrams = new Set<string>();
    for (let i = 0; i + PUBLIC_SAFE_NGRAM_WORDS <= bodyWords.length; i++) {
      bodyGrams.add(bodyWords.slice(i, i + PUBLIC_SAFE_NGRAM_WORDS).join(' '));
    }
    for (let i = 0; i + PUBLIC_SAFE_NGRAM_WORDS <= fieldWords.length; i++) {
      const gram = fieldWords.slice(i, i + PUBLIC_SAFE_NGRAM_WORDS).join(' ');
      if (bodyGrams.has(gram)) {
        throw new Error(
          `${where} quotes the note's private body ("${gram}"). ` +
            `A traveling field must not contain ${PUBLIC_SAFE_NGRAM_WORDS} consecutive words of private text — reword it to point, not quote.`,
        );
      }
    }
  }
  return value as PublicSafe;
}

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
