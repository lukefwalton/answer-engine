// The shapes that travel through the engine. The one to read slowly is
// AnswerEvidence: RoutingHint has no field for private text, which makes
// the privacy boundary a compile-time constraint rather than a review note.

import type { Attribution, Identifier } from './contract.js';
import type { FragmentPiece } from './ingest/fragment.js';
import type { LintedGist } from './public-safe.js';

/** One piece of the PUBLIC archive — quotable, citable, body travels. */
export interface ArchiveRecord {
  /** Stable id: `${type}:${slug}`. Citations point at this. */
  id: string;
  /** The collection it came from (e.g. 'essay', 'song'). Free-form. */
  type: string;
  slug: string;
  title: string;
  /** Canonical page for this record — the accountable surface a citation links to. */
  url: string;
  /** Short summary lifted from frontmatter (description / summary / meaning). */
  summary: string;
  /** Plain-text body, markdown stripped. */
  body: string;
  themes: string[];
  date?: string;
}

/**
 * A traveling string the build-time lint has passed. The only constructor is
 * `assertPublicSafeField` (src/public-safe.ts), so corpus code cannot put a
 * raw frontmatter string on the path toward the model — the same trick as
 * RoutingHint's missing text field, applied to the fields that DO travel.
 * Honest scope: the brand erases at JSON boundaries. A private index read from
 * disk re-runs the lint at load (validateIndex in src/store.ts), because the
 * text to check against is there; a served index has no text and is trusted
 * to descend from a validated private one (docs/CONTRACT.md §4).
 */
export type PublicSafe = string & { readonly __publicSafe: 'lint-passed' };

/**
 * One piece of the PRIVATE layer — searchable, never quotable. The text is
 * embedded so retrieval can find the moment, but it is stripped before the
 * model sees anything (see no-leak.ts). In production these are chunked
 * podcast transcripts; here they are hand-written notebook entries.
 */
export interface PrivateNote {
  /** Stable id: `note:${slug}`. */
  id: string;
  /** The note's own name (frontmatter `title`). PRIVATE — embedded for
   *  retrieval alongside the body, never shown to the model. */
  title: string;
  /** The display label that travels (frontmatter `label`, required). May
   *  simply repeat the title when the title is safe to publish — but that is
   *  a decision the author makes explicitly, per note. */
  label: PublicSafe;
  /** The PUBLIC page a citation routes the reader to. */
  url: string;
  /** Where in the private material the moment lives ("notebook, p. 12").
   *  Travels like the label, linted like the label. */
  locator: PublicSafe;
  /** The private text. Embedded for retrieval; never rendered into a prompt. */
  text: string;
  /** Frontmatter `exposure`: what may travel about this note (docs/CONTRACT.md
   *  §3). `locator` (the default) is where it is; `semantic` asks the build to
   *  draft a gist the author then authorizes; `none` is indexed, never served.
   *  `text` is not an option for private material. */
  exposure?: 'semantic' | 'locator' | 'none';
}

/**
 * One book of the PRIVATE layer: a manuscript, a thesis, a novel the archive
 * holds but may not quote (docs/CONTRACT.md §8). Unlike a note, it is one
 * entity with many fragments: the markdown body is split on chapter headings
 * (or page markers) at read time, and each piece becomes a fragment whose
 * locator is structural ("ch. 12", "p. 184"), never authored prose. The text
 * is embedded so retrieval can find the moment; what travels about it is the
 * entity's exposure: where it is (`locator`, the default), a gist the author
 * authorized (`semantic`), or nothing (`none`).
 */
export interface PrivateBook {
  /** Stable id: `${type}:${slug}`; `type` is frontmatter `type`, default `book`. */
  id: string;
  type: string;
  slug: string;
  /** Frontmatter `title`. It travels on every hit as the entity title, so it
   *  is checked against the book's text at build unless `publicTitle` says the
   *  title is public by construction (a published book's is). */
  title: string;
  /** Frontmatter `publicTitle: true`: skip the quote check on the title (the
   *  one-line bound still holds). The author's declaration (CONTRACT.md §6). */
  publicTitle?: boolean;
  /** The PUBLIC page a citation routes the reader to (frontmatter `about`). */
  url: string;
  /** Frontmatter `authors`: names, or `{ name, role }` entries. */
  attribution: Attribution[];
  /** Frontmatter `identifiers`: `{ scheme, value }` entries (isbn, doi, ...). */
  identifiers: Identifier[];
  date?: string;
  /** Frontmatter `version`: "manuscript", an edition, a draft number. */
  version?: string;
  themes: string[];
  /** Frontmatter `exposure`; absent means `locator`. `text` is not an option
   *  for private material (CONTRACT.md §3). */
  exposure?: 'semantic' | 'locator' | 'none';
  /** Frontmatter `requireReview: true`: a gist is servable only once the
   *  author marks it reviewed in artifacts/projections.json. */
  requireReview?: boolean;
  /** The pieces in source order, as the corpus reader cut them (a structural
   *  locator, the private text with markdown stripped, and the heading that
   *  opened the piece, kept apart so the adapter can put it in the embedding
   *  and nowhere else); never empty. */
  pieces: FragmentPiece[];
}

/**
 * A hint: a private (or non-quotable) hit reduced to its routing surface for
 * the in-package synthesis consumer (src/evidence.ts). Deliberately has NO
 * field for the source's text or gist — code that tried to hand private prose
 * to the model would not compile. The label and locator were linted when the
 * index was built and again when it was loaded (docs/CONTRACT.md §6); the
 * brand erases at JSON, so they are plain strings here. hintId is the fragment id.
 */
export interface RoutingHint {
  hintId: string;
  label: string;
  url: string;
  locator: string;
}

/** What the consumer holds after the crossing. `records` and `hints` are
 *  everything the answer model is allowed to see (buildUserPrompt takes those
 *  two and nothing else). `gists` never reach the prompt: the related-material
 *  template renders them after the mode is final, keyed by hintId, so the
 *  model has no description of private material to restate in any mode. */
export interface AnswerEvidence {
  records: ArchiveRecord[];
  hints: RoutingHint[];
  gists?: Record<string, LintedGist>;
}

/** One entry of artifacts/index.json: a source plus its embedding. */
export type IndexEntry = {
  model: string;
  dimensions: number;
  vector: number[];
  /** Hash of the embedded text; lets `npm run index` skip unchanged sources. */
  contentHash: string;
} & ({ sourceType: 'record'; record: ArchiveRecord } | { sourceType: 'note'; note: PrivateNote });

export type Citation =
  | { kind: 'record'; recordId: string; url: string }
  | { kind: 'hint'; hintId: string; url: string };

/**
 * The four modes partition the citation mix — which is how "say plainly what
 * you can and cannot claim" becomes checkable:
 *   supported        ≥1 record citation AND ≥1 hint citation
 *   partial          ≥1 record citation, no hints bear on the question
 *   related-material only hints — "the moment exists, here's where; I won't
 *                    restate what the private text says"
 *   not-found        nothing — empty answer, zero citations
 */
export type AnswerMode = 'supported' | 'partial' | 'related-material' | 'not-found';

export interface AnswerOutput {
  mode: AnswerMode;
  answer: string;
  citations: Citation[];
}

export interface CollectionConfig {
  /** Directory under contentRoot holding .md/.mdx files. */
  dir: string;
  /** Record URL is `${baseUrl}${urlPrefix}${slug}/`. */
  urlPrefix: string;
  type: string;
}

export interface ArchiveConfig {
  /** Shown to the model so answers say whose archive this is. */
  archiveName: string;
  /** The person whose views the archive represents. Answers only attribute
   *  views to this person when a record backs the claim. */
  authorName: string;
  baseUrl: string;
  /** Resolved relative to the project root (where you run npm scripts). */
  contentRoot: string;
  collections: CollectionConfig[];
  /** Directory of private notes (frontmatter: title, about, locator; body =
   *  private text). Omit it and the engine runs public-only. */
  privateNotesDir?: string;
  /** Directory of private books, one markdown file per book (frontmatter:
   *  title, about, and optionally authors, identifiers, date, version, themes,
   *  exposure, publicTitle, requireReview, fragmentBy, maxFragmentChars,
   *  firstPage; body = the private text, split into fragments on its chapter
   *  headings or page markers). Omit it and no book is indexed. */
  privateBooksDir?: string;
  /** OpenAI embedding model. Changing it re-embeds everything on next index run. */
  embeddingModel: string;
  /** OpenAI model that writes the answer. */
  answerModel: string;
  /** Reasoning effort for reasoning-family answer models. 'low' is usually
   *  enough; raise it if the model starts applying the mode boundaries
   *  inconsistently — policy adherence costs reasoning. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** The gist drafter (docs/CONTRACT.md §5), used only for notes whose
   *  frontmatter asks for `exposure: semantic`. */
  gist?: {
    /** Model that drafts gists. Default: answerModel. */
    model?: string;
    /** Default GIST_MAX_CHARS (400). Stored on each entity as `policy.lint.gistMaxChars`. */
    maxChars?: number;
    /** Default GIST_NGRAM_WORDS (5), for both lints. Dry-run at 4 and count the
     *  trips before choosing. Stored on each entity as `policy.lint.ngramWords`. */
    ngramWords?: number;
    /** Proper names a gist may use, keyed by entity id. Default: none at all. */
    allowedNames?: Record<string, string[]>;
  };
}
