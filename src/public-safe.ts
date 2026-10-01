// The counterpart to no-leak.ts: that file owns what must NOT travel toward
// the model; this one owns the shape of what MAY. Three things live here:
// the lint every authored string on a private entity passes before it may
// travel (assertPublicSafeField for one string, assertPublicSafeMetadata for
// an entity's whole metadata surface; together the only constructor of the
// PublicSafe brand — NEXT-STEPS.md A1), the lint a semantic projection passes
// before it may be served (the only constructor of the LintedGist brand —
// docs/CONTRACT.md §6), and the related-material answer template, rendered
// here instead of written by the model so the mode can only point at private
// material and never assert its contents (NEXT-STEPS.md A2). The template's
// safety is exactly the lint's: it renders nothing but linted fields.
//
// Both lints run wherever the text they check against is present: at corpus
// read, at index build, and again at every load of a private index
// (validateIndex in src/store.ts), so a hand edit to the index is caught at
// load rather than in an answer. A served index carries no private text to
// check against and is trusted to descend from a validated private one
// (docs/CONTRACT.md §4).

import type { Entity, Fragment } from './contract.js';
import { renderLocatorLabel } from './locator.js';
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

/** What the traveling-string lint throws, so a caller can tell a lint failure
 *  (fix the authored string) from a malformed file. */
export class PublicSafeLintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicSafeLintError';
  }
}

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

function wordGramSet(words: readonly string[], n: number): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) grams.add(words.slice(i, i + n).join(' '));
  return grams;
}

function charGramSet(chars: string, n: number): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i + n <= chars.length; i++) grams.add(chars.slice(i, i + n));
  return grams;
}

/** The first run of `n` consecutive words that `field` shares with `body`, or null. */
export function findSharedWordRun(field: string, body: string, n: number): string | null {
  const fieldWords = normalizeWords(field);
  if (fieldWords.length < n) return null;
  const grams = wordGramSet(normalizeWords(body), n);
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
  if (f.length < n) return null;
  const grams = charGramSet(normalizeChars(body), n);
  for (let i = 0; i + n <= f.length; i++) {
    const gram = f.slice(i, i + n);
    if (grams.has(gram)) return gram;
  }
  return null;
}

/** A run a field shares with private text: in words, or in characters for a
 *  script without word spacing. */
export interface SharedRun {
  unit: 'words' | 'characters';
  n: number;
  gram: string;
}

/**
 * The n-gram sets of one body of private text, built once, so that many
 * fields (every locator of a long book, say) can be checked against it
 * without re-normalizing the body each time. Word runs always; character runs
 * when either side is in a script without word spacing.
 */
export function privateTextMatcher(
  body: string,
  options: { ngramWords?: number; ngramChars?: number } = {},
): (field: string) => SharedRun | null {
  const nWords = options.ngramWords ?? PUBLIC_SAFE_NGRAM_WORDS;
  const nChars = options.ngramChars ?? GIST_NGRAM_CHARS;
  const wordGrams = wordGramSet(normalizeWords(body), nWords);
  const bodyUnspaced = hasUnspacedScript(body);
  let charGrams: Set<string> | null = null;
  return (field) => {
    const words = normalizeWords(field);
    for (let i = 0; i + nWords <= words.length; i++) {
      const gram = words.slice(i, i + nWords).join(' ');
      if (wordGrams.has(gram)) return { unit: 'words', n: nWords, gram };
    }
    if (bodyUnspaced || hasUnspacedScript(field)) {
      charGrams ??= charGramSet(normalizeChars(body), nChars);
      const chars = normalizeChars(field);
      for (let i = 0; i + nChars <= chars.length; i++) {
        const gram = chars.slice(i, i + nChars);
        if (charGrams.has(gram)) return { unit: 'characters', n: nChars, gram };
      }
    }
    return null;
  };
}

/** The checks every traveling string passes, with the same wording wherever
 *  it is called from: non-empty, one line, at most PUBLIC_SAFE_MAX_CHARS, and
 *  no run shared with the private text it points into. */
function assertPublicSafeString(
  value: string,
  where: string,
  sharedRun: (field: string) => SharedRun | null,
): PublicSafe {
  if (!value.trim()) {
    throw new PublicSafeLintError(`${where} must not be empty — it travels as a display string.`);
  }
  if (/[\r\n]/.test(value)) {
    throw new PublicSafeLintError(`${where} must be a single line; a traveling field is a display string, not prose.`);
  }
  if (value.length > PUBLIC_SAFE_MAX_CHARS) {
    throw new PublicSafeLintError(
      `${where} is ${value.length} chars (max ${PUBLIC_SAFE_MAX_CHARS}); a traveling field is a display string, not prose.`,
    );
  }
  const run = sharedRun(value);
  if (run !== null) {
    throw new PublicSafeLintError(
      `${where} quotes private text ("${run.gram}"). ` +
        `A traveling field must not contain ${run.n} consecutive ${run.unit} of private text — reword it to point, not quote.`,
    );
  }
  return value as PublicSafe;
}

/**
 * The lint one traveling string passes (the 2.x constructor of PublicSafe): a
 * private note's label or locator at corpus read, and any other authored
 * string checked on its own. Each check fails loudly with the path and the
 * field: non-empty, single-line, capped length, and no run of
 * PUBLIC_SAFE_NGRAM_WORDS consecutive words shared with the private text (or
 * GIST_NGRAM_CHARS characters, for a script without word spacing) — a
 * traveling field that quotes the private text is the leak, caught where the
 * author can fix it instead of in an answer.
 *
 * This is a tripwire, not a classifier. A short private phrase, or private
 * meaning in public words, passes it — what remains owned by discipline is
 * named at the population site (src/corpus.ts) and in NEXT-STEPS.md A1.
 */
export function assertPublicSafeField(
  value: string,
  context: { field: string; path: string; privateText: string },
): PublicSafe {
  return assertPublicSafeString(value, `${context.path}: '${context.field}'`, privateTextMatcher(context.privateText));
}

/** A fragment whose text opens with the entity's title as its own paragraph
 *  carries the title as a heading (the note shape: title, blank line, body).
 *  The body is what follows. */
function bodyWithoutHeading(text: string, title: string): string {
  if (text === title) return '';
  const heading = `${title}\n\n`;
  return text.startsWith(heading) ? text.slice(heading.length) : text;
}

/**
 * The authored strings a hit on a PRIVATE entity carries, each passed through
 * assertPublicSafeField's rule against the entity's whole private text
 * (docs/CONTRACT.md §6): the entity's title and version, its creators' names
 * and roles, its themes; and on every fragment the locator values and the
 * rendered locator label, the speakers' names and roles, and the fragment's
 * themes. Structural fields (ids, type, url, identifiers, dates, the empty
 * value of a `whole` locator) are not prose and are not checked. A public
 * entity is not checked: its text is public, so its metadata is public by
 * construction.
 *
 * Two exemptions, both the author's act. A fragment whose text opens with the
 * entity's title as its first paragraph has that heading removed before the
 * comparison: the title is the string under test, and publishing it is the
 * author's act; what the lint protects is the body. And an entity whose
 * `policy.publicTitle` is set has its title skipped altogether: the title is
 * public by construction (a published page's, a feed item's), so a transcript
 * whose host reads the episode title aloud is not a leak. The title is still
 * bounded to one line of PUBLIC_SAFE_MAX_CHARS.
 *
 * Runs at index build and at every load of a private index (src/store.ts).
 * Throws with the path, the field, and the offending run.
 */
export function assertPublicSafeMetadata(
  entity: Pick<Entity, 'id' | 'title' | 'version' | 'attribution' | 'themes' | 'policy'>,
  fragments: readonly Pick<Fragment, 'id' | 'text' | 'locator' | 'attribution' | 'themes'>[],
  context: { path: string; ngramWords?: number; ngramChars?: number },
): void {
  const body = fragments.map((f) => bodyWithoutHeading(f.text, entity.title)).join('\n\n');
  const sharedRun = privateTextMatcher(body, context);
  const check = (value: string | undefined, where: string): void => {
    if (value === undefined || value === '') return;
    assertPublicSafeString(value, where, sharedRun);
  };

  const at = `${context.path}: entity '${entity.id}'`;
  if (entity.policy?.publicTitle) {
    // Declared public: shape only, no run check against the text.
    assertPublicSafeString(entity.title, `${at}: 'title'`, () => null);
  } else {
    check(entity.title, `${at}: 'title'`);
  }
  check(entity.version, `${at}: 'version'`);
  for (const a of entity.attribution) {
    check(a.name, `${at}: 'creator name'`);
    check(a.role, `${at}: 'creator role'`);
  }
  for (const theme of entity.themes ?? []) check(theme, `${at}: 'theme'`);

  for (const f of fragments) {
    const here = `${context.path}: fragment '${f.id}'`;
    for (const l of f.locator) {
      check(l.value, `${here}: 'locator value (${l.scheme})'`);
      check(l.end, `${here}: 'locator end (${l.scheme})'`);
    }
    check(renderLocatorLabel(f.locator), `${here}: 'locator label'`);
    for (const a of f.attribution ?? []) {
      check(a.name, `${here}: 'speaker name'`);
      check(a.role, `${here}: 'speaker role'`);
    }
    for (const theme of f.themes ?? []) check(theme, `${here}: 'theme'`);
  }
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
 * linted fields (label, locator) and, for a hint whose fragment is exposed as
 * `semantic`, the lint-passed gist the author authorized. No model prose
 * survives into this mode, which is what turns "route, don't restate" from a
 * prompt instruction into a structural guarantee: a confabulated summary of a
 * private note is inexpressible, not merely discouraged. The gist arrives
 * here through project() and toAnswerEvidence, never through the prompt
 * (docs/CONTRACT.md §9).
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
  gists: Readonly<Record<string, LintedGist>> = {},
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
    return { ref: `${hint.label} (${hint.locator})`, gist: gists[c.hintId] };
  });
  const tail =
    refs.length === 1
      ? 'the citation links to the public page it belongs to'
      : 'the citations link to the public pages they belong to';
  const routed = `There is private material related to this: ${refs.map((r) => r.ref).join('; ')}. It can't be quoted here — ${tail}.`;
  const described = refs
    .filter((r) => r.gist !== undefined)
    .map((r) => ` What ${r.ref} is about, as a description the author authorized (not a quotation): ${r.gist}`);
  return routed + described.join('');
}
