# The int8 scaling demo

The result this module is built to produce is a **caught failure**: the same
gold suite that owns grounding and refusal rejecting a cheaper encoding. Run the
quantizer at int4 (or with a lowered floor) and a route case flips, the private
note loses the top slot to a public record, and the suite catches it. That is
the point. "int8 held" on a small corpus is expected and proves little on its
own; the gate saying *no* when pushed is what shows the gold suite, not the
encoding, is the adjudicator.

```
npm run scaling:run                        # int8 on the real corpus: the headline, keyless
npm run scaling:run -- --bits 4            # int4: the gate rejects the route flip
npm run scaling:run -- --natural+synthetic # add the quarantined spire + its gold
npm run scaling:run -- --full              # also run the answer-mode pass (needs a key)
```

## What it is

The paper (§6) claims that the same gold suite which owns grounding and refusal
also adjudicated every cost reduction made to run the system at scale. The
production figures behind that are private and non-reproducible. This demo makes
the *mechanism* runnable on a public-domain corpus: it quantizes the embedding
index to int8, re-ranks, and runs the full gold suite including the must-refuse
and must-route cases, so the gate either certifies or rejects the cheaper
encoding. The claim is **relative, not absolute**: not "this corpus is
realistic," but "int8 preserves the verdicts full-precision produces, and where
it does not, the gate catches it." Realism is never asserted.

Public domain is the *absence* of copyright, not a license: this corpus is
public-domain, not "permissively licensed." The two name-colliding authors and
their provenance live in [`corpus/README.md`](./corpus/README.md).

## How it works (a wrapper plus a re-rank, not a second system)

The int8 path is an encode/decode wrapper plus a re-rank. It reuses the core
retrieval (`src/retrieve.ts`), the gold judge (`src/evaluate.ts`), the store
(`src/store.ts`), and the no-leak boundary (`src/no-leak.ts`) untouched; nothing
in the core was forked or changed. `quantize.ts` is the public twin of the
production site adapter's `vector-quant.ts` (named in
[`docs/production-scaling.md`](../docs/production-scaling.md) §2). The harness
quantizes the committed full-precision vectors in process, dequantizes, and
hands the result to the same `retrieve()` the engine uses.

Two facts make int8 admissible, and they differ in kind (the §6 split):

- **Exact, by algebra.** Cosine normalizes by vector norm, so a positive
  per-vector scale cancels from the score entirely. The ranking is invariant to
  it; you can score against the quantized bytes without restoring the scale.
- **Measured, by the suite.** Integer rounding perturbs direction and can
  reorder near-ties, so its harmlessness is not proven; it is verified. The
  harness reports rank correlation against the full-precision ranking, then runs
  the gold suite. Rank correlation is *necessary, not sufficient*: a demo that
  reports it and stops has shown a retrieval benchmark, not answerability
  governing tuning. The refuse and route cases are the actual adjudicator. Past
  int8 (int4, PQ, binary) the exact part stops applying and the whole lever is
  measured; the wire format is versioned so a code/data mismatch fails loudly.

The headline run is **keyless**: it reads committed full-precision vectors and
committed gold-query vectors, so no embedding call is made. A key is needed only
to regenerate the vectors (`scaling:build`) or to run the `--full` answer pass.
That answer pass exercises route *selection*, which is what quantization moves;
it does not touch A2, the answer model's confabulation residue, which the
encoding never exercises.

## Disclosures (the three that are non-negotiable)

1. **Layer designation, not secrecy.** "Private" means the type cannot carry the
   text to the model, regardless of what the text is. George Adam Smith's minor
   works are public-domain; assigning some of them to the private layer is an
   authored research decision, the same move the core's notebook entries make.
2. **The synthetic spire is fabricated and flagged.** A small set of fabricated
   George-private notes lives quarantined in `corpus/synthetic/`, loaded only
   under `--natural+synthetic`, each marked `synthetic: true` and naming the
   edge it tests. It is additive and never enters the headline metrics; the
   spire's effect is reported on its own line. No fabricated words are ever
   attributed to the real Adam Smith.
3. **The claim is relative.** int8 preserves the verdicts full-precision
   produces; the corpus is not offered as realistic and nothing turns on its
   realism.

One disclosure carries a warning. The core gitignores `artifacts/index.json`
because vectors derived from private text are private; this demo does the
opposite and commits its vectors, so the headline reproduces with no key. That
is safe *here* because the "private" layer is public-domain George text, whose
embeddings reveal nothing already public. Do not copy "commit your vectors" as a
general pattern: embeddings of genuinely private text can be inverted to recover
approximate content, which is the exposure the core's gitignored index avoids.

## Build status

The code, the gold set, the provenance manifest, and the deterministic harness
tests (`quantize.test.ts`, run by `npm test`) are committed. The real text
bodies and the committed vectors (`corpus/index.json`,
`corpus/index.synthetic.json`, `corpus/query-vectors.json`) are produced by
`scaling:build`, which needs network access to the public-domain sources and an
`OPENAI_API_KEY`; the session that wrote the module had neither. See
[`docs/scaling-demo/build-handoff.md`](../docs/scaling-demo/build-handoff.md)
for the exact steps, and the delta log for what is confirmed versus pending.

## Relation to production

This is the runnable counterpart to the prose in `docs/production-scaling.md`
§2: the prose makes the case, the demo runs it. The George/Adam disambiguation
mirrors the real two-tier citation surface on the production site (Ask the
Archive), where a public-record citation carries an id and a URL and a
routing-hint citation carries only where the moment lives, never the text. The
**architecture** is what reproduces here, not the scale: the scale stays
reported in §6, the mechanism runs in this folder.
