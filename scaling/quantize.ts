// scaling/quantize.ts — scalar quantization for the int8 demo.
//
// The public, runnable twin of the production site adapter's vector-quant.ts
// (named in docs/production-scaling.md §2; that adapter is not a public repo).
// Same scheme: per-vector symmetric scalar quantization. The full-precision
// vectors stay the source of truth (scaling/corpus/index.json); the demo
// quantizes them in process, re-ranks, and lets the gold suite judge the result.
//
// Why it is admissible, in two parts of different kinds (the paper's §6 split):
// cosine (src/retrieve.ts) recomputes norms per call, so a positive per-vector
// scale cancels from the score entirely; the ranking is invariant to it as a
// matter of algebra (exact). Integer rounding perturbs direction and can
// reorder near-ties, so its harmlessness is not proven but measured against the
// gold suite. int8 holds on the real corpus; int4 is the scalpel that makes the
// gate say no.

export interface QuantizedVector {
  /** Signed integer codes, one per dimension, each in [-level, level]. */
  codes: Int8Array;
  /** Dequantization scale: vector[i] ≈ codes[i] * scale. */
  scale: number;
}

/** The signed range for a bit width: int8 -> 127, int4 -> 7. One function
 *  serves both, so the headline (int8) and the deliberate failure (int4) run
 *  the identical path at different precisions. */
export function levelFor(bits: number): number {
  if (!Number.isInteger(bits) || bits < 2 || bits > 8) {
    throw new Error(`quantize: unsupported bit width ${bits} (expected 2..8)`);
  }
  return (1 << (bits - 1)) - 1; // 2^(bits-1) - 1
}

/** Per-vector symmetric quantization to `bits` signed bits. scale carries the
 *  per-vector max magnitude so the reader can rebuild the approximate float. An
 *  all-zero vector (no signal) quantizes to all-zero with scale 1; it never
 *  divides by zero. */
export function quantize(vector: readonly number[], bits = 8): QuantizedVector {
  const level = levelFor(bits);
  const n = vector.length;
  const codes = new Int8Array(n);
  let max = 0;
  for (let i = 0; i < n; i += 1) {
    const a = Math.abs(vector[i]!);
    if (a > max) max = a;
  }
  if (max === 0) return { codes, scale: 1 };
  const inv = level / max;
  for (let i = 0; i < n; i += 1) {
    let q = Math.round(vector[i]! * inv);
    if (q > level) q = level;
    else if (q < -level) q = -level;
    codes[i] = q;
  }
  return { codes, scale: max / level };
}

/** Reconstruct the approximate float vector from codes + scale. */
export function dequantize(q: QuantizedVector): number[] {
  const { codes, scale } = q;
  const out = new Array<number>(codes.length);
  for (let i = 0; i < codes.length; i += 1) out[i] = codes[i]! * scale;
  return out;
}

/** Round-trip a vector through `bits`-bit quantization: the lossy vector the
 *  demo re-ranks against. quantize then dequantize, nothing else. */
export function requantizeVector(vector: readonly number[], bits = 8): number[] {
  return dequantize(quantize(vector, bits));
}
