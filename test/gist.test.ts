// Offline tests for the proposing half of CONTRACT.md §5: the drafter seam,
// draftProjections' rules, and the author's projections file. A scripted fake
// stands in for the model; the OpenAI drafter is exercised against a fake
// client that records what it was asked.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { SemanticProjection } from '../src/contract.js';
import {
  buildGistInput,
  buildGistInstructions,
  createOpenAIGistDrafter,
  draftProjections,
  GIST_PROMPT_VERSION,
  GIST_TEXT_FORMAT,
} from '../src/ingest/gist.js';
import type { GistClient, GistDrafter, GistDraftRequest, ProjectionDraftInput } from '../src/ingest/gist.js';
import {
  projectionContentHash,
  readProjections,
  validateProjections,
  writeProjections,
} from '../src/ingest/projections.js';

const P1 = 'The negotiation had run past midnight before anyone asked who would answer for it.';
const P2 = 'By morning the signatures were dry and the question had not been asked again.';
const ENTITY = { id: 'book:x', type: 'book', title: 'Example' };
const NOW = () => '2026-10-01T00:00:00.000Z';

function frag(page: number, text: string, requested: ProjectionDraftInput['requested'] = 'semantic'): ProjectionDraftInput {
  return { id: `book:x#p${page}`, text, locator: [{ scheme: 'page', value: String(page) }], requested };
}

/** A drafter that returns scripted answers in order and records every request. */
function scripted(responses: readonly string[]): GistDrafter & { requests: GistDraftRequest[] } {
  const queue = [...responses];
  const requests: GistDraftRequest[] = [];
  return {
    model: 'fake-1',
    requests,
    async draft(request) {
      requests.push(request);
      const next = queue.shift();
      if (next === undefined) throw new Error(`scripted drafter has no answer for '${request.fragmentId}'`);
      return next;
    },
  };
}

const CLEAN_1 = 'A late meeting in which responsibility is left unassigned.';
const CLEAN_2 = 'Next day, the deal stands and the open point stays closed.';

test('draftProjections: drafts only where semantic was requested, and records provenance', async () => {
  const drafter = scripted([CLEAN_1]);
  const { projections, stats, unservable } = await draftProjections(
    ENTITY,
    [frag(1, P1), frag(2, P2, 'locator')],
    drafter,
    { now: NOW },
  );
  assert.deepEqual(stats, { drafted: 1, skipped: 0, kept: 0, failed: 0, stale: 0, carried: 0 });
  assert.deepEqual(unservable, []);
  assert.equal(projections.size, 1);
  const p = projections.get('book:x#p1')!;
  assert.deepEqual(p, {
    source: 'generated',
    review: 'unreviewed',
    contentHash: projectionContentHash(P1),
    model: 'fake-1',
    promptVersion: GIST_PROMPT_VERSION,
    generatedAt: NOW(),
    lint: 'passed',
    gist: CLEAN_1,
  });
  // The drafter saw provenance, the names rule, and the lint's window, not the other fragment.
  assert.equal(drafter.requests.length, 1);
  const req = drafter.requests[0]!;
  assert.equal(req.fragmentText, P1);
  assert.equal(req.locatorLabel, 'p. 1');
  assert.deepEqual(req.entity, { type: 'book', title: 'Example' });
  assert.deepEqual(req.allowedNames, []);
  assert.equal(req.ngramWords, 5);
  assert.equal(req.rejected, undefined);
});

test('draftProjections: a quoting draft is retried once with the reason; a second failure is stored failed', async () => {
  const quoting = 'It says the negotiation had run past midnight.';
  const retried = scripted([quoting, CLEAN_1]);
  const ok = await draftProjections(ENTITY, [frag(1, P1)], retried, { now: NOW });
  assert.equal(ok.stats.drafted, 1);
  assert.equal(ok.projections.get('book:x#p1')!.lint, 'passed');
  assert.equal(retried.requests.length, 2);
  const retry = retried.requests[1]!;
  assert.equal(retry.rejected?.draft, quoting);
  // The reason names the position of the run in the draft, never the run: it
  // is printed by `npm run index` and travels in the retry prompt.
  assert.match(retry.rejected!.reason, /quotes the fragment's text at words 3–7: a projection must not contain 5 consecutive words/);
  assert.ok(!retry.rejected!.reason.includes('negotiation'));

  const stubborn = scripted([quoting, 'Still the negotiation had run past midnight, it says.']);
  const failed = await draftProjections(ENTITY, [frag(1, P1)], stubborn, { now: NOW });
  assert.deepEqual(failed.stats, { drafted: 0, skipped: 0, kept: 0, failed: 1, stale: 0, carried: 0 });
  const p = failed.projections.get('book:x#p1')!;
  assert.equal(p.lint, 'failed');
  assert.ok(p.lint === 'failed' && p.draft.startsWith('Still the negotiation'));
  assert.ok(!('gist' in p));
  assert.match(failed.unservable[0]!.reason, /^draft failed the lint twice: .*quotes/);
});

test('draftProjections: the whole entity is the lint text, so a gist cannot quote the page before', async () => {
  // Fragment 1's draft lifts five words from fragment 2.
  const drafter = scripted(['Elsewhere the signatures were dry and the matter rests.', CLEAN_1, CLEAN_2]);
  const { projections, stats } = await draftProjections(ENTITY, [frag(1, P1), frag(2, P2)], drafter, { now: NOW });
  assert.equal(stats.drafted, 2);
  assert.match(drafter.requests[1]!.rejected!.reason, /quotes the entity's text at words 2–6/);
  assert.ok(!drafter.requests[1]!.rejected!.reason.includes('signatures'));
  assert.equal(projections.get('book:x#p1')!.lint, 'passed');
  assert.equal(projections.get('book:x#p2')!.lint, 'passed');
});

test('draftProjections: the window is the entity policy, read the same way the loader reads it', async () => {
  // Four shared words ("who would answer for") pass at the default window...
  const fourWords = 'Someone wonders who would answer for the night.';
  const loose = await draftProjections(ENTITY, [frag(1, P1)], scripted([fourWords]), { now: NOW });
  assert.equal(loose.projections.get('book:x#p1')!.lint, 'passed');
  // ...and fail when the entity tightens it; the drafter is told the window it works under.
  const tight = { ...ENTITY, policy: { lint: { ngramWords: 4, gistMaxChars: 200 } } };
  const drafter = scripted([fourWords, CLEAN_1]);
  const strict = await draftProjections(tight, [frag(1, P1)], drafter, { now: NOW });
  assert.equal(strict.projections.get('book:x#p1')!.lint, 'passed');
  assert.equal(drafter.requests.length, 2);
  assert.equal(drafter.requests[0]!.ngramWords, 4);
  assert.equal(drafter.requests[0]!.maxChars, 200);
  assert.match(drafter.requests[1]!.rejected!.reason, /4 consecutive words/);
});

test('draftProjections: a current generated gist is skipped; text, model, prompt, or regenerate redrafts it', async () => {
  const first = await draftProjections(ENTITY, [frag(1, P1)], scripted([CLEAN_1]), { now: NOW });
  const existing = first.projections;

  // Unchanged: no call at all (the scripted drafter would throw if asked).
  const same = await draftProjections(ENTITY, [frag(1, P1)], scripted([]), { existing, now: NOW });
  assert.equal(same.stats.skipped, 1);
  assert.deepEqual(same.projections.get('book:x#p1'), existing.get('book:x#p1'));

  // Text changed: redrafted.
  const moved = await draftProjections(ENTITY, [frag(1, `${P1} And more.`)], scripted([CLEAN_2]), { existing, now: NOW });
  assert.equal(moved.stats.drafted, 1);
  assert.equal(moved.projections.get('book:x#p1')!.contentHash, projectionContentHash(`${P1} And more.`));

  // Another model: redrafted and recorded.
  const other = scripted([CLEAN_2]);
  (other as { model: string }).model = 'fake-2';
  const remodelled = await draftProjections(ENTITY, [frag(1, P1)], other, { existing, now: NOW });
  assert.equal(remodelled.stats.drafted, 1);
  assert.equal(remodelled.projections.get('book:x#p1')!.model, 'fake-2');

  // Forced, for one id or all.
  const forcedOne = await draftProjections(ENTITY, [frag(1, P1)], scripted([CLEAN_2]), {
    existing,
    regenerate: new Set(['book:x#p1']),
    now: NOW,
  });
  assert.equal(forcedOne.stats.drafted, 1);
  const forcedAll = await draftProjections(ENTITY, [frag(1, P1)], scripted([CLEAN_2]), { existing, regenerate: true, now: NOW });
  assert.equal(forcedAll.stats.drafted, 1);

  // A stored failed draft that is still current waits for an edit, not another call.
  const failedPrior = new Map<string, SemanticProjection>([
    [
      'book:x#p1',
      { ...existing.get('book:x#p1')!, lint: 'failed', draft: 'It says the negotiation had run past midnight.' } as SemanticProjection,
    ],
  ]);
  const waiting = await draftProjections(ENTITY, [frag(1, P1)], scripted([]), { existing: failedPrior, now: NOW });
  assert.equal(waiting.stats.skipped, 1);
  assert.match(waiting.unservable[0]!.reason, /stored draft failed the lint; edit it/);
});

test('draftProjections: edits win, go stale when the text moves, and are re-linted', async () => {
  const edited: SemanticProjection = {
    source: 'edited',
    review: 'reviewed',
    contentHash: projectionContentHash(P1),
    model: 'fake-1',
    promptVersion: GIST_PROMPT_VERSION,
    lint: 'passed',
    gist: 'An author-written note about an unassigned responsibility.' as SemanticProjection extends { gist: infer G } ? G : never,
  };
  const existing = new Map([['book:x#p1', edited]]);

  // Never redrafted; the reviewed flag and the wording survive.
  const kept = await draftProjections(ENTITY, [frag(1, P1)], scripted([]), { existing, now: NOW });
  assert.deepEqual(kept.stats, { drafted: 0, skipped: 0, kept: 1, failed: 0, stale: 0, carried: 0 });
  assert.deepEqual(kept.projections.get('book:x#p1'), edited);

  // The text moved: still kept, now stale, and reported.
  const moved = await draftProjections(ENTITY, [frag(1, `${P1} And more.`)], scripted([]), { existing, now: NOW });
  const stale = moved.projections.get('book:x#p1')!;
  assert.equal(stale.stale, true);
  assert.equal(stale.source, 'edited');
  assert.equal(stale.lint, 'passed');
  assert.equal(moved.stats.stale, 1);
  assert.match(moved.unservable[0]!.reason, /edited gist is stale/);

  // An edit that quotes the text fails the lint at build and keeps the author's words as the draft.
  const quotingEdit = new Map([
    ['book:x#p1', { ...edited, gist: 'Here the negotiation had run past midnight.' } as SemanticProjection],
  ]);
  const refused = await draftProjections(ENTITY, [frag(1, P1)], scripted([]), { existing: quotingEdit, now: NOW });
  const p = refused.projections.get('book:x#p1')!;
  assert.equal(p.lint, 'failed');
  assert.ok(p.lint === 'failed' && p.draft === 'Here the negotiation had run past midnight.');
  assert.equal(p.source, 'edited');
  assert.ok(!('gist' in p));
  assert.match(refused.unservable[0]!.reason, /edited gist fails the lint/);
});

test('draftProjections: a veto survives a redraft, review does not, and a de-exposed projection is carried', async () => {
  const first = await draftProjections(ENTITY, [frag(1, P1)], scripted([CLEAN_1]), { now: NOW });
  const vetoedReviewed = new Map([
    ['book:x#p1', { ...first.projections.get('book:x#p1')!, vetoed: true, review: 'reviewed' } as SemanticProjection],
  ]);

  const redrafted = await draftProjections(ENTITY, [frag(1, `${P1} Changed.`)], scripted([CLEAN_2]), {
    existing: vetoedReviewed,
    now: NOW,
  });
  const p = redrafted.projections.get('book:x#p1')!;
  assert.equal(p.vetoed, true);
  assert.equal(p.review, 'unreviewed');
  assert.deepEqual(redrafted.unservable, [{ fragmentId: 'book:x#p1', reason: 'vetoed' }]);

  // The author flips the note back to locator: the stored gist rides along untouched, no call.
  const carried = await draftProjections(ENTITY, [frag(1, P1, 'locator')], scripted([]), { existing: vetoedReviewed, now: NOW });
  assert.equal(carried.stats.carried, 1);
  assert.deepEqual(carried.projections.get('book:x#p1'), vetoedReviewed.get('book:x#p1'));
});

test('OpenAI drafter: store false, schema output, the names rule, and the retry reason in the input', async () => {
  const calls: unknown[] = [];
  const client = {
    responses: {
      create: async (params: unknown) => {
        calls.push(params);
        return { output_text: JSON.stringify({ gist: CLEAN_1 }) };
      },
    },
  } as unknown as GistClient;
  const drafter = createOpenAIGistDrafter(client, { model: 'gpt-4o-mini' });
  assert.equal(drafter.model, 'gpt-4o-mini');

  const request: GistDraftRequest = {
    fragmentId: 'book:x#p1',
    fragmentText: P1,
    entity: { type: 'book', title: 'Example' },
    locatorLabel: 'p. 1',
    allowedNames: ['Example'],
    maxChars: 400,
    ngramWords: 5,
  };
  assert.equal(await drafter.draft(request), CLEAN_1);
  const params = calls[0] as Record<string, unknown>;
  assert.equal(params.store, false);
  assert.equal(params.model, 'gpt-4o-mini');
  assert.equal(params.temperature, 0);
  assert.deepEqual(params.text, { format: GIST_TEXT_FORMAT });
  assert.equal(params.instructions, buildGistInstructions(request));
  assert.equal(params.input, buildGistInput(request));
  assert.match(buildGistInstructions(request), /at most 400 characters/);
  assert.match(buildGistInstructions(request), /The only proper names you may use are: Example/);
  assert.match(buildGistInstructions({ ...request, allowedNames: [] }), /Use no proper names at all/);
  assert.ok(buildGistInput(request).includes(P1));

  const retry = buildGistInput({ ...request, rejected: { draft: 'bad', reason: 'quotes the fragment' } });
  assert.ok(retry.includes('rejected by the lint: quotes the fragment'));
  assert.ok(retry.includes('Previous note: bad'));

  // Reasoning models get an effort, not a temperature.
  const reasoning = createOpenAIGistDrafter(client, { model: 'gpt-5-mini' });
  await reasoning.draft(request);
  const p2 = calls[1] as Record<string, unknown>;
  assert.equal(p2.temperature, undefined);
  assert.deepEqual(p2.reasoning, { effort: 'low' });

  // Empty or shapeless output fails loudly, naming the fragment.
  const empty = createOpenAIGistDrafter(
    { responses: { create: async () => ({ output_text: '' }) } } as unknown as GistClient,
    { model: 'm' },
  );
  await assert.rejects(empty.draft(request), /returned nothing for 'book:x#p1'/);
  const shapeless = createOpenAIGistDrafter(
    { responses: { create: async () => ({ output_text: '{"note":"x"}' }) } } as unknown as GistClient,
    { model: 'm' },
  );
  await assert.rejects(shapeless.draft(request), /no 'gist' string/);
});

test('projections file: round-trips sorted, rejects malformed entries by id, and tolerates absence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ae-projections-'));
  const path = join(dir, 'projections.json');
  assert.equal(readProjections(path).size, 0);

  const drafted = await draftProjections(ENTITY, [frag(2, P2), frag(1, P1)], scripted([CLEAN_2, CLEAN_1]), { now: NOW });
  writeProjections(drafted.projections, path);
  const back = readProjections(path);
  assert.deepEqual([...back.keys()], ['book:x#p1', 'book:x#p2']);
  assert.deepEqual(back.get('book:x#p1'), drafted.projections.get('book:x#p1'));

  writeFileSync(path, 'nope', 'utf8');
  assert.throws(() => readProjections(path), /not valid JSON/);
  writeFileSync(path, JSON.stringify({ version: 1, projections: { 'book:x#p1': { source: 'edited' } } }), 'utf8');
  assert.throws(() => readProjections(path), /projection 'book:x#p1' is malformed/);
  assert.throws(() => validateProjections({ version: 2, projections: {} }), /not a version 1 projections file/);
});
