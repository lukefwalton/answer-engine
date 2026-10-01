// Retrieval (docs/CONTRACT.md §7): brute-force cosine over every served
// fragment, filters before scoring, boosts after it, a floor, a ranking, and
// a cap. What this module guarantees is about what a hit may carry, never
// whether a hit is relevant; relevance is tuned by each consumer against its
// gold suite, through the plugin seam below.
//
// The result is ScoredHit[]: fragment + entity + scores. It is internal to
// the process and never serialized; the one crossing to anything a model or a
// caller may see is project() in no-leak.ts, and search() below is
// retrieve().map(project) for consumers that should never hold a ScoredHit.
//
// Hits below the score floor are dropped so weak matches can't masquerade as
// evidence; an empty result is what lets a consumer say "I don't know." A
// relevant source below the floor is simply absent, and absence is the one
// thing no downstream gate can catch.

import { DEFAULT_PLUGINS } from './boosts.js';
import type { Entity, Fragment, ScoredHit, SearchFilters } from './contract.js';
import { effectiveDate, intervalsIntersect, parseDateInterval } from './dates.js';
import type { IndexFile, ServedIndexFile } from './store.js';
import { assertHomogeneousEntries } from './store.js';
import { containsPhrase, normalizeText } from './text.js';

export { containsPhrase, normalizeText } from './text.js';

/** Hits scoring below this are not evidence. Tune against your own corpus.
 *  The floor defines what becomes a candidate upstream — a visible, versioned
 *  constant, not an emergent property of the model. */
export const SCORE_FLOOR = 0.2;

/** 2.x's per-stream top-k: up to this many public and this many private hits. */
export const DEFAULT_LIMIT_PER_RAW = 8;

export interface RetrievalIndex {
  entities: ReadonlyMap<string, Entity>;
  entries: ReadonlyArray<{ fragment: Fragment; vector: readonly number[] }>;
  /** The one (model, dimensions) pair every vector shares; what a query must be embedded with. */
  model: string;
  dimensions: number;
}

export type RecencyMode = 'none' | 'prefer-recent' | 'auto';

export interface QueryContext {
  query: string;
  /** normalizeText(query). */
  normalized: string;
  asOf: Date;
  recency: RecencyMode;
}

/** A boost: a named, additive contribution to a fragment's score. `prepare`
 *  runs once per query over the whole index (for document-frequency work). */
export interface BoostPlugin<P = unknown> {
  name: string;
  prepare?(index: RetrievalIndex, ctx: QueryContext): P;
  score(fragment: Fragment, entity: Entity, ctx: QueryContext, prepared: P): number;
}

/** A re-ranking pass over the floored, sorted hits (caps on a class of hit, say). */
export interface PostRank {
  name: string;
  apply(ranked: ScoredHit[], ctx: QueryContext): ScoredHit[];
}

export interface RetrieveOptions {
  scoreFloor?: number;
  /** One ranked list capped at this total. Exclusive with limitPerRaw. */
  limit?: number;
  /** Each raw layer ranked and capped separately (2.x behaviour; default 8/8). */
  limitPerRaw?: { public?: number; private?: number };
  filters?: SearchFilters;
  recency?: RecencyMode;
  /** Default: DEFAULT_PLUGINS (src/boosts.ts), which reproduces 2.x scoring. */
  plugins?: readonly BoostPlugin[];
  postRank?: readonly PostRank[];
  asOf?: Date;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: dimension mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** Zip a private or served index file into the in-memory shape retrieval
 *  scans. Throws on a dangling entity or mixed embedding specs. */
export function buildRetrievalIndex(file: IndexFile | ServedIndexFile): RetrievalIndex {
  assertHomogeneousEntries(file.entries);
  const entities = new Map(file.entities.map((e) => [e.id, e]));
  const entries = file.entries.map((entry) => {
    if (!entities.has(entry.fragment.entityId)) {
      throw new Error(`fragment '${entry.fragment.id}' names unknown entity '${entry.fragment.entityId}'.`);
    }
    return { fragment: entry.fragment as Fragment, vector: entry.vector };
  });
  const first = file.entries[0];
  return {
    entities,
    entries,
    model: first?.model ?? '',
    dimensions: first?.dimensions ?? 0,
  };
}

// ─── Filters ─────────────────────────────────────────────────────────────────

function nameMatches(attribution: readonly { name: string; placeholder?: string }[] | undefined, wanted: string): boolean {
  if (!attribution) return false;
  return attribution.some((a) => a.placeholder === undefined && containsPhrase(a.name, wanted));
}

/** The filter predicate for one request, plus a counter for the undated
 *  fragments a date bound excluded (CONTRACT.md §7). */
export function compileFilters(filters: SearchFilters | undefined): {
  keep: (fragment: Fragment, entity: Entity) => boolean;
  excludedUndated: () => number;
} {
  if (!filters) return { keep: () => true, excludedUndated: () => 0 };
  if (filters.exposure?.includes('none' as never)) {
    throw new Error("filters.exposure: 'none' is not a served exposure");
  }
  const from = filters.dateFrom !== undefined ? parseDateInterval(filters.dateFrom) : null;
  const to = filters.dateTo !== undefined ? parseDateInterval(filters.dateTo) : null;
  if (filters.dateFrom !== undefined && !from) throw new Error(`filters.dateFrom '${filters.dateFrom}' is not YYYY, YYYY-MM, or YYYY-MM-DD`);
  if (filters.dateTo !== undefined && !to) throw new Error(`filters.dateTo '${filters.dateTo}' is not YYYY, YYYY-MM, or YYYY-MM-DD`);
  const bound = from || to ? { start: from?.start ?? -Infinity, end: to?.end ?? Infinity } : null;
  const includeUndated = filters.undated === 'include';
  const types = filters.type ? new Set(filters.type) : null;
  const exposures = filters.exposure ? new Set<string>(filters.exposure) : null;
  let undated = 0;

  return {
    keep(fragment, entity) {
      if (types && !types.has(entity.type)) return false;
      if (filters.raw && fragment.disclosure.raw !== filters.raw) return false;
      if (exposures && !exposures.has(fragment.disclosure.exposure)) return false;
      if (filters.creator !== undefined && !nameMatches(entity.attribution, filters.creator)) return false;
      if (filters.speaker !== undefined && !nameMatches(fragment.attribution, filters.speaker)) return false;
      if (bound) {
        const interval = parseDateInterval(effectiveDate(fragment, entity));
        if (!interval) {
          if (!includeUndated) {
            undated += 1;
            return false;
          }
          return true;
        }
        if (!intervalsIntersect(interval, bound)) return false;
      }
      return true;
    },
    excludedUndated: () => undated,
  };
}

// ─── Retrieval ───────────────────────────────────────────────────────────────

export interface RetrievalOutcome {
  hits: ScoredHit[];
  /** Hits above the floor after filters, before the cap. */
  matched: number;
  /** Fragments a date bound dropped because they carry no date. */
  excludedUndated: number;
}

/** retrieve() with the counts a retrieval-only consumer reports. */
export function retrieveWithCounts(
  queryVector: readonly number[],
  query: string,
  index: RetrievalIndex,
  options: RetrieveOptions = {},
): RetrievalOutcome {
  if (options.limit !== undefined && options.limitPerRaw !== undefined) {
    throw new Error('retrieve: pass either limit or limitPerRaw, not both');
  }
  const floor = options.scoreFloor ?? SCORE_FLOOR;
  const ctx: QueryContext = {
    query,
    normalized: normalizeText(query),
    asOf: options.asOf ?? new Date(),
    recency: options.recency ?? 'auto',
  };
  const plugins = options.plugins ?? DEFAULT_PLUGINS;
  const prepared = plugins.map((p) => (p.prepare ? p.prepare(index, ctx) : undefined));
  const filter = compileFilters(options.filters);

  const scored: ScoredHit[] = [];
  for (const { fragment, vector } of index.entries) {
    const entity = index.entities.get(fragment.entityId);
    if (!entity) throw new Error(`fragment '${fragment.id}' names unknown entity '${fragment.entityId}'.`);
    if (!filter.keep(fragment, entity)) continue;
    const c = cosine(queryVector, vector);
    const breakdown: Record<string, number> = { cosine: c };
    let score = c;
    plugins.forEach((plugin, i) => {
      const v = plugin.score(fragment, entity, ctx, prepared[i]);
      if (v !== 0) {
        breakdown[plugin.name] = v;
        score += v;
      }
    });
    scored.push({ fragment, entity, cosine: c, score, breakdown });
  }

  let ranked = scored
    .filter((h) => h.score >= floor)
    .sort((a, b) => b.score - a.score || a.fragment.id.localeCompare(b.fragment.id));
  for (const pass of options.postRank ?? []) ranked = pass.apply(ranked, ctx);
  const matched = ranked.length;

  let hits: ScoredHit[];
  if (options.limit !== undefined) {
    hits = ranked.slice(0, Math.max(0, options.limit));
  } else {
    const per = options.limitPerRaw ?? {};
    const caps = { public: per.public ?? DEFAULT_LIMIT_PER_RAW, private: per.private ?? DEFAULT_LIMIT_PER_RAW };
    const taken = { public: 0, private: 0 };
    hits = ranked.filter((h) => {
      const layer = h.fragment.disclosure.raw;
      if (taken[layer] >= caps[layer]) return false;
      taken[layer] += 1;
      return true;
    });
  }
  return { hits, matched, excludedUndated: filter.excludedUndated() };
}

/** Score, floor, rank, and cap. See RetrieveOptions for the two cap shapes. */
export function retrieve(
  queryVector: readonly number[],
  query: string,
  index: RetrievalIndex,
  options: RetrieveOptions = {},
): ScoredHit[] {
  return retrieveWithCounts(queryVector, query, index, options).hits;
}

/** The 2.x two-list shape, for consumers that treat the layers differently. */
export function partitionByRaw(hits: readonly ScoredHit[]): { public: ScoredHit[]; private: ScoredHit[] } {
  return {
    public: hits.filter((h) => h.fragment.disclosure.raw === 'public'),
    private: hits.filter((h) => h.fragment.disclosure.raw === 'private'),
  };
}
