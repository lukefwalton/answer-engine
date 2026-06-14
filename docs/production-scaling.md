# Scaling the pattern: empirical notes from deployment

The [artifact note](./ARTIFACT-NOTE-v1.0.md) §6 leaves one question open on
purpose: the contract (no-leak, grounding, modes, refusal) is established here,
but whether operating it at public scale is *affordable* "remains empirical."
This is the empirical companion — what was learned running the same pattern
behind [Ask the Archive](https://lukefwalton.com/ask/) on a real corpus.

The README's "Where to take it" lists scaling levers "in the order we'd add
them." Deployment surfaced two that list does **not** name — vector dimension
and wire format — because at teaching scale they do not exist. This repo builds
`artifacts/index.json` and reads it in-process; there is no download, no
serverless cold start, no network boundary for a vector to cross. The levers
below appear only once there is one. They are documented, not wired in: the
engine's value is the contract, not a bundle format.

Each lever gets the same treatment: what it buys, what it costs, how you
*verify* (the eval gate, never vibes), and where it lives. Numbers are ratios,
not the production corpus — the archive's size and shape stay private by
design.

## 1. Vector dimension (Matryoshka)

**This is the lever that teaches — the repo's own discipline applied to a knob.**
`text-embedding-3-large` is trained with Matryoshka representation learning: its
3072-dim vectors truncate and renormalize with graceful quality decay, exposed
through OpenAI's `dimensions` parameter. Re-embedding at 1024 dims yields
roughly 3× smaller vectors for about a 1% quality give.

- **Buys:** a smaller vector space everywhere — in memory, on disk, on any wire.
- **Costs:** a real (small) retrieval-quality trade. It is not free; that is the
  whole point of gating it.
- **Verify:** `npm run eval` before and after. Choosing 1024 vs 512 vs staying
  at 3072 is the repo's gold-query rule — *fix the corpus, the scoring, or the
  prompt; never special-case the question* — applied to a dimension. A re-embed
  that passes gold is the contract holding; one that fails is the gate doing its
  job. Never pick a dimension by intuition.
- **Lives:** the portable embed → store → query path. One invariant carries the
  weight: store `(model, dimensions)` as the source of truth so the query is
  embedded at the same dimensionality, and make a mixed store (cosine across
  incompatible vector spaces) fail fast rather than score silently wrong.

## 2. Wire format (int8 quantization)

This lever has the highest cost ROI and touches the contract least — it is pure
serialization. It only exists once the index crosses a network boundary: a
serverless function with no disk downloads and parses the whole index on every
cold start.

Vectors are ~90% of a serialized index, and a float64 vector printed as a JSON
array is the waste — not the count. int8 scalar quantization (symmetric,
per-vector scale, base64) is ~14× smaller per vector, so the cold-start download
shrinks by about the same factor.

- **Buys:** ~14× smaller published bundle; cold start stops being a mini-batch
  job.
- **Why it is nearly free here:** retrieval ranks by cosine, and cosine
  recomputes norms per call, so the per-vector scale cancels out of the score
  entirely. Quantization spends *direction* precision only, never magnitude
  calibration — cosine rank is preserved to >0.99 correlation. It is safe
  *because* of how the gate scores, not in general; carry that reasoning, not
  just the technique.
- **Costs:** a wire/in-memory split you must keep honest — quantize on publish,
  keep full precision in memory and in the on-disk source of truth — and a
  versioned wire format so a code/blob mismatch fails fast instead of
  mis-parsing a float array as packed bytes.
- **Verify:** rank correlation against the full-precision index, then re-run
  eval.
- **Lives:** a small portable quantize/dequantize/pack/unpack module, wired in
  only by the *site adapter* that serializes and serves the bundle — the engine
  never needs it. Reference implementation: `vector-quant.ts` in the Ask the
  Archive source (the `ask-the-archive/` site adapter, not this repo).

## 3. Corpus geometry (chunk and passage count)

The first README lever — chunk long documents into overlapping windows — is
also the dominant driver of index size at scale. Past some document length a
single embedding dilutes the topical center (the same reason the theme boost
exists), so you chunk; and then index size scales **linearly with passage
count**, not document count.

- **Buys:** retrieval that points at passages, not whole documents.
- **Costs:** more passages means more vectors and more correlated neighbors in a
  wide top-k (which is why "Where to take it" lists an evidence-selection prune).
  Window size is a precision/size knob: coarser windows (say 120s vs 60s) shrink
  the index at a retrieval-precision cost; finer windows do the reverse.
- **Verify:** re-run eval after any window change — a coarser window can drop a
  boundary query's best passage below the score floor.
- **Lives:** the chunker is a site-adapter concern (Ask the Archive owns the
  transcription → chunk path); only the generalized lesson belongs here.

## The rule under all three

None of these is decided by intuition. The eval gate (`eval/gold.yaml`) picks
the setting, the same way it governs every other change to retrieval. The
ratios are portable; the production instance is not. All three operate the same
product, [Ask the Archive](https://lukefwalton.com/ask/); the site-adapter
detail behind them — transcription, the published bundle, the HTTP handler,
abuse and cost controls — lives in the `ask-the-archive/` adapter, the consumer
layer this repo deliberately omits (`.github/STANDARDS.md` §3).
