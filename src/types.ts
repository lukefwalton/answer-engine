// The shapes that travel through the engine. The one to read slowly is
// AnswerEvidence: RoutingHint has no field for private text, which makes
// the privacy boundary a compile-time constraint rather than a review note.

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
 * One piece of the PRIVATE layer — searchable, never quotable. The text is
 * embedded so retrieval can find the moment, but it is stripped before the
 * model sees anything (see no-leak.ts). In production these are chunked
 * podcast transcripts; here they are hand-written notebook entries.
 */
export interface PrivateNote {
  /** Stable id: `note:${slug}`. */
  id: string;
  /** What the note is (e.g. "Harbor Lights — writing session"). Public-safe. */
  label: string;
  /** The PUBLIC page a citation routes the reader to. */
  url: string;
  /** Where in the private material the moment lives ("notebook, p. 12").
   *  Public-safe like the label — both travel into hints and answers. */
  locator: string;
  /** The private text. Embedded for retrieval; never rendered into a prompt. */
  text: string;
}

/**
 * A private note reduced to its public-safe routing surface. Deliberately has
 * NO field for the note's text — code that tried to hand private prose to the
 * model would not compile.
 */
export interface RoutingHint {
  hintId: string;
  label: string;
  url: string;
  locator: string;
}

/** Everything the answer model is allowed to see. */
export interface AnswerEvidence {
  records: ArchiveRecord[];
  hints: RoutingHint[];
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
  /** OpenAI embedding model. Changing it re-embeds everything on next index run. */
  embeddingModel: string;
  /** OpenAI model that writes the answer. */
  answerModel: string;
  /** Reasoning effort for reasoning-family answer models. 'low' is usually
   *  enough; raise it if the model starts applying the mode boundaries
   *  inconsistently — policy adherence costs reasoning. */
  reasoningEffort?: 'low' | 'medium' | 'high';
}
