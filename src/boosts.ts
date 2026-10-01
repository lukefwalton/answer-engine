// The built-in boosts (docs/CONTRACT.md §7). Each is a BoostPlugin with its
// constant exported; a consumer composes its own list, adds its own plugins
// (author aliases, guest speech, distinctive query n-grams, a cap on hub
// pages), and drops any of these.
//
// DEFAULT_PLUGINS reproduces the 2.x teaching scoring exactly: an exact
// title-or-slug match and a curated-theme match, on public fragments only,
// because 2.x boosted records and never notes. That is what keeps the demo's
// certified verdicts where they are. The richer set (both layers, recency,
// disclosure) is opt-in: see ALL_BUILTIN_PLUGINS and each factory's options.

import { slugOf } from './adapters/teaching.js';
import type { Entity, Fragment } from './contract.js';
import { effectiveDate, parseDateInterval } from './dates.js';
import type { BoostPlugin, QueryContext, RetrievalIndex } from './retrieve.js';
import { containsPhrase } from './text.js';

/** Additive boost when the query names the entity (title or slug). Enough to
 *  beat a close semantic neighbor, not enough to drown relevance. */
export const EXACT_MATCH_BOOST = 0.3;

/** Additive boost when the query uses one of the entity's curated themes
 *  verbatim. Metadata you maintain earns retrieval gravity raw similarity can't. */
export const THEME_BOOST = 0.15;

/** Recency: full boost inside the fresh window, decaying linearly to zero. */
export const RECENCY_BOOST = 0.1;
export const RECENCY_FRESH_DAYS = 180;
export const RECENCY_FLOOR_DAYS = 730;

/** Disclosure: public fragments, and private ones whose source has been
 *  reviewed, outrank unreviewed private material (production's W_PUBLIC). */
export const DISCLOSURE_BOOST = 0.15;

/** A theme carried by more than this fraction of entities names the archive,
 *  not an entity, and boosts nothing. */
export const THEME_DF_CAP_FRACTION = 0.05;
/** ...but only once the corpus is large enough for the fraction to mean
 *  something: a theme is excluded when its document frequency exceeds
 *  max(THEME_DF_MIN_EXCLUDE, ceil(fraction × entities)). On eight records the
 *  cap is four, so a theme on three of them still boosts. */
export const THEME_DF_MIN_EXCLUDE = 4;

type Layer = 'public' | 'private';
interface LayerOptions {
  /** Which raw layers the boost may fire on. Default: both. */
  layers?: readonly Layer[];
}

function fires(layers: readonly Layer[] | undefined, fragment: Fragment): boolean {
  return !layers || layers.includes(fragment.disclosure.raw);
}

export function exactTitleMatch(options: LayerOptions & { boost?: number } = {}): BoostPlugin {
  const boost = options.boost ?? EXACT_MATCH_BOOST;
  return {
    name: 'exactMatch',
    score(fragment, entity, ctx) {
      if (!fires(options.layers, fragment)) return 0;
      return containsPhrase(ctx.query, entity.title) || containsPhrase(ctx.query, slugOf(entity.id)) ? boost : 0;
    },
  };
}

function normalizeTheme(theme: string): string {
  return theme.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** The set of themes rare enough to discriminate between entities. */
export function discriminatingThemes(
  entities: Iterable<Entity>,
  fraction: number = THEME_DF_CAP_FRACTION,
  minExclude: number = THEME_DF_MIN_EXCLUDE,
): Set<string> {
  const df = new Map<string, number>();
  let n = 0;
  for (const entity of entities) {
    n += 1;
    for (const theme of new Set((entity.themes ?? []).map(normalizeTheme))) {
      if (!theme) continue;
      df.set(theme, (df.get(theme) ?? 0) + 1);
    }
  }
  const cap = Math.max(minExclude, Math.ceil(n * fraction));
  return new Set([...df.entries()].filter(([, count]) => count <= cap).map(([theme]) => theme));
}

export function themeMatch(
  options: LayerOptions & { boost?: number; dfCap?: false | { fraction?: number; minExclude?: number } } = {},
): BoostPlugin<ReadonlySet<string> | null> {
  const boost = options.boost ?? THEME_BOOST;
  return {
    name: 'theme',
    prepare(index: RetrievalIndex) {
      if (options.dfCap === false) return null;
      return discriminatingThemes(index.entities.values(), options.dfCap?.fraction, options.dfCap?.minExclude);
    },
    score(fragment, entity, ctx, eligible) {
      if (!fires(options.layers, fragment)) return 0;
      const themes = fragment.themes ?? entity.themes ?? [];
      const hit = themes.some((theme) => {
        if (eligible && !eligible.has(normalizeTheme(theme))) return false;
        return containsPhrase(ctx.query, theme);
      });
      return hit ? boost : 0;
    },
  };
}

/** Words that mark a query as asking about the present (drives `recency: 'auto'`). */
export const CURRENT_VIEWS_WORDS = [
  'current', 'currently', 'now', 'today', 'recent', 'recently', 'latest', 'present', 'still', 'these days', 'right now',
];

export function queryIsAboutNow(query: string): boolean {
  return CURRENT_VIEWS_WORDS.some((word) => containsPhrase(query, word));
}

/** Linear decay: 1 inside the fresh window, 0 past the floor, interpolated between. */
export function recencyFactor(date: string | undefined, asOf: Date): number {
  const interval = parseDateInterval(date);
  if (!interval) return 0;
  const days = (asOf.getTime() - interval.start) / (1000 * 60 * 60 * 24);
  if (days <= RECENCY_FRESH_DAYS) return 1;
  if (days >= RECENCY_FLOOR_DAYS) return 0;
  return 1 - (days - RECENCY_FRESH_DAYS) / (RECENCY_FLOOR_DAYS - RECENCY_FRESH_DAYS);
}

export function recency(options: LayerOptions & { boost?: number } = {}): BoostPlugin {
  const boost = options.boost ?? RECENCY_BOOST;
  return {
    name: 'recency',
    score(fragment, entity, ctx: QueryContext) {
      if (!fires(options.layers, fragment)) return 0;
      if (ctx.recency === 'none') return 0;
      if (ctx.recency === 'auto' && !queryIsAboutNow(ctx.query)) return 0;
      return boost * recencyFactor(effectiveDate(fragment, entity), ctx.asOf);
    },
  };
}

export function disclosure(options: { boost?: number } = {}): BoostPlugin {
  const boost = options.boost ?? DISCLOSURE_BOOST;
  return {
    name: 'disclosure',
    score(fragment) {
      if (fragment.disclosure.raw === 'public') return boost;
      return fragment.sourceReview === 'reviewed' ? boost : 0;
    },
  };
}

/** 2.x teaching scoring, exactly: records get exact-match and theme boosts;
 *  notes ride on cosine alone. */
export const DEFAULT_PLUGINS: readonly BoostPlugin[] = [
  exactTitleMatch({ layers: ['public'] }),
  themeMatch({ layers: ['public'] }),
];

/** Every built-in, on both layers, for a consumer that wants the full set. */
export const ALL_BUILTIN_PLUGINS: readonly BoostPlugin[] = [exactTitleMatch(), themeMatch(), recency(), disclosure()];
