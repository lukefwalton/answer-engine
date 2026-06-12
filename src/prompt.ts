// Prompt assembly. Pure functions, no IO — tests drive these directly.
// The prompts encode the policy: cite every claim, route to private moments
// without restating them, and say plainly when the archive doesn't have it.
// Note what buildUserPrompt CAN'T do: render a hint's text. There is no such
// field (src/no-leak.ts).

import type { ArchiveConfig, ArchiveRecord, RoutingHint } from './types.js';

/** Structured-output schema for the Responses API. Mirrors AnswerOutput in
 *  types.ts; kept as one literal so this exact object is what OpenAI sees.
 *  Citations are a discriminated union so the model must commit to a kind
 *  AND supply its required fields — schema-valid implies validator-valid. */
export const ANSWER_TEXT_FORMAT = {
  type: 'json_schema' as const,
  name: 'archive_answer',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['mode', 'answer', 'citations'],
    properties: {
      mode: {
        type: 'string',
        enum: ['supported', 'partial', 'related-material', 'not-found'],
      },
      answer: { type: 'string' },
      citations: {
        type: 'array',
        items: {
          anyOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'recordId', 'url'],
              properties: {
                kind: { type: 'string', enum: ['record'] },
                recordId: { type: 'string' },
                url: { type: 'string' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'hintId', 'url'],
              properties: {
                kind: { type: 'string', enum: ['hint'] },
                hintId: { type: 'string' },
                url: { type: 'string' },
              },
            },
          ],
        },
      },
    },
  },
};

export function buildSystemPrompt(config: ArchiveConfig): string {
  return `You are the answer engine for ${config.archiveName}, the published archive of ${config.authorName}.

You answer one question from a fixed set of evidence, under two hard rules:

1. CITE WHERE EACH CLAIM CAME FROM. Every sentence must trace back to a
   citation. Copy ids and urls as the exact pair shown in the SAME evidence
   block — never invent a citation, never mix one block's id with another's
   url.

2. SAY PLAINLY WHAT YOU DO AND DO NOT KNOW. The evidence has two kinds:
   - Records are the published canon: quote or paraphrase them freely.
   - Hints point at PRIVATE material. You are told where a relevant moment
     lives (label, location, public page) but never what it says. You may
     route the reader there; you may NOT state, summarize, or guess its
     contents.

   The four modes follow from which citations your answer carries:
   - "supported": at least one record citation AND one hint citation. Ground
     claims in the records; add where to look for more.
   - "partial": record citations only. Use when no hint bears on the question.
   - "related-material": hint citations only. The honest move when you cannot
     quote anything but a relevant moment exists: say what you cannot do and
     point to the location ("There are notes on this in <label>, <locator> —
     see <page>."). "I cannot quote it" is NOT "I don't know."
   - "not-found": no citations, empty answer string. Use when nothing in the
     evidence bears on the question. Do not guess, hedge, or pad.

Other rules:
- Only attribute a view to ${config.authorName} when a cited record states it.
  Do not infer their opinions, and do not state private personal details.
- Prefer paraphrase plus citation; quote a record's body only when the exact
  wording matters.
- Speculation is forbidden. If the evidence does not support a claim, do not
  write it.

Return JSON in the exact schema you were given. No prose outside the JSON.`;
}

/** Per-record body budget in the prompt. Retrieval's top-k is per stream
 *  (up to 8 records and 8 hints by default) — only records carry bodies, so
 *  this caps the evidence block at topK × budget and long essays degrade
 *  predictably instead of overflowing model context. */
export const MAX_PROMPT_BODY_CHARS = 6000;

function renderRecord(record: ArchiveRecord, i: number): string {
  const body =
    record.body.length > MAX_PROMPT_BODY_CHARS
      ? `${record.body.slice(0, MAX_PROMPT_BODY_CHARS)} […truncated]`
      : record.body;
  return [
    `Record [${i + 1}]`,
    `  recordId: ${record.id}`,
    `  type: ${record.type}`,
    `  title: ${record.title}`,
    `  url: ${record.url}`,
    record.summary ? `  summary: ${record.summary}` : null,
    record.themes.length > 0 ? `  themes: ${record.themes.join(', ')}` : null,
    record.date ? `  date: ${record.date}` : null,
    body ? `  body: ${body}` : null,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/** A hint renders WHERE, never WHAT — RoutingHint has no text to render. */
function renderHint(hint: RoutingHint, i: number): string {
  return [
    `Hint [${i + 1}]`,
    `  hintId: ${hint.hintId}`,
    `  label: ${hint.label}`,
    `  locator: ${hint.locator}`,
    `  url: ${hint.url}`,
  ].join('\n');
}

export function buildUserPrompt(
  question: string,
  records: readonly ArchiveRecord[],
  hints: readonly RoutingHint[],
): string {
  const recordSection = records.length > 0 ? records.map(renderRecord).join('\n\n') : '(none)';
  const hintSection = hints.length > 0 ? hints.map(renderHint).join('\n\n') : '(none)';
  return [
    `Question: ${question}`,
    '',
    'Evidence — records (quotable, citable):',
    recordSection,
    '',
    'Evidence — hints (route here; never state what the private material says):',
    hintSection,
    '',
    'Return the JSON answer.',
  ].join('\n');
}
