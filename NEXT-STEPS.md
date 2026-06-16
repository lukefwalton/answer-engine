# Next steps: open problems and trade-offs

This is the open-problems list for this project. It is deliberately not a
feature roadmap. It records the seams we can see — the places where the design
leaves something to be *owned* rather than structurally guaranteed — and the
levers an adopter might pull that trade quality for cost.

Naming these is the point. The whole design rests on answerability: make the
unauthored move structurally inexpressible where you can, and answer for the
rest in the open. The boundary the implementation guarantees holds as shipped —
private text cannot reach the prompt along the typed path, and every answer
either cites retrieved evidence or refuses. Everything in this file lives
*beyond* that boundary. None of it has to be fixed for the implementation to do
what it claims; these are the edges of the claim, written down.

Two audiences:

- **If you are adapting this for your own system,** the performance section (C)
  is a starter. Each lever names what it saves, what it costs in quality, and
  the rule it has to pass. You will likely want different levers; the shape of
  the reasoning is what transfers.
- **If you are contributing,** every entry below is a ticket you can pull. They
  are roughly ordered within each section by how much they change the guarantees
  versus how much work they take.

One rule governs anything in sections B and C, and it is the same rule the
evaluation runs on: **a change is admitted or rejected by the gold suite
(`eval/gold.yaml`), and never by special-casing a query.** A change that makes a
gold query pass by being written specifically for that query is the special case
in disguise. If you add a lever, you add the gold coverage that would catch its
failure mode first.

---

## A. Seams we answer for

These are places where the structure does not (or cannot) catch the unwanted
move, so it is held by a softer guard and owned openly.

### A1. Routing-hint metadata travels unguarded
The type that crosses to the model (`RoutingHint` in `src/types.ts`) has no
field for a note's body text, so the body cannot leak along that path
(`src/no-leak.ts`). But two fields do travel: the **label** (currently the
note's title, set in `buildPrivateNotes` in `src/corpus.ts`) and the
**locator** (from frontmatter). A note with a sensitive title leaks through its
label, and nothing in the type stops it.

- **Trade-off:** richer labels and locators help the model route well; every
  field that travels is also a leak surface.
- **Current posture:** documented, with a loud warning at the population site
  (`src/corpus.ts`) and in the README — keep titles and locators public-safe.
  The guard is discipline, not structure.
- **For a fork / contributor:** make the boundary structural instead of
  advisory. Options: derive the label from a public-safe identifier rather than
  the raw title; whitelist or sanitize the fields that may travel; or carry a
  separate, explicitly-public "display label" distinct from the private title.
  A build-time lint that flags obviously-private patterns in the traveling
  fields is a cheap first step before any of these. Any of them moves this seam
  from "owned" to "inexpressible," which is where it should end up.

### A2. Related-material mode admits confabulation (provenance without backing)
In related-material mode the answer cites a routing hint and is otherwise free
prose. The hint is real and was retrieved, so a claim citing it **passes the
structural grounding gate** (`assertCitationsGroundedInEvidence` in
`src/answer.ts`) — it has provenance. But the hint carries no text, so there is
**no backing** for any prose about the moment's actual contents. A model that
fabricates substance and cites the hint anyway clears the gate. This is exactly
the provenance-without-backing residue the grounding definition already declines
to certify; it is not a hole in the gate, it is the edge the gate was honest
about.

- **Trade-off:** natural-language routing ("there's a relevant private passage
  here") is useful and humane; it is also the freedom a confabulation hides in.
- **Current posture:** held by a soft prompt instruction (route, don't restate —
  `src/prompt.ts`) and a hand-written set of forbidden-answer patterns (see A3).
  The model's unbacked claim is disavowable as such, and owned.
- **For a fork / contributor:** close it structurally by **templating the
  related-material answer from the hint's public-safe fields** (label, locator,
  URL), so the mode can only point, never assert content. Confabulation then
  becomes inexpressible in that mode rather than merely discouraged. This is the
  highest-value structural ticket in the file.

### A3. Forbidden-answer patterns are hand-written and partial
The checks that catch a few specific bad outputs (for example, a raw URL where
none should appear) are regexes, written one at a time. In this repo they are
the `forbidAnswerPatterns` field on a gold query, applied in `judgeAnswer`
(`src/evaluate.ts`). They cover the cases we thought of.

- **Trade-off:** tight patterns catch real failures with near-zero false
  positives; broad ones catch more but start refusing good answers.
- **Current posture:** partial coverage, openly. Treated as a regression guard
  for known failure shapes, not a soundness boundary.
- **For a fork / contributor:** audit the pattern set against the modes; add
  coverage for each mode's characteristic failure; consider replacing the most
  fragile patterns with a structural check (A2 removes the need for several of
  them outright).

---

## B. Calibration, recall, and corpus shape

These are honest empirical knobs. They are owned upstream — someone sets them
and signs for them — but they are not guaranteed correct.

### B1. The score floor is hand-tuned and model-dependent
Retrieval admits a candidate only above a fixed score floor (`SCORE_FLOOR =
0.2` in `src/retrieve.ts`), with fixed boosts for naming a work's title
(`EXACT_MATCH_BOOST = 0.3`) and using a curated theme verbatim (`THEME_BOOST =
0.15`). These numbers were tuned against one embedding model
(`text-embedding-3-large`). **Swap the embedding model and the floor's meaning
changes** — silently, because the constant doesn't move when the model does.

- **Trade-off:** a higher floor refuses more and hallucinates less; a lower
  floor answers more and lets weak sources in.
- **Current posture:** the floor and boosts are authored constants, gated by the
  gold suite for the model in use.
- **For a fork / contributor:** document the floor's dependence on the specific
  embedding model at the constant's definition (the comment already names the
  dependence; make it loud); add a recall regression that fails loudly if a
  model change degrades retrieval on the gold set; consider per-corpus or
  per-model calibration rather than one global constant.

### B2. Recall is untestable in the limit
The gate owns soundness — it can certify an answer is grounded or honestly
refused. It cannot own completeness. A source below the floor is simply absent,
and the relevant source no one thought to test for is invisible to any suite.
This is irreducible: anticipating that source in full would mean already knowing
the answer.

- **Trade-off:** none to "fix" — this is a boundary, not a bug. The work is
  making it visible.
- **Current posture:** the gold suite tests recall for the cases it names
  (`expectSources` in `eval/gold.yaml`, judged by `judgeRetrieval` in
  `src/evaluate.ts`), and the boundary around retrieval (corpus edge, floor,
  candidate rules, the metadata that makes some sources easier to find) is
  authored and owned. The rest is named as irreducible.
- **For a fork / contributor:** expand the gold suite's recall cases as the
  corpus grows; treat every recall miss found in use as a new gold entry, not a
  one-off patch.

### B3. The repository does not chunk; chunking is the first step when documents grow
This repository indexes each document whole (`buildCorpus` in `src/corpus.ts`
maps one markdown file to one record, one vector). Once a document is long
enough that a single embedding dilutes its topical center, the standard move is
to split it into overlapping windows so each vector keeps a tighter topical
center; the README's "Where to take it" lists this as the first thing to take
on, and the production deployment behind the project already does it on its
transcription path.

- **Trade-off:** smaller windows sharpen retrieval precision and grow the index
  by passage count; whole-document indexing, as here, keeps the index small and
  lets a long document's topical center blur.
- **Current posture:** unchunked, by design — whole-document indexing is the
  simplest thing that works at this corpus size.
- **For a fork / contributor:** add chunking when your documents are long, make
  the window granularity configurable, and tune it against the gold suite for
  your corpus; document the size you chose and why.

### B4. Index homogeneity is maintained by hand
The store asserts that every vector shares one model and dimensionality, and
fails fast if they don't (`assertHomogeneousIndex` in `src/store.ts`) — this is
a checked invariant on the read paths. But keeping a growing corpus homogeneous
(one re-index when the model or dimension changes, never a partial one) is an
operational discipline, not something the type system enforces across time.

- **Trade-off:** incremental re-indexing is cheaper; full re-indexing is the
  only thing that guarantees homogeneity.
- **Current posture:** the invariant is checked at read time; the discipline of
  full re-indexing is on the operator.
- **For a fork / contributor:** version the index by model-and-dimension and
  refuse to serve a mixed store; make a partial re-index impossible to commit
  rather than merely inadvisable.

---

## C. Performance levers that trade quality for cost

This is the starter for anyone adapting the system. Each lever names the saving,
the quality cost, and the rule. **This repository is full-precision and indexes
documents whole; it pulls none of these levers.** The production deployment
behind the project pulls one of them (int8 wire-format quantization, in a
private serving adapter) and chunks its long-form inputs; the rest are
documented here so you can reason about all of them the same way, whether or not
this repo exercises them. **Every one of them is gated by the gold suite, never
special-cased.**

The cost concentrates almost entirely in one object: the embedding index, in its
in-memory footprint and in the latency of shipping it to a stateless serving
instance.

### C1. More aggressive quantization
The production deployment quantizes published vectors to one signed byte per
dimension for transport (this repository keeps full-precision vectors in memory;
see `src/store.ts`), which is admissible for two reasons of different kinds:
cosine similarity normalizes by vector norm, so a positive per-vector scale
cancels as a matter of *algebra* (guaranteed, exact); and integer rounding can
reorder near-ties, so its harmlessness is *measured* against the gold suite, not
proven. The full-precision vectors stay the source of truth, so this is a
transport encoding, not a lossy store. (See `docs/production-scaling.md` §2 and
the artifact note §7.)

Going further trades more quality for more savings:
- **int4 / lower-bit quantization** — roughly halves the transport size again;
  rounding error grows and reorders more near-ties.
- **Product quantization (PQ)** — large memory reduction by encoding sub-vectors
  against learned codebooks; introduces approximation in the distance itself,
  not just the storage.
- **Binary quantization with Hamming distance** — extreme size and speed gains;
  substantial quality cost, usually requiring a full-precision re-ranking pass
  over the top candidates to recover.

- **The rule:** the exact part (norm cancellation) stops applying once the
  distance itself is approximated, as with PQ and binary. Past int8, the *whole*
  lever is measured, not partly guaranteed. Gate it against the gold suite, hold
  the rank correlation and a passing evaluation as the bar, and version the wire
  format so a mismatch fails loudly.

### C2. Embedding-dimension reduction (the untaken lever)
With an embedding model whose vectors degrade gracefully under truncation (a
Matryoshka-style representation, as `text-embedding-3-large` is), the index can
be rebuilt at a lower dimensionality — on the order of threefold smaller at
about a third of the native width (1024 of 3072), for a small quality cost —
with the query embedded to match.

- **Trade-off:** smaller, faster index; some retrieval quality lost, dependent
  on how much the model's information concentrates in its leading dimensions.
- **The rule:** the stored model-and-dimension pair is the index's identity
  (`IndexEntry` carries `model` and `dimensions`; `src/store.ts` enforces it);
  the query must be embedded at the same width, and a store that mixed widths
  must fail fast (see B4). Choose the width against the gold suite, not by
  intuition.

### C3. Approximate nearest-neighbour search
Exact search scans every vector (`retrieve` in `src/retrieve.ts` is brute-force
cosine over the whole index). At scale, an approximate index (HNSW, IVF, or
similar) makes search sublinear.

- **Trade-off:** large latency win at scale; recall is now approximate — the
  true nearest neighbour can be missed, which interacts directly with the score
  floor (B1) and with refusal honesty.
- **The rule:** treat the recall loss as a gold-suite question, especially for
  the must-refuse and must-route cases; an ANN parameter that flips a refusal
  into a wrong answer is a failure even if average latency improved.

### C4. Caching and precomputation
Frequent queries and their retrieved evidence can be cached; embeddings can be
precomputed and reused.

- **Trade-off:** latency and cost savings; a stale cache can serve evidence that
  no longer reflects the corpus, quietly breaking the grounding the gate
  assumes.
- **The rule:** invalidate on any corpus or index change; never let a cache
  outlive the index identity it was built against.

---

## D. Production hardening (out of scope by design)

The implementation is not a production framework, and says so. An adopter taking
it to production has to add the parts deliberately left out. **None of these
changes the answer contract** — the evidence boundary, the citation modes, and
the refusal discipline hold regardless of what is wrapped around them.

- **D1. A service layer:** request handling, rate limiting, caching,
  persistence, observability. The contract sits underneath all of it.
- **D2. Transport and versioning at scale:** moving the index to stateless
  serving instances, the cold-start cost that motivates C1, and versioning every
  encoding so a code/data mismatch fails loudly instead of misreading bytes.

---

*This file is meant to grow. If you find a new seam, add it to A and say how
it's owned until it's closed. If you pull a lever, add it to C with its saving,
its cost, and the gold coverage that guards it. The list getting longer is not
the program failing; it is the program doing what it claims — answering, in the
open, for the edges of what it guarantees.*
