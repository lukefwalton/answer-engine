// The wire contract for a retrieval-only consumer (docs/CONTRACT.md §8). The
// consumer owns the transport (HTTP, MCP); this module owns what travels: the
// contract version, the fixed policy copy a response carries verbatim, and the
// one function that turns a search outcome into a SearchResponse. It takes
// the outcome of searchWithCounts (src/no-leak.ts), whose hits have already
// crossed through project() behind the served-exposure filter, and nothing
// else: a RetrievalOutcome does not fit its parameter, so a consumer cannot
// project around the filter here. A consumer that uses toSearchResponse never
// holds a ScoredHit on its wire path and never retypes the normative copy.

import type { SearchResponse, ServedExposure } from './contract.js';
import type { SearchOutcome } from './no-leak.js';

export const ARCHIVE_SEARCH_CONTRACT = 'archive-search/1' as const;

/** The fixed copy of CONTRACT.md §8, normative. Rewording it is not a contract
 *  bump; changing what it asserts is. test/wire.test.ts pins it to the document. */
export const ARCHIVE_SEARCH_POLICY: SearchResponse['policy'] = {
  exposure: {
    text: 'The passage is public and is included verbatim. Quote it with its entity.url.',
    semantic:
      "The source is not quotable here. gist is a description of what the passage is about, drafted by the archive's software at ingest and released under the archive owner's policy; gistSource says whether a person edited it and gistReview whether a person reviewed it. It is not a quotation and not the creators' wording.",
    locator: 'Only the location of relevant material is released. Do not infer its contents.',
  } satisfies Record<ServedExposure, string>,
  note:
    'Nothing in this response was synthesized at request time. Scores on private hits are rounded. Attribution entries with a placeholder are not people: unnamed is a speaker who is not a creator, unverified is attribution not established. Undated material is excluded when a date bound is given unless undated=include.',
};

/** What a served index reports about itself: counts, never the embedding model
 *  or dimensions (CONTRACT.md §10). */
export interface ServedIndexSummary {
  builtAt: string;
  entityCount: number;
  fragmentCount: number;
}

/** searchWithCounts(...) → the wire shape. The hits arrive projected. */
export function toSearchResponse(
  query: string,
  outcome: SearchOutcome,
  index: ServedIndexSummary,
): SearchResponse {
  return {
    contract: ARCHIVE_SEARCH_CONTRACT,
    query,
    hits: outcome.hits,
    matched: outcome.matched,
    excludedUndated: outcome.excludedUndated,
    index: { builtAt: index.builtAt, entityCount: index.entityCount, fragmentCount: index.fragmentCount },
    policy: ARCHIVE_SEARCH_POLICY,
  };
}
