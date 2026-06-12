// The answer call: one OpenAI Responses request with JSON-schema output, then
// three steps before anything is returned — validate the shape, repair
// almost-right citations onto the exact evidence and re-derive the mode from
// the citation mix, and finally ground every citation against what retrieval
// actually returned. The schema makes failures rare; the gates make them
// impossible to return. Modes are validated and re-derived here.

import type OpenAI from 'openai';
import { ANSWER_TEXT_FORMAT, buildSystemPrompt, buildUserPrompt } from './prompt.js';
import type {
  AnswerEvidence,
  AnswerMode,
  AnswerOutput,
  ArchiveConfig,
  Citation,
} from './types.js';

export const ANSWER_TIMEOUT_MS = 120_000;

const MODES: ReadonlySet<AnswerMode> = new Set([
  'supported',
  'partial',
  'related-material',
  'not-found',
]);

/** Validate the model's JSON against AnswerOutput, including the contract
 *  that runs both ways: not-found ⇒ empty answer; sourced modes ⇒ prose. */
export function validateAnswer(raw: unknown): AnswerOutput {
  if (typeof raw !== 'object' || raw === null) throw new Error('answer must be an object');
  const obj = raw as Record<string, unknown>;
  if (typeof obj.mode !== 'string' || !MODES.has(obj.mode as AnswerMode)) {
    throw new Error(`answer.mode '${String(obj.mode)}' is not a valid mode`);
  }
  const mode = obj.mode as AnswerMode;
  if (typeof obj.answer !== 'string') throw new Error('answer.answer must be a string');
  if (mode === 'not-found' && obj.answer !== '') {
    throw new Error("a 'not-found' answer must carry no prose");
  }
  if (mode !== 'not-found' && obj.answer.trim().length === 0) {
    throw new Error(`a '${mode}' answer requires prose; use 'not-found' to decline`);
  }
  if (!Array.isArray(obj.citations)) throw new Error('answer.citations must be an array');
  const citations: Citation[] = obj.citations.map((c, i) => {
    if (typeof c !== 'object' || c === null) throw new Error(`citations[${i}] is not an object`);
    const cit = c as Record<string, unknown>;
    if (cit.kind === 'record' && typeof cit.recordId === 'string' && typeof cit.url === 'string') {
      return { kind: 'record', recordId: cit.recordId, url: cit.url };
    }
    if (cit.kind === 'hint' && typeof cit.hintId === 'string' && typeof cit.url === 'string') {
      return { kind: 'hint', hintId: cit.hintId, url: cit.url };
    }
    throw new Error(`citations[${i}] is not a valid record or hint citation`);
  });
  return { mode, answer: obj.answer, citations };
}

function citationKey(c: Citation): string {
  return c.kind === 'record' ? `r|${c.recordId}|${c.url}` : `h|${c.hintId}|${c.url}`;
}

/** What the citation mix says the mode is. The four modes partition the mix,
 *  so after repair the mode is DERIVED, not trusted — the model can't claim
 *  'supported' while citing nothing but hints. */
export function deriveMode(citations: readonly Citation[]): AnswerMode {
  const records = citations.filter((c) => c.kind === 'record').length;
  const hints = citations.filter((c) => c.kind === 'hint').length;
  if (records > 0 && hints > 0) return 'supported';
  if (records > 0) return 'partial';
  if (hints > 0) return 'related-material';
  return 'not-found';
}

/** Snap citations onto the exact evidence pairs when the model got the id OR
 *  the url right but mangled the other half — including citing one kind when
 *  the evidence holds that url as the other kind. Dedupes (repair can
 *  collapse two citations onto one source) and re-derives the mode from the
 *  final mix. Never invents a citation. */
export function repairCitationsToEvidence(
  answer: AnswerOutput,
  evidence: AnswerEvidence,
): AnswerOutput {
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const c of answer.citations) {
    let repaired: Citation = c;
    if (c.kind === 'record') {
      const record =
        evidence.records.find((r) => r.id === c.recordId) ??
        evidence.records.find((r) => r.url === c.url);
      const asHint = record ? undefined : evidence.hints.find((h) => h.url === c.url);
      if (record) repaired = { kind: 'record', recordId: record.id, url: record.url };
      else if (asHint) repaired = { kind: 'hint', hintId: asHint.hintId, url: asHint.url };
    } else {
      const hint =
        evidence.hints.find((h) => h.hintId === c.hintId) ??
        evidence.hints.find((h) => h.url === c.url);
      const asRecord = hint ? undefined : evidence.records.find((r) => r.url === c.url);
      if (hint) repaired = { kind: 'hint', hintId: hint.hintId, url: hint.url };
      else if (asRecord) repaired = { kind: 'record', recordId: asRecord.id, url: asRecord.url };
    }
    const key = citationKey(repaired);
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push(repaired);
  }
  // A declared refusal stays a refusal; otherwise the mix decides the mode.
  // Either way a not-found result honors the full contract — no prose, no
  // citations — even when it was derived from a sourced answer whose
  // citations all failed to ground. Contradictory output (a declared
  // not-found that also carried citations) normalizes toward refusal rather
  // than erroring on purpose: declining is always safe to return, and a
  // runtime error here would turn harmless model noise into a failed request.
  const mode = answer.mode === 'not-found' ? 'not-found' : deriveMode(citations);
  if (mode === 'not-found') return { mode: 'not-found', answer: '', citations: [] };
  return { ...answer, mode, citations };
}

/** Every citation must be the exact pair of a retrieved source; the mode must
 *  match the citation mix; refusals must be bare. */
export function assertCitationsGroundedInEvidence(
  answer: AnswerOutput,
  evidence: AnswerEvidence,
): void {
  if (answer.mode === 'not-found') {
    if (answer.citations.length > 0) {
      throw new Error("a 'not-found' answer must carry no citations");
    }
    return;
  }
  if (answer.citations.length === 0) {
    throw new Error(`a '${answer.mode}' answer must cite its evidence`);
  }
  if (deriveMode(answer.citations) !== answer.mode) {
    throw new Error(
      `answer mode '${answer.mode}' does not match its citation mix ` +
        `(the mix implies '${deriveMode(answer.citations)}')`,
    );
  }
  for (const c of answer.citations) {
    const grounded =
      c.kind === 'record'
        ? evidence.records.some((r) => r.id === c.recordId && r.url === c.url)
        : evidence.hints.some((h) => h.hintId === c.hintId && h.url === c.url);
    if (!grounded) {
      const id = c.kind === 'record' ? c.recordId : c.hintId;
      throw new Error(`citation '${id}' (${c.url}) does not match any single evidence source`);
    }
  }
}

/** Reasoning-family models reject non-default temperature. */
function isReasoningModel(model: string): boolean {
  return /^gpt-5/.test(model) || /^o\d/.test(model);
}

export async function answerQuestion(
  client: OpenAI,
  question: string,
  evidence: AnswerEvidence,
  config: ArchiveConfig,
): Promise<AnswerOutput> {
  // No evidence means no call: the floor for "I don't know" is structural,
  // and an empty-evidence question costs nothing.
  if (evidence.records.length === 0 && evidence.hints.length === 0) {
    return { mode: 'not-found', answer: '', citations: [] };
  }

  const response = await client.responses.create(
    {
      model: config.answerModel,
      store: false,
      instructions: buildSystemPrompt(config),
      input: buildUserPrompt(question, evidence.records, evidence.hints),
      ...(isReasoningModel(config.answerModel)
        ? { reasoning: { effort: config.reasoningEffort ?? 'low' } }
        : { temperature: 0 }),
      text: { format: ANSWER_TEXT_FORMAT },
    },
    { timeout: ANSWER_TIMEOUT_MS },
  );

  // Read the SDK's aggregated output_text — the output array can also carry
  // reasoning items, so output[0] is not reliably the message.
  const content = response.output_text;
  if (!content) throw new Error('OpenAI returned an empty answer');
  const validated = validateAnswer(JSON.parse(content));
  const repaired = repairCitationsToEvidence(validated, evidence);
  assertCitationsGroundedInEvidence(repaired, evidence);
  return repaired;
}
