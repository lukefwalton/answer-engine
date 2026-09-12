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

### A1. Routing-hint metadata — the boundary is now structural; its edges named
The type that crosses to the model (`RoutingHint` in `src/types.ts`) has no
field for a note's body text, so the body cannot leak along that path
(`src/no-leak.ts`). Two fields do travel — the **label** and the **locator**
— and they used to be raw frontmatter guarded by a warning comment: a note
with a sensitive title leaked through its own label, and nothing in the type
stopped it.

- **Current posture:** structural, three layers deep. The traveling label is
  an explicit `label:` frontmatter field, distinct from the private `title`
  (which is embedded for retrieval and never travels) — a fork upgrading past
  this change fails loudly until each note declares one, which is the point:
  what travels is now an authored decision per note, not a default. Both
  traveling fields are typed `PublicSafe`, whose only constructor is the
  build-time lint (`assertPublicSafeField` in `src/public-safe.ts`): single
  line, capped length, and no run of five consecutive words shared with the
  note's private body — a field that quotes the note fails the build, not the
  answer. The index schema versioned past the split (v3, `src/store.ts`), so
  a stale artifact fails fast with the remedy.
- **The residue, named:** the lint is a tripwire, not a classifier — a short
  private phrase, or private meaning carried in public words, still passes
  it. `url` (`about:`) travels unlinted as a declared public page. And the
  brand erases at JSON boundaries: an index read from disk is trusted to have
  been built through the lint, not re-checked. The gold canaries
  (`eval/gold.yaml`) backstop all three at answer time.
- **For a fork / contributor:** tune `PUBLIC_SAFE_NGRAM_WORDS` against your
  corpus (5 is calibrated so bibliographic locators pass; see the constant's
  comment), and if your private layer has a known sensitive vocabulary, add a
  denylist check beside the n-gram tripwire — the lint is one function with
  one call site, built to take it.

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
  The template's prose is label + locator — which is A1's seam. Closing A2
  raised the stakes on closing A1.
- **The residue, named:** `supported` mode still carries a hint citation under
  free prose (a record backs the prose; the hint adds where else to look), so
  a model could still confabulate a note's contents *there*. That residue is
  owned by gold canary patterns (q15 and the canary comment in
  `eval/gold.yaml`), not by structure — templating supported-mode prose would
  mean templating record-backed answers, which is the product.

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

### B5. Themes are per-record; cross-medium questions have no record to land on
Each markdown file becomes one record, and `themes` are strings on that record
(`asThemes` in `src/corpus.ts`). A question that spans records — "which essays
and songs are about staying?" — has to be answered by retrieving several
individual records and hoping synthesis stitches them, with no single page to
cite for the through-line. In the production deployment this failed until each
curated theme became its own citable record: a short authored blurb stating the
through-line, the member titles grouped by collection, and the canonical URL of
the theme's browse page. Retrieval then lands the aggregate for the spanning
question and the individual record for the specific one.

- **Trade-off:** aggregate records are derived, so they must be rebuilt whenever
  membership changes, and they double as an attractive target for a lazy theme
  boost (a record whose body is a list of titles matches many queries a little).
- **Current posture:** not modeled here, by scope — the teaching corpus is four
  works, small enough that a reader holds the themes in their head. The
  README's "Where to take it" names it as a step.
- **For a fork / contributor:** derive one record per theme from the corpus at
  index time (never hand-write the member list), give it a real URL a reader
  can open, keep its blurb authored and its member list generated, and add a
  gold query that spans two collections so the aggregate has to surface.

### B6. A theme vocabulary is only as clean as its loosest alias
The theme boost rewards a verbatim theme match anywhere in a record
(`hasThemeMatch` in `src/retrieve.ts`) with no guard for ambiguity. Production
learned this the slow way: single-word aliases such as `effect`, `modes`,
`keyboard`, and `classical` matched philosophy essays in a different sense and
pulled them onto audio-craft theme pages, so the aggregate records in B5
carried wrong members and the blurb writers had to argue with their own
dossiers. The fix was vocabulary, not scoring: multi-word aliases
(`classically trained`, `musical modes`, `keyboardist`), a test that bans the
known collision words, a required blurb on every public theme, and a minimum
count of primary members before a theme earns a page (a theme that matches one
or two files is an alias of an existing theme, not a page).

- **Trade-off:** specific aliases miss some legitimate mentions; bare words
  catch everything, including the wrong sense. On a small corpus the miss is
  invisible and the pollution is cheap to spot by hand; on a large one the
  reverse holds.
- **Current posture:** themes here are freeform frontmatter strings and the
  boost is unguarded (see also the document-frequency cap in "Where to take
  it"); the example corpus is small enough that no collision has bitten.
- **For a fork / contributor:** keep one vocabulary file with lowercase,
  multi-word aliases; test it (no duplicate alias inside a theme, no bare
  collision words, a blurb on every public theme); and judge a new theme by
  its primary members, not its total matches — hub themes match half the
  corpus and make every small theme look "contained".

### B7. A public surface with no record is invisible, and the engine calls that a refusal
The engine declines honestly when the archive has nothing bearing on a
question. It declines just as honestly, and wrongly, when the site *does*
answer the question on a page that never became a record. Production found
four such pages (an apps hub, an academic CV, a Japanese-language landing page,
a press kit) only when a gold writer went looking for questions those pages
settle and every one came back `not-found`.

- **Trade-off:** none in the engine — this is the site adapter's job, and this
  repository deliberately has no page or sitemap concept. But the failure
  presents as a correct refusal, which is exactly the failure the eval is
  worst at noticing.
- **Current posture:** out of scope here; `buildCorpus` only sees the files it
  is pointed at.
- **For a fork / contributor:** in your adapter, diff the set of published
  URLs against the set of record URLs at build time and fail on the gap; and
  when you grow the gold set, write at least one query per public surface so a
  missing record fails loudly instead of politely.

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
