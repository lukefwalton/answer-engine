// OpenAI embedding calls, batched around the API's published limits:
// up to 2048 inputs per request, ~300k tokens per request, 8192 tokens per
// input. Byte budgets use the ~4-bytes-per-token heuristic with headroom.

import type OpenAI from 'openai';

export const MAX_INPUTS_PER_REQUEST = 2048;
/** Per-input backstop: ~24 KB stays well under the 8192-token input cap. */
export const MAX_INPUT_BYTES = 24 * 1024;
/** Per-request backstop: ~1 MB stays well under the 300k-token request cap. */
export const MAX_BATCH_BYTES = 1024 * 1024;
export const EMBED_TIMEOUT_MS = 120_000;

export interface EmbedRequest {
  id: string;
  text: string;
}

export interface EmbedResult {
  id: string;
  vector: number[];
}

/** Truncate to the per-input byte budget without splitting a UTF-8 code point. */
export function truncateForEmbedding(text: string, maxBytes: number = MAX_INPUT_BYTES): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return text;
  let cut = maxBytes;
  while (cut > 0 && (buffer[cut]! & 0b1100_0000) === 0b1000_0000) cut -= 1;
  return buffer.subarray(0, cut).toString('utf8');
}

/** Split inputs into batches that fit BOTH limits (item count and total bytes). */
export function batchInputs(inputs: readonly EmbedRequest[]): EmbedRequest[][] {
  const batches: EmbedRequest[][] = [];
  let current: EmbedRequest[] = [];
  let currentBytes = 0;
  for (const input of inputs) {
    const itemBytes = Buffer.byteLength(input.text, 'utf8');
    if (
      current.length >= MAX_INPUTS_PER_REQUEST ||
      (current.length > 0 && currentBytes + itemBytes > MAX_BATCH_BYTES)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(input);
    currentBytes += itemBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Embed one batch. Returns vectors aligned to input order with ids attached. */
export async function embedBatch(
  client: OpenAI,
  inputs: readonly EmbedRequest[],
  options: { model: string; dimensions?: number },
): Promise<EmbedResult[]> {
  if (inputs.length === 0) return [];
  if (inputs.length > MAX_INPUTS_PER_REQUEST) {
    throw new Error(`embedBatch received ${inputs.length} inputs; use batchInputs() first.`);
  }
  const response = await client.embeddings.create(
    {
      model: options.model,
      input: inputs.map((i) => truncateForEmbedding(i.text)),
      ...(options.dimensions ? { dimensions: options.dimensions } : {}),
    },
    { timeout: EMBED_TIMEOUT_MS },
  );
  if (response.data.length !== inputs.length) {
    throw new Error(
      `OpenAI returned ${response.data.length} vectors for ${inputs.length} inputs; refusing to misalign ids.`,
    );
  }
  return inputs.map((input, i) => ({ id: input.id, vector: response.data[i]!.embedding }));
}
