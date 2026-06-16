# Delta log — scaling demo build

The lab notebook for building `scaling/`. The spec states assumptions; the build establishes facts; this log records every place they diverge. Fill it **during** testing, not after — the point is to write the downstream docs once, from ground truth, instead of authoring them under time pressure on merge day.

**Why this exists:** the reconciliation edits (NEXT-STEPS C-intro/C1, the paper §5/§6 line) are *descriptions of what the built demo actually does*. They can't be written accurately before the build, and "verify against the live repo, never against the brief" applies one level up here too. Defer the prose; don't defer the obligation — every row tagged `paper` or `NEXT-STEPS` is a downstream edit that comes due at merge.

## How to use it

For each assumption the spec makes, record what the build actually did and what that touches. A row only matters if reality diverged or confirmed-under-doubt. The **Touches** column is the early-warning system: most deltas are `spec` (fix the spec so it stays true) or `nothing`; the ones tagged `paper` are the ones that change a published claim and must not be discovered by a referee.

**Touches** values:
- `spec` — correct `SCALING-DEMO-spec.md` / `scaling/corpus/README.md` so they describe the real build.
- `NEXT-STEPS` — the C-intro/C1 core-vs-miniature reconciliation depends on this fact.
- `paper §5–§6` — changes a claim in the paper (in-memory, unchunked, pulls no levers). Highest stakes. Flag immediately.
- `nothing` — confirmed as assumed; log it so you know it was checked.

## Pre-seeded rows (the deltas most likely to surface)

**Build context (read before the rows).** The session that built `scaling/`
had egress to GitHub only: `api.openai.com`, Gutenberg, and archive.org all
returned `host_not_allowed`, and no `OPENAI_API_KEY` was set. So the code, the
gold set, the provenance manifest, and the deterministic harness tests are
committed and green, but the real text bodies and the committed vectors are
**pending a build run** (a local agent with network + key; see
`build-handoff.md`). Rows about what the *real run* produced are marked PENDING;
rows about the *mechanism and structure* are settled now.

| # | Spec assumption | What the build actually did | Touches | Downstream action |
|---|---|---|---|---|
| 1 | Score floor as shipped (`SCORE_FLOOR`) puts marginal cases where int8 can flip them | Confirmed `SCORE_FLOOR = 0.2` in `src/retrieve.ts` (model-dependent, B1); gold cases authored near it. Real-run margin PENDING build | `spec`, maybe `NEXT-STEPS` (B1) | If the build moves it, document the new floor and that it's model-dependent |
| 2 | int8 holds the full gold suite on the real corpus (headline pass) | PENDING build. Mechanism proven offline (`quantize.test.ts`: int8 certifies the route case) | `nothing` if held; investigate if not | Headline number for §6/C1, recorded at build |
| 3 | A tightened encoding (int4 / lowered floor) flips a **route** case and the gold suite catches it | Mechanism PROVEN offline (the payload test: int8 holds, int4 flips the top slot, the gate catches it). Real spire authored (`syn-amos-justice-margin`); calibration to fire on real vectors PENDING build | `spec` if settings changed | **If it doesn't fire on real vectors, tighten the margin, do NOT add corpus.** Handoff §4 |
| 4 | George sermons index as short **whole** units (so "indexes documents whole" stays true) | Authored as short whole units, one sermon per file, not split. Real sermon length not verifiable here (no source access) | **`paper §5–§6`** if split | **Highest stakes.** Build agent watches sermon length; if any unit is split into windows, "in-memory and unchunked" breaks and the §5 reconciliation grows |
| 5 | `EXACT_MATCH_BOOST = 0.30` fires (or not) on the "Adam Smith" vs "George Adam Smith" partial match | Designed live: record **titles carry the full author name** so a query's "Adam Smith" phrase-matches a "George Adam Smith" title; `boost-edge-micah` gold pins it. Observed behavior PENDING build | `spec` | Pin the observed behavior in the gold case at build |
| 6 | Both-Smith shared theme (e.g. "justice") mis-fires the theme boost, and the gold suite exposes it | Collision authored on purpose (Amos/Micah carry "justice", as does TMS); not curated away. Observed behavior PENDING build | `spec` | Keep as an exposed near-tie; do not curate themes to suppress it |
| 7 | FP vectors commit cleanly and the default run reproduces with no key | Keyless runner built and degrades cleanly. **DIVERGENCE:** the core eval CLI requires a key (it embeds gold queries at run time), so the keyless headline needs committed **gold-query** vectors, not just FP vectors. Added `query-vectors.json`; `build.ts` writes it | `spec` | Spec §5 should say "FP **and gold-query** vectors committed" for the no-key claim |
| 8 | Demo is a thin module: reuses `src/retrieve.ts` + `src/no-leak.ts` untouched, no second pipeline | **CONFIRMED.** Reuses `retrieve()`, `cosine()`, the no-leak boundary, the gold judges, `store`, the corpus loaders, and embedding untouched; the int8 path is `quantize.ts` plus a re-rank. No core types changed. Budget held, **no halt** | `spec` | None; the budget claim holds |

## Open-ended rows (surfaced during the build)

| # | Spec assumption | What the build actually did | Touches | Downstream action |
|---|---|---|---|---|
| 9 | Spec §2: "records carry real public URLs via the normal record path" | **DIVERGENCE.** Per-unit real URLs do not exist (Gutenberg is work-level) and `src/corpus.ts` is reused untouched, so record citation URLs are constructed demo-canonical (`.example` TLD), symmetric across both authors; the provenance table holds the real sources, and private-note `about` targets ARE real | `spec` | Soften §2 to "demo-canonical citations, real provenance + real route targets" (already stated in `corpus/README.md`) |
| 10 | Spec quotes `NEXT-STEPS.md` §C1 as already saying "a runnable miniature ships at `scaling/`" | The live §C1 has no such line. The §C1 link and the C-intro carve-out are **deferred reconciliation** (prepared text below), applied by the build agent **after** `scaling:run` confirms the headline, so "runnable" is verified not asserted | `NEXT-STEPS` | Apply the prepared edit at build, not before |
| 11 | Spec §7: `production-scaling.md` location "unconfirmed (subdir or pending)" | RESOLVED at `docs/production-scaling.md`, em-dashes already thinned (fix 2.4 landed). `scaling/README.md` cross-links it | `spec` | None; resolved |
| 12 | The keyless gate catches route flips | `judgeRetrieval` checks presence in top-K only, so it misses a top-slot flip where the note stays retrieved. **Added a keyless route-selection check** (`topSource`) for related-material cases, so a flip that keeps the note in top-K is still caught | `spec` | Note the route check in the spec's §5 harness description |
| 13 | The answer-mode pass governs the route/refuse verdicts | The keyless headline covers retrieval + route selection + refuse-by-floor; the answer-mode adjudication (related-material routes without restating) is the `--full` keyed pass. `answerQuestion` short-circuits to not-found on empty evidence, so refuse-by-empty-floor is keyless even under `--full`. Route tests selection, not A2 | `spec` | Clarify the two tiers (keyless retrieval gate vs keyed answer gate) in §5 |
| 14 | (build) the corpus and vectors are produced in this session | Blocked by egress (GitHub-only) and a missing key; deferred to a local agent per `build-handoff.md`. Code, structure, gold, and tests committed and green | `nothing` (process) | Run the handoff to complete the demo |
| 15 | `.github/STANDARDS.md` line 51: "Don't leak private embeddings/text into committed artifacts" | The demo commits `scaling/corpus/index.json` with the public-domain George "private"-layer vectors, **on purpose** (spec §5): the layer is public-domain (a layer assignment, not secrecy), the file is deliberately not gitignored, and README §2 + manifest §2 explain it with the inversion warning. The automated review flagged the standard. No design change; the standard is about genuinely-private data | `STANDARDS` reconciliation | Add a one-line carve-out at merge (prepared below) so the demo's public-domain exception is named, not re-flagged |

## Merge-day assembly (do this the day the demo lands, while it's hot)

Walk the log top to bottom:
- Every `spec` row → correct the spec and corpus README so they're true.
- Every `NEXT-STEPS` row → write the C-intro/C1 edit distinguishing core (pulls no levers) from `scaling/` miniature (pulls one, marked), using the actual facts logged.
- Every `paper §5–§6` row → write the one-line bridge so §5's "in-memory and unchunked … pulls none of these levers" reads as describing the core. **If row 4 fired (a unit was split), this is no longer one line — the unchunked claim itself needs revisiting.**
- Confirm the anonymization checklist still covers any new identifying surface the demo added.

The reconciliation is then assembly from recorded facts, not authorship under pressure. That was the point of keeping the log.

## Prepared reconciliation text (apply at build, once `scaling:run` confirms the headline)

These edits describe what the demo *does*. They are held here, not applied,
because the demo is not runnable until the vectors are built (rows 2, 14). Apply
them only after `scaling:run --natural` confirms the headline, so "a runnable
miniature ships" is verified, not asserted.

**`NEXT-STEPS.md` §C-intro** (row 10). It currently reads: "This repository is
full-precision and indexes documents whole; it pulls none of these levers."
Once `scaling/` lands, the repo contains int8 code, so distinguish core from
miniature, for example:

> This repository's **core** is full-precision and indexes documents whole; it
> pulls none of these levers. The one exception is the marked illustration at
> `scaling/`: a runnable int8 miniature on a short-whole-unit public-domain
> corpus, which pulls exactly one lever (int8 quantization) to show the gold
> suite gating it. The core's claims stay true of the core; `scaling/` is named
> as the exception. (It still indexes short units *whole*, so "indexes documents
> whole" holds; only the lever claim needs the carve-out.)

**`NEXT-STEPS.md` §C1** (row 10). Add a pointer in the int8 lever, for example:
"A runnable miniature of this lever ships at `scaling/` (see
`scaling/README.md`); it is the public, gated counterpart to the private
production figures above."

**`.github/STANDARDS.md` line 51** (row 15, raised by the automated review).
"Don't leak private embeddings/text into committed artifacts. (The index is
gitignored for a reason.)" stays true of the core. Name the demo's exception so
it is not re-flagged, for example:

> The one exception is the `scaling/` demo. Its "private" layer is public-domain
> text by design (a layer assignment, not secrecy), so it commits
> `scaling/corpus/index.json` on purpose, to reproduce the headline with no key.
> See `scaling/README.md` §2 for why that is safe there and must not be
> generalized to a genuinely-private corpus.

**Paper §5/§6 (author's call, conditional).** The published note's §5 says
retrieval is "in-memory and unchunked … indexed whole." That stays true of the
core and of the demo's short whole units. **Only if `scaling/` is in an
anonymized submission snapshot** does §6 want a one-line bridge so §5 reads as
describing the core, not the `scaling/` exception. This is a paper edit, the
author's not the agent's, and it is moot if `scaling/` is deferred past review.
Note in the build summary whether `scaling/` is present in any snapshot built.
**If row 4 fired (a sermon had to be split), the unchunked claim itself needs
revisiting, not just a bridge.**
