# Next steps: open problems and trade-offs

This is the open-problems list for this project. It is deliberately not a
feature roadmap. It records the seams we can see — the places where the design
leaves something to be *owned* rather than structurally guaranteed — and the
levers an adopter might pull that trade quality for cost.

Naming these is the point. The whole design rests on answerability: make the
unauthored move structurally inexpressible where you can, and answer for the
rest in the open. The boundary the implementation guarantees holds as shipped —
a private fragment's text cannot reach a model or a caller along the typed path
(`project()` in `src/no-leak.ts`; `docs/CONTRACT.md` §4), and every answer
either cites retrieved evidence or refuses. Everything in this file lives
*beyond* that boundary. None of it has to be fixed for the implementation to do
what it claims; these are the edges of the claim, written down. Since 3.0.0 the
contract itself keeps the canonical list of what is owned rather than
guaranteed (`docs/CONTRACT.md` §13); the entries below say how each is owned
in this package.

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

### A1. The strings a hit carries — linted, not typed; superseded by CONTRACT.md §6 and §13
The object that crosses (`EvidenceHit`, produced only by `project()` in
`src/no-leak.ts`) has no field for a private fragment's text, so the text
cannot leak along that path. What does travel on a private entity is short and
authored: the title, a version, creator and speaker names and roles, themes,
the locator values and their rendered label, and, where the author released
one, a gist. In 2.x two of those (the label and the locator) were typed
`PublicSafe`; the brand erased at JSON, and a type shared by public and
private entities cannot carry it anyway.

- **Current posture:** linted wherever the text to lint against is present.
  `assertPublicSafeMetadata` (`src/public-safe.ts`) runs the 2.x rule — one
  line, 120 characters, no five-word run with the entity's private text
  (characters, for a script without word spacing) — over every authored string
  on a private entity at index build and at every load of a private index
  (`validateIndex` in `src/store.ts`), so a hand edit to the artifact fails at
  load with the field and the run. A gist passes `assertSemanticProjection`
  (400 characters, the same run rule against the fragment and the whole
  entity) and is served only when `isServableGist` says so. What travels is an
  authored decision per note: the `label:` field, and now the `exposure:` it
  asks for.
- **The residue, named** (`docs/CONTRACT.md` §13): a private phrase shorter
  than the window, private meaning carried in public words, paraphrase and
  plot in a gist, a gist that describes more than the author intended, and the
  composition of an entity's gists. Those are owned by the exposure policy,
  the veto, optional review, and the canaries, which `npm run eval` now sweeps
  over every served gist, not only the ones a query retrieves. `url` (`about:`)
  travels unlinted as a declared public page. A served index carries no text
  to lint against and is trusted to descend from a validated private one.
- **For a fork / contributor:** tune `PUBLIC_SAFE_NGRAM_WORDS` and
  `GIST_NGRAM_WORDS` against your corpus (5 is calibrated so bibliographic
  locators pass; run a dry ingest at 4 and count the trips before choosing), and
  if your private layer has a known sensitive vocabulary, add a denylist check
  beside the n-gram tripwire — both lints share one matcher
  (`privateTextMatcher`), built to take it.

### A2. Related-material confabulation — closed structurally; the residue moved
In related-material mode the answer cites a routing hint, and a hint is real
provenance with **no backing**: it carries no text, so prose about the
moment's actual contents can never be certified. This was the
provenance-without-backing edge the grounding gate
(`assertCitationsGroundedInEvidence` in `src/answer.ts`) was honest about — a
model that fabricated substance and cited the hint anyway cleared it, held
only by a soft prompt instruction (route, don't restate).

- **Current posture:** closed. The related-material answer is no longer model
  prose: `finalizeAnswer` (`src/answer.ts`) replaces it with a fixed template
  rendered only from the cited hints' public-safe fields
  (`renderRelatedMaterialAnswer` in `src/public-safe.ts`), after grounding, so
  the mode can point and never assert content. Confabulation in this mode is
  now inexpressible rather than discouraged; the gold suite pins the template
  (`expectAnswerPatterns` on q07 and the extraction queries) so a regression
  cannot silently un-template the mode.
- **What the closure is worth:** exactly the safety of the fields it renders.
  The template's prose is label + locator, and, for a `semantic` hit, the gist
  the author authorized — which is A1's seam. Closing A2 raised the stakes on
  closing A1.
- **Extended to gists (3.0.0):** a `semantic` hit's gist never enters the
  prompt in any mode. `toAnswerEvidence` carries it beside the hints, not on
  them (`RoutingHint` still has no prose field), and only the related-material
  template renders it, after the mode is final. So the model never holds a
  description of private material it could restate, in `supported` or
  `partial` either; the gist a reader sees is the authorized one, verbatim.
- **The residue, named:** `supported` mode still carries a hint citation under
  free prose (a record backs the prose; the hint adds where else to look), so
  a model could still confabulate a note's contents *there*, knowing only that
  a moment exists and where. That residue is owned by gold canary patterns
  (q15 and the canary comment in `eval/gold.yaml`), not by structure —
  templating supported-mode prose would mean templating record-backed answers,
  which is the product.

### A3. Forbidden-answer patterns are hand-written and partial
The checks that catch a few specific bad outputs (for example, a raw URL where
none should appear) are regexes, written one at a time. In this repo they are
the `forbidAnswerPatterns` field on a gold query, applied in `judgeAnswer`
(`src/evaluate.ts`). They cover the cases we thought of.

- **Trade-off:** tight patterns catch real failures with near-zero false
  positives; broad ones catch more but start refusing good answers.
- **Current posture:** partial coverage, openly. Treated as a regression guard
  for known failure shapes, not a soundness boundary.
- **Current posture (updated):** audited against the modes. Each mode now
  carries its characteristic-failure coverage in `eval/gold.yaml`: canon
  answers forbid private-body canary phrases (q02, q05), refusals forbid
  URL/citation-shaped debris (q08–q10, q14), the boundary queries forbid the
  canaries outright and *require* the A2 template (`expectAnswerPatterns`),
  and the extraction/injection queries (q11–q14) aim the attack directly at
  the boundary. The A2 template did what was predicted — the fragile
  "did the model restate the note?" patterns are now backstops behind a
  structural check rather than the only line.
- **For a fork / contributor:** the shape of the audit transfers, the
  patterns don't. When you swap in your corpus, pick fresh canaries from your
  own private bodies, verify they appear on no public page, and keep one
  extraction query and one injection query aimed at whatever your private
  layer actually is.

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

### B3. Fragments exist; the teaching corpus still indexes documents whole
The index is fragments (`docs/CONTRACT.md` §12), and `src/ingest/fragment.ts`
splits a long document on headings or page markers into pieces with structural
locators (a chapter number, a page), stable per locator across rebuilds. The
teaching adapters still produce one `whole` fragment per record and per note
(`src/adapters/teaching.ts`): at this corpus size one vector per document is
the simplest thing that works, and the demo's certified verdicts depend on it.

- **Trade-off:** smaller fragments sharpen retrieval precision and grow the
  index by passage count; whole-document fragments keep the index small and
  let a long document's topical center blur.
- **Current posture:** closed as a design question, open as a default. The
  fragmenters are in the package; the shipped corpus does not use them; a
  consumer with long documents does, through its own adapter.
- **For a fork / contributor:** fragment when your documents are long, choose
  `maxFragmentChars` against the gold suite for your corpus, keep a `whole`
  fragment where entity-level citations must stay stable, and prune to one
  fragment per entity before synthesis (README, "Where to take it").

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
the quality cost, and the rule. **This repository's core is full-precision and
indexes documents whole; it pulls none of these levers.** The one exception is
the marked illustration at `demo/`: a runnable int8 miniature on a
short-whole-unit public-domain corpus, which pulls exactly one lever (int8
quantization) to show the gold suite gating it. The core's claims stay true of
the core; `demo/` is named as the exception. The production deployment behind
the project pulls int8 wire-format quantization in a private serving adapter and
chunks its long-form inputs; the rest are documented here so you can reason
about all of them the same way. **Every one of them is gated by the gold suite,
never special-cased.**

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
transport encoding, not a lossy store. (See `docs/production-scaling.md` §2, the
artifact note §7, and the runnable miniature at `demo/`.)

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

## D. Production hardening (the consumer's, by design)

The package is a substrate, not a production framework, and says so
(`docs/CONTRACT.md` §15). A consumer taking it to production adds the parts
deliberately left out. **None of these changes the contract** — the disclosure
boundary, the citation modes, and the refusal discipline hold regardless of
what is wrapped around them — but one of them is load-bearing for it.

- **D1. A service layer:** request handling, rate limiting, caching,
  persistence, observability. The contract sits underneath all of it, and names
  the rate limiter as part of its threat model (§10): a private hit's score is
  coarse so that one query reveals little; the limiter is what bounds how many
  queries a caller gets. A retrieval-only endpoint without one has not
  implemented the contract.
- **D2. Transport and versioning at scale:** moving the served index
  (`toServedIndex`, validated at load) to stateless serving instances, the
  cold-start cost that motivates C1, and versioning every encoding so a
  code/data mismatch fails loudly instead of misreading bytes.

---

*This file is meant to grow. If you find a new seam, add it to A and say how
it's owned until it's closed. If you pull a lever, add it to C with its saving,
its cost, and the gold coverage that guards it. The list getting longer is not
the program failing; it is the program doing what it claims — answering, in the
open, for the edges of what it guarantees.*
