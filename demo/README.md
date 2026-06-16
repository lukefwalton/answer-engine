# The int8 scaling demo

The result this module produces is a **caught failure**: the same gold suite that
owns grounding and refusal rejecting a cheaper encoding. The real-only headline
now holds cleanly: `npm run demo:run -- --natural` certifies int8 at 7/7 gold
verdicts, mean rho 1.0000, min rho 1.0000. The synthetic spire is broken out:
`--natural+synthetic` certifies int8 at 9/9, while `--natural+synthetic --bits 4`
holds 7/9 and is rejected because exactly two verdicts fail: both engineered
route cases flip from the private synthetic note to the public Amos record. The
seven natural cases still hold, so the caught int4 break is concentrated where
the demo constructed the near-tie. The gate says yes to int8 and no when the
encoding is pushed.

The real route case was also tested as an escape hatch. It holds through int4
and only breaks around int2, so the synthetic spire remains: real text is too
stable to demonstrate the catch at int4, and the spire constructs the controlled
near-tie in the open.

Run it:

```
npm run demo:run                                  # int8, real corpus: the headline, keyless
npm run demo:run -- --natural+synthetic           # add the spire and its gold
npm run demo:run -- --natural+synthetic --bits 4  # int4: the gate rejects the spire route flips
npm run demo:run -- --full                        # also run the answer-mode pass (needs a key)
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
  the gold suite. Rank correlation is a *diagnostic*, not the gate: it measures
  how much the ranking moved, but a demo that reports it and stops has shown a
  retrieval benchmark, not answerability governing tuning. The gold suite is the
  actual adjudicator, and it checks not
  just that the expected source is *retrieved* but that it *wins the top slot*:
  so a quantization flip that swaps which Smith ranks first (disambiguation) or
  lets a public record overtake the private note (route) is caught keyless, not
  only by the keyed answer pass. Past int8 (int4, PQ, binary) the exact part
  stops applying and the whole lever is measured; the wire format is versioned
  so a code/data mismatch fails loudly. One scope note: int4 here is exercised
  as *precision loss* to demonstrate the catch — codes still occupy an
  `Int8Array`, nothing is nibble-packed — so the byte-size saving of low-bit
  encodings is a production property (`docs/production-scaling.md` §2), not what
  this gate measures.

The headline run is **keyless**: it reads committed full-precision vectors and
committed gold-query vectors, so no embedding call is made. A key is needed only
to regenerate the vectors (`demo:build`) or to run the `--full` answer pass.
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
   passed off as either real Smith's writing: the spire is George-framed but
   flagged, and nothing fabricated is presented as the actual work of either man.
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

The code, gold set, provenance manifest, real text bodies, and committed vectors
(`corpus/index.json`, `corpus/index.synthetic.json`,
`corpus/query-vectors.json`) are built. `demo:build` remains the regeneration
path and needs an `OPENAI_API_KEY`; `demo:run` is keyless because it reads the
committed source and query vectors. See
[`docs/scaling-demo/build-handoff.md`](../docs/scaling-demo/build-handoff.md)
for the source-building steps and the delta log for the empirical findings.

## The spec and the log are kept in the open

The planning docs live beside the module in
[`docs/scaling-demo/`](../docs/scaling-demo/), kept on purpose rather than
discarded once the code landed:

- `SCALING-DEMO-spec.md`: what the demo set out to do, and why; the ticket it was
  built from.
- `scaling-demo-delta-log.md`: every place the build diverged from that spec,
  the empirical result the harness produced, and the reconciliations
  (NEXT-STEPS, STANDARDS, the paper) applied or still owed at merge.
- `build-handoff.md`: the brief for the build run that fetches the public-domain
  texts and generates the committed vectors.

This is the same move the corpus manifest makes: the reasoning behind the
artifact is part of the artifact. A reader can see what was intended, where
reality differed, and which decisions are still owed.

## Relation to production

This is the runnable counterpart to the prose in `docs/production-scaling.md`
§2: the prose makes the case, the demo runs it. The George/Adam disambiguation
mirrors the real two-tier citation surface on the production site (Ask the
Archive), where a public-record citation carries an id and a URL and a
routing-hint citation carries only where the moment lives, never the text. The
**architecture** is what reproduces here, not the scale: the scale stays
reported in §6, the mechanism runs in this folder.
