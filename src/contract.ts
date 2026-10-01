// The shapes that travel in 3.0.0. Normative text: docs/CONTRACT.md §2.
//
// Read Disclosure and EvidenceHit slowly. Disclosure has no member for
// private + text, so that cell cannot be written down. EvidenceHit is a union
// on `exposure`: the `locator` variant has no field that could hold source
// text and the `semantic` variant carries only a lint-passed gist, so a
// consumer that serializes or prompts from a hit cannot forward private prose
// along the typed path. The bound on that claim is stated in CONTRACT.md §4.
//
// These types are additive in 2.x: nothing in the engine reads them yet. The
// adapters (CONTRACT.md §12) and the retrieval core (§7) arrive in later steps.

import type { LintedGist } from './public-safe.js';

export type { LintedGist } from './public-safe.js';

/** A catalogue number on an entity or a person. One bucket; the scheme set is
 *  open (isbn, isrc, iswc, ipi, isni, doi, orcid, url, spotify, wikidata, ...). */
export interface Identifier {
  scheme: string;
  value: string;
}

/** Where a fragment sits in its entity. One shape for every scheme (whole,
 *  page, chapter, section, paragraph, timecode, chunk, note, ...). `end` is set
 *  only for ranges and is inclusive. `timecode` values are decimal seconds. */
export interface Locator {
  scheme: string;
  value: string;
  end?: string;
}

/** Who made or spoke something. On an entity: creators. On a fragment: the
 *  speakers in that window. A placeholder entry is not a person. */
export interface Attribution {
  name: string;
  role?: string;
  identifiers?: Identifier[];
  /** `unnamed`: a speaker who is not a creator and is not named (today's
   *  "Other"). `unverified`: attribution not established. */
  placeholder?: 'unnamed' | 'unverified';
}

export type Exposure = 'text' | 'semantic' | 'locator' | 'none';

/** The exposures a served index can carry. `none` fragments never reach one. */
export type ServedExposure = Exclude<Exposure, 'none'>;

/** private + text is not a member of this union. */
export type Disclosure =
  | { raw: 'public'; exposure: Exposure }
  | { raw: 'private'; exposure: 'semantic' | 'locator' | 'none' };

export interface EntityPolicy {
  /** When true, a gist is servable only once `projection.review === 'reviewed'`. */
  requireReview?: boolean;
}

export interface Entity {
  /** `${type}:${slug}`. Today's record ids are kept. */
  id: string;
  /** Open: book, paper, essay, song, album, episode, transcript, page, letter, ... */
  type: string;
  title: string;
  /** Creators. */
  attribution: Attribution[];
  /** YYYY, YYYY-MM, or YYYY-MM-DD. Absent means unknown, never guessed. */
  date?: string;
  /** Edition, preprint version, "manuscript". */
  version?: string;
  /** The accountable surface a citation links to. */
  url: string;
  identifiers: Identifier[];
  /** The entity this one belongs to (a transcript's episode). */
  parent?: string;
  /** Consumer boost input. */
  themes?: string[];
  /** Entity default. A fragment may override `exposure`, never `raw`. */
  disclosure: Disclosure;
  policy?: EntityPolicy;
}

interface ProjectionBase {
  source: 'generated' | 'edited';
  review: 'unreviewed' | 'reviewed';
  vetoed?: boolean;
  /** An edited gist whose fragment text changed afterwards. Not servable. */
  stale?: boolean;
  /** sha1(fragment.text + promptVersion + model). */
  contentHash: string;
  model?: string;
  promptVersion?: string;
  generatedAt?: string;
}

/** A stored description of what a fragment is about. Private material until a
 *  policy releases it (CONTRACT.md §5). A failed draft is kept for editing and
 *  is never servable; the lint-passed arm is the only one that carries a gist. */
export type SemanticProjection =
  | (ProjectionBase & { lint: 'passed'; gist: LintedGist })
  | (ProjectionBase & { lint: 'failed'; draft: string });

/** Index-side. `disclosure` is the RESOLVED policy (CONTRACT.md §3), stored at build. */
export interface Fragment {
  /** `${entityId}#${key}`: book:x#p184, transcript:y#12, writing:z#s3. */
  id: string;
  entityId: string;
  locator: Locator[];
  /** The embedded text; '' in a served index unless exposure is `text`. */
  text: string;
  /** `raw` equals the entity's; `exposure` is the resolved value. */
  disclosure: Disclosure;
  projection?: SemanticProjection;
  /** Speakers in this window. */
  attribution?: Attribution[];
  /** Overrides the entity date for this fragment. */
  date?: string;
  /** A public liftable summary; '' in a served index unless exposure is `text`. */
  summary?: string;
  themes?: string[];
  /** Review of the SOURCE (transcript attribution). Not the gist's review. */
  sourceReview?: 'unreviewed' | 'in-review' | 'reviewed';
}

/** What retrieve() returns. Internal to the process; never serialized. */
export interface ScoredHit {
  fragment: Fragment;
  entity: Entity;
  cosine: number;
  score: number;
  /** { cosine, ...one entry per plugin that fired } */
  breakdown: Record<string, number>;
}

/** The provenance every hit carries, regardless of exposure. */
export interface EvidenceHitBase {
  fragmentId: string;
  entity: Pick<
    Entity,
    'id' | 'type' | 'title' | 'attribution' | 'date' | 'version' | 'url' | 'identifiers' | 'parent' | 'themes'
  >;
  /** The policy dimension, not a content field. */
  raw: 'public' | 'private';
  locator: Locator[];
  /** Rendered from `locator` by renderLocatorLabel(): "p. 184", "12:30–14:05". */
  locatorLabel: string;
  /** The effective date: fragment.date ?? entity.date. Absent only when both are unknown. */
  date?: string;
  /** The speakers in this window; present whenever the fragment carries speaker data. */
  attribution?: Attribution[];
  /** Public hits: full precision. Private hits: rounded to 0.05 (CONTRACT.md §4). */
  score: number;
  /** Public hits only; omitted on private hits (CONTRACT.md §4). */
  breakdown?: Record<string, number>;
}

/** The wire type and the boundary. A private fragment's text has no field to
 *  travel in. There is no `none` variant: such fragments are not in a served index. */
export type EvidenceHit =
  | (EvidenceHitBase & { exposure: 'text'; text: string; summary?: string })
  | (EvidenceHitBase & {
      exposure: 'semantic';
      gist: LintedGist;
      gistSource: 'generated' | 'edited';
      gistReview: 'unreviewed' | 'reviewed';
    })
  | (EvidenceHitBase & { exposure: 'locator' });

export interface SearchFilters {
  type?: string[];
  /** YYYY, YYYY-MM, or YYYY-MM-DD; interval semantics (CONTRACT.md §7). */
  dateFrom?: string;
  dateTo?: string;
  /** Default 'exclude' when a bound is set. */
  undated?: 'include' | 'exclude';
  /** Name match on entity creators. */
  creator?: string;
  /** Name match on fragment speakers; placeholders never match. */
  speaker?: string;
  exposure?: ServedExposure[];
  raw?: 'public' | 'private';
}

export interface SearchRequest {
  q: string;
  /** 1..20, default 10; the total across exposures after filters and floor. */
  limit?: number;
  filters?: SearchFilters;
  recency?: 'none' | 'prefer-recent' | 'auto';
}

export interface SearchResponse {
  contract: 'archive-search/1';
  query: string;
  hits: EvidenceHit[];
  /** Hits above the floor after filters, before `limit`. */
  matched: number;
  /** Fragments dropped by a date bound because they carry no date. */
  excludedUndated: number;
  /** Served counts. No embedding model or dimensions (CONTRACT.md §10). */
  index: { builtAt: string; entityCount: number; fragmentCount: number };
  /** The fixed copy of CONTRACT.md §8. */
  policy: { exposure: Record<ServedExposure, string>; note: string };
}
