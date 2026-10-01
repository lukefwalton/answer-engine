// The counterpart to no-leak.ts: that file owns what must NOT travel toward
// the model; this one owns the shape of what MAY. Three things live here:
// the build-time lint that every traveling private-note field must pass
// (the only constructor of the PublicSafe brand — NEXT-STEPS.md A1), the
// build-time lint a semantic projection must pass before it may be served
// (the only constructor of the LintedGist brand — docs/CONTRACT.md §6), and
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

/** A gist is a paragraph: two or three sentences describing what a passage
 *  is about. Past this it has room to retell (docs/CONTRACT.md §6). */
export const GIST_MAX_CHARS = 400;

/** The gist lint's word-run window. Same reasoning as PUBLIC_SAFE_NGRAM_WORDS:
 *  four trips on function-word runs any honest description shares with its
 *  source; three is unusable. Exported so a consumer can tune it per entity. */
export const GIST_NGRAM_WORDS = 5;

/** For text in a script without word spacing (Japanese, Chinese, Thai, ...),
 *  a word-run tripwire is vacuous: the whole passage is one "word". The lint
 *  then counts the run in characters instead, over the normalized text with
 *  whitespace removed. Twelve characters is roughly the width five words
 *  occupy in such scripts. */
export const GIST_NGRAM_CHARS = 12;

/** A gist the lint has passed. Constructible only through assertSemanticProjection. */
export type LintedGist = string & { readonly __lint: 'gist' };

/** Unicode-aware word normalization: NFKC, lowercase, every run of characters
 *  that is not a letter or a digit becomes one space. For ASCII text this is
 *  what the 2.x `[a-z0-9]` rule did; for accented and non-Latin text it keeps
 *  the letters instead of deleting them. */
export function normalizeWords(s: string): string[] {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** The first run of `n` consecutive words that `field` shares with `body`, or null. */
export function findSharedWordRun(field: string, body: string, n: number): string | null {
  const fieldWords = normalizeWords(field);
  if (fieldWords.length < n) return null;
  const bodyWords = normalizeWords(body);
  if (bodyWords.length < n) return null;
  const grams = new Set<string>();
  for (let i = 0; i + n <= bodyWords.length; i++) {
    grams.add(bodyWords.slice(i, i + n).join(' '));
  }
  for (let i = 0; i + n <= fieldWords.length; i++) {
    const gram = fieldWords.slice(i, i + n).join(' ');
    if (grams.has(gram)) return gram;
  }
  return null;
}

const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** True when the text contains a script written without word spacing. */
export function hasUnspacedScript(text: string): boolean {
  return UNSPACED_SCRIPT.test(text);
}

function normalizeChars(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** The first run of `n` consecutive characters (letters and digits only, no
 *  whitespace) that `field` shares with `body`, or null. */
export function findSharedCharRun(field: string, body: string, n: number): string | null {
  const f = normalizeChars(field);
  const b = normalizeChars(body);
  if (f.length < n || b.length < n) return null;
  const grams = new Set<string>();
  for (let i = 0; i + n <= b.length; i++) grams.add(b.slice(i, i + n));
  for (let i = 0; i + n <= f.length; i++) {
    const gram = f.slice(i, i + n);
    if (grams.has(gram)) return gram;
  }
  return null;
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
  const gram = findSharedWordRun(value, context.privateText, PUBLIC_SAFE_NGRAM_WORDS);
  if (gram !== null) {
    throw new Error(
      `${where} quotes the note's private body ("${gram}"). ` +
        `A traveling field must not contain ${PUBLIC_SAFE_NGRAM_WORDS} consecutive words of private text — reword it to point, not quote.`,
    );
  }
  return value as PublicSafe;
}

/**
 * The sole constructor of LintedGist: the build-time lint a semantic
 * projection passes before a policy may release it (docs/CONTRACT.md §6).
 * Checks, each failing loudly with the path: non-empty; one paragraph; at
 * most `maxChars`; no run of `ngramWords` consecutive words shared with the
 * fragment's text, and none shared with the whole entity's text when it is
 * supplied (so the gist of one page cannot quote the page before it). For
 * text in a script without word spacing the run is counted in characters.
 *
 * Like assertPublicSafeField, this is a tripwire, not a classifier: close
 * paraphrase, plot, a name, a number, and a run shorter than the window all
 * pass it. Those are owned by the exposure policy, the veto, review, and the
 * evaluation's canaries (CONTRACT.md §11, §13), not by this function.
 */
export function assertSemanticProjection(
  gist: string,
  context: {
    path: string;
    fragmentText: string;
    entityText?: string;
    maxChars?: number;
    ngramWords?: number;
    ngramChars?: number;
  },
): LintedGist {
  const where = `${context.path}: gist`;
  const maxChars = context.maxChars ?? GIST_MAX_CHARS;
  const ngramWords = context.ngramWords ?? GIST_NGRAM_WORDS;
  const ngramChars = context.ngramChars ?? GIST_NGRAM_CHARS;
  if (!gist.trim()) {
    throw new Error(`${where} must not be empty; a fragment with no gist resolves to 'locator' instead.`);
  }
  if (/[\r\n]/.test(gist)) {
    throw new Error(`${where} must be one paragraph (no line breaks).`);
  }
  if (gist.length > maxChars) {
    throw new Error(
      `${where} is ${gist.length} chars (max ${maxChars}); a gist describes a passage, it does not retell it.`,
    );
  }
  const sources: Array<[string, string]> = [['fragment', context.fragmentText]];
  if (context.entityText !== undefined) sources.push(['entity', context.entityText]);
  for (const [name, text] of sources) {
    const wordGram = findSharedWordRun(gist, text, ngramWords);
    if (wordGram !== null) {
      throw new Error(
        `${where} quotes the ${name}'s text ("${wordGram}"). ` +
          `A projection must not contain ${ngramWords} consecutive words of the source — describe, do not quote.`,
      );
    }
    if (hasUnspacedScript(gist) || hasUnspacedScript(text)) {
      const charGram = findSharedCharRun(gist, text, ngramChars);
      if (charGram !== null) {
        throw new Error(
          `${where} quotes the ${name}'s text ("${charGram}"). ` +
            `A projection must not contain ${ngramChars} consecutive characters of the source — describe, do not quote.`,
        );
      }
    }
  }
  return gist as LintedGist;
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
