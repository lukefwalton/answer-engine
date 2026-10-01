// Projections: proposed by the system, authorized by the author
// (docs/CONTRACT.md §5). This file is the proposing half. A drafter turns a
// fragment's text into a one-paragraph catalogue note; draftProjections runs
// the drafter only where the author asked for a gist, lints every draft
// (src/public-safe.ts assertSemanticProjection), keeps an author's edits over
// anything generated, and marks an edited gist stale when the text under it
// moved. Nothing here decides what is served: resolveDisclosure does that,
// from the projection this file stores and the policy the author sets.
//
// The drafter is an interface so the tests run keyless with a fake. The
// shipped implementation calls the Responses API with `store: false` and a
// JSON-schema output; what the provider keeps from that call is governed by
// its data-use terms (CONTRACT.md §10, provider custody).

import type OpenAI from 'openai';

import { isReasoningModel } from '../answer.js';
import type { Entity, Exposure, Locator, SemanticProjection } from '../contract.js';
import { renderLocatorLabel } from '../locator.js';
import {
  assertSemanticProjection,
  entityLintText,
  GIST_MAX_CHARS,
  GIST_NGRAM_CHARS,
  GIST_NGRAM_WORDS,
} from '../public-safe.js';
import { projectionContentHash } from './projections.js';

/** Bump when the instructions below change in a way that should redraft every
 *  generated gist. Edited gists are never redrafted. */
export const GIST_PROMPT_VERSION = 'gist/1';

export const GIST_TIMEOUT_MS = 120_000;

export interface GistDraftRequest {
  fragmentId: string;
  fragmentText: string;
  entity: { type: string; title: string };
  locatorLabel: string;
  /** Proper names the gist may use. Empty: none (the pre-publication default). */
  allowedNames: readonly string[];
  maxChars: number;
  ngramWords: number;
  /** Set on the one retry: the draft the lint refused and why. */
  rejected?: { draft: string; reason: string };
}

export interface GistDrafter {
  /** Recorded on every projection it produces. */
  readonly model: string;
  draft(request: GistDraftRequest): Promise<string>;
}

/** The instructions, versioned by GIST_PROMPT_VERSION. */
export function buildGistInstructions(request: GistDraftRequest): string {
  const names =
    request.allowedNames.length > 0
      ? `The only proper names you may use are: ${request.allowedNames.join(', ')}. Refer to anyone or anything else by role or kind.`
      : 'Use no proper names at all: refer to people, places, and invented things by role or kind.';
  return `You write catalogue notes for a private archive. A note stands in for a passage that readers will not see, so it must say what the passage is about without giving them the passage.

Write ONE paragraph of at most ${request.maxChars} characters, in the third person, describing what the passage is about: its situation, its subject, its themes. Do not evaluate it.

Hard rules:
- Describe; do not quote or closely paraphrase. Never reproduce ${request.ngramWords} or more consecutive words of the passage.
- No dialogue, no distinctive phrases, numbers, dates, or wording lifted from the passage.
- ${names}
- No line breaks. No preamble such as "This passage".

Return JSON in the exact schema you were given: {"gist": string}.`;
}

/** The user turn: provenance the gist may rely on, then the passage. */
export function buildGistInput(request: GistDraftRequest): string {
  const lines = [
    `Entity: ${request.entity.type}, "${request.entity.title}"`,
    `Location: ${request.locatorLabel}`,
  ];
  if (request.rejected) {
    lines.push(
      '',
      `Your previous note was rejected by the lint: ${request.rejected.reason}`,
      `Previous note: ${request.rejected.draft}`,
      'Write a new note that describes the passage without reusing its wording.',
    );
  }
  lines.push('', 'Passage:', request.fragmentText);
  return lines.join('\n');
}

export const GIST_TEXT_FORMAT = {
  type: 'json_schema' as const,
  name: 'archive_gist',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['gist'],
    properties: { gist: { type: 'string' } },
  },
};

/** The client surface the drafter needs; OpenAI satisfies it, and so does a fake. */
export type GistClient = Pick<OpenAI, 'responses'>;

export function createOpenAIGistDrafter(client: GistClient, options: { model: string }): GistDrafter {
  return {
    model: options.model,
    async draft(request) {
      const response = await client.responses.create(
        {
          model: options.model,
          store: false,
          instructions: buildGistInstructions(request),
          input: buildGistInput(request),
          ...(isReasoningModel(options.model) ? { reasoning: { effort: 'low' } } : { temperature: 0 }),
          text: { format: GIST_TEXT_FORMAT },
        },
        { timeout: GIST_TIMEOUT_MS },
      );
      const content = response.output_text;
      if (!content) throw new Error(`gist drafter returned nothing for '${request.fragmentId}'`);
      const parsed = JSON.parse(content) as { gist?: unknown };
      if (typeof parsed.gist !== 'string') {
        throw new Error(`gist drafter returned no 'gist' string for '${request.fragmentId}'`);
      }
      return parsed.gist;
    },
  };
}

// ─── draftProjections ────────────────────────────────────────────────────────

/** What the drafting step needs to know about one fragment. */
export interface ProjectionDraftInput {
  id: string;
  text: string;
  locator: Locator[];
  /** The exposure the author asked for (entity default or fragment override). */
  requested: Exposure;
}

export interface DraftProjectionsOptions {
  /** The stored projections, keyed by fragment id (the author's file). */
  existing?: ReadonlyMap<string, SemanticProjection>;
  allowedNames?: readonly string[];
  /** Redraft generated gists even when current; `true` for all, or a set of fragment ids. */
  regenerate?: boolean | ReadonlySet<string>;
  /** Injected for tests. */
  now?: () => string;
  /** Where errors point. Default: the entity id. */
  path?: string;
}

export interface DraftProjectionsResult {
  /** Every fragment that has a projection afterwards: drafted, kept, or carried. */
  projections: Map<string, SemanticProjection>;
  stats: { drafted: number; skipped: number; kept: number; failed: number; stale: number; carried: number };
  /** Fragments whose gist is not servable afterwards, with the reason, for the operator. */
  unservable: { fragmentId: string; reason: string }[];
}

function lintMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Draft, keep, or carry a projection for every fragment of one entity
 * (docs/CONTRACT.md §5). Only fragments whose requested exposure is
 * `semantic` are ever sent to the drafter. Rules, in order:
 *
 * - An `edited` projection is never overwritten. It is re-linted against the
 *   current text (so a hand edit that quotes fails here, not in a served
 *   index), and marked `stale` when the text it was edited against has moved.
 * - A `generated` projection whose hash, model, and prompt version all match
 *   is kept as it is, unless `regenerate` names it. A failed draft that is
 *   still current is kept too: it waits for an edit, not another call.
 * - Otherwise the drafter is called, the draft is linted against the fragment
 *   text and the whole entity's text, and one retry carries the lint's
 *   reason. A second failure is stored as `lint: 'failed'` with the draft.
 * - A veto carries over a redraft; review does not (new text, unreviewed).
 * - A projection stored for a fragment no longer requested as `semantic` is
 *   carried through untouched, so flipping a policy back costs no call.
 *
 * The lint's window is the entity's `policy.lint` where set, the shipped
 * constants otherwise: the same reading the index validator makes at load
 * (src/store.ts), so what passes here passes there.
 */
export async function draftProjections(
  entity: Pick<Entity, 'id' | 'type' | 'title' | 'policy'>,
  fragments: readonly ProjectionDraftInput[],
  drafter: GistDrafter,
  options: DraftProjectionsOptions = {},
): Promise<DraftProjectionsResult> {
  const existing = options.existing ?? new Map<string, SemanticProjection>();
  const maxChars = entity.policy?.lint?.gistMaxChars ?? GIST_MAX_CHARS;
  const ngramWords = entity.policy?.lint?.ngramWords ?? GIST_NGRAM_WORDS;
  const ngramChars = entity.policy?.lint?.ngramChars ?? GIST_NGRAM_CHARS;
  const now = options.now ?? (() => new Date().toISOString());
  const where = options.path ?? entity.id;
  const entityText = entityLintText(fragments);
  const lintContext = (fragmentId: string, fragmentText: string) => ({
    path: `${where} ${fragmentId}`,
    fragmentText,
    ...(fragments.length > 1 ? { entityText } : {}),
    maxChars,
    ngramWords,
    ngramChars,
  });
  const wantsRedraft = (id: string): boolean =>
    options.regenerate === true || (options.regenerate instanceof Set && options.regenerate.has(id));

  const projections = new Map<string, SemanticProjection>();
  const stats = { drafted: 0, skipped: 0, kept: 0, failed: 0, stale: 0, carried: 0 };
  const unservable: DraftProjectionsResult['unservable'] = [];

  for (const fragment of fragments) {
    const prior = existing.get(fragment.id);
    if (fragment.requested !== 'semantic') {
      if (prior) {
        projections.set(fragment.id, prior);
        stats.carried += 1;
      }
      continue;
    }
    const contentHash = projectionContentHash(fragment.text);

    if (prior?.source === 'edited') {
      const stale = prior.contentHash !== contentHash;
      const text = prior.lint === 'passed' ? prior.gist : prior.draft;
      // Rebuild from the base fields so a draft that now passes carries no
      // `draft`, one that now fails carries no `gist`, and `stale` is current.
      const { gist: _gist, draft: _draft, stale: _stale, lint: _lint, ...base } = prior as SemanticProjection & {
        gist?: string;
        draft?: string;
      };
      const flags = stale ? { stale: true as const } : {};
      let projection: SemanticProjection;
      try {
        const gist = assertSemanticProjection(text, lintContext(fragment.id, fragment.text));
        projection = { ...base, ...flags, lint: 'passed', gist };
      } catch (err) {
        projection = { ...base, ...flags, lint: 'failed', draft: text };
        unservable.push({ fragmentId: fragment.id, reason: `edited gist fails the lint: ${lintMessage(err)}` });
      }
      if (stale) {
        stats.stale += 1;
        unservable.push({ fragmentId: fragment.id, reason: 'edited gist is stale: the fragment text changed since the edit' });
      }
      if (prior.vetoed) unservable.push({ fragmentId: fragment.id, reason: 'vetoed' });
      projections.set(fragment.id, projection);
      stats.kept += 1;
      continue;
    }

    const current =
      prior !== undefined &&
      prior.contentHash === contentHash &&
      prior.model === drafter.model &&
      prior.promptVersion === GIST_PROMPT_VERSION;
    if (prior && current && !wantsRedraft(fragment.id)) {
      if (prior.lint === 'passed') {
        try {
          assertSemanticProjection(prior.gist, lintContext(fragment.id, fragment.text));
          projections.set(fragment.id, prior);
          if (prior.vetoed) unservable.push({ fragmentId: fragment.id, reason: 'vetoed' });
          stats.skipped += 1;
          continue;
        } catch {
          // The lint's settings tightened since this was drafted: redraft below.
        }
      } else {
        projections.set(fragment.id, prior);
        unservable.push({ fragmentId: fragment.id, reason: 'stored draft failed the lint; edit it in the projections file' });
        stats.skipped += 1;
        continue;
      }
    }

    const base = {
      source: 'generated' as const,
      review: 'unreviewed' as const,
      ...(prior?.vetoed ? { vetoed: true } : {}),
      contentHash,
      model: drafter.model,
      promptVersion: GIST_PROMPT_VERSION,
      generatedAt: now(),
    };
    const request: GistDraftRequest = {
      fragmentId: fragment.id,
      fragmentText: fragment.text,
      entity: { type: entity.type, title: entity.title },
      locatorLabel: renderLocatorLabel(fragment.locator),
      allowedNames: options.allowedNames ?? [],
      maxChars,
      ngramWords,
    };
    let rejected: { draft: string; reason: string } | undefined;
    let settled: SemanticProjection | undefined;
    for (let attempt = 0; attempt < 2 && !settled; attempt += 1) {
      const draft = await drafter.draft(rejected ? { ...request, rejected } : request);
      try {
        const gist = assertSemanticProjection(draft, lintContext(fragment.id, fragment.text));
        settled = { ...base, lint: 'passed', gist };
      } catch (err) {
        rejected = { draft, reason: lintMessage(err) };
      }
    }
    if (settled) {
      stats.drafted += 1;
      if (settled.vetoed) unservable.push({ fragmentId: fragment.id, reason: 'vetoed' });
    } else {
      settled = { ...base, lint: 'failed', draft: rejected!.draft };
      stats.failed += 1;
      unservable.push({ fragmentId: fragment.id, reason: `draft failed the lint twice: ${rejected!.reason}` });
    }
    projections.set(fragment.id, settled);
  }

  return { projections, stats, unservable };
}
