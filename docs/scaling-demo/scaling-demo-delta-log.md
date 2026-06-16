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

| # | Spec assumption | What the build actually did | Touches | Downstream action |
|---|---|---|---|---|
| 1 | Score floor as shipped (`SCORE_FLOOR`) puts marginal cases where int8 can flip them | _fill: kept / tightened to \<value\>_ | `spec`, maybe `NEXT-STEPS` (B1) | If moved, document the new floor and that it's model-dependent (B1) |
| 2 | int8 holds the full gold suite on the real corpus (headline pass) | _fill: held / didn't_ | `nothing` if held; investigate if not | Headline number for §6/C1 |
| 3 | A tightened encoding (int4 / lowered floor) flips a **route** case and the gold suite catches it — the deliberate failure | _fill: fired at \<setting\> / did NOT fire_ | `spec` if settings changed | **If it doesn't fire, near-ties are too loose — tighten margin, do NOT add corpus.** This is the result the demo rests on |
| 4 | George sermons index as short **whole** units without diluting their topical center (so "indexes documents whole" stays true) | _fill: whole units worked / had to split a sermon_ | **`paper §5–§6`** if split | **Highest stakes.** If any unit is split into windows, the demo now chunks; "in-memory and unchunked" breaks and the §5 reconciliation grows. Watch sermon length specifically |
| 5 | `EXACT_MATCH_BOOST = 0.30` fires (or not) on "Adam Smith" vs "George Adam Smith" partial match as the gold case predicts | _fill: actual behavior_ | `spec` | Pin the observed behavior in the gold case |
| 6 | Both-Smith shared theme (e.g. "justice") mis-fires the theme boost, and the gold suite exposes it | _fill: observed / didn't occur_ | `spec` | Keep as exposed near-tie; do not curate themes to suppress it |
| 7 | FP vectors commit cleanly and the default run reproduces with no key | _fill: yes / issue_ | `spec` | Confirms the no-key headline claim |
| 8 | Demo is a thin module: reuses `src/retrieve.ts` + `src/no-leak.ts` untouched, no second pipeline | _fill: stayed thin / needed more_ | `spec`; **halt if it needs its own pipeline** | If it can't stay thin, propose a sibling repo per the budget rule — do not bloat |

## Recon-pass deltas (verification against `60b727f`, 2026-06-16)

Seeded before any build code, from the reconnaissance pass. The spec's "Confirmed against the live repo" block was reconciled 2026-06-15; this records where the live repo at `60b727f` (now `origin/main`, identical to the build branch) already diverged from the spec's assumptions, or confirmed a doubted point.

| # | Spec assumption / open question | What the repo actually shows | Touches | Downstream action |
|---|---|---|---|---|
| R1 | `NEXT-STEPS.md` "not yet on `main`; this ticket waits on it" (spec header) | Present on `origin/main` at `60b727f`, alongside `CONTRIBUTING.md` and `docs/production-scaling.md`. The dependency is satisfied; nothing waits on it | `NEXT-STEPS` | None to wait on; the demo links into it at merge (see R2) |
| R2 | "Linked from `NEXT-STEPS.md` §C1 ('a runnable miniature ships at `scaling/`')" | §C1 is titled "More aggressive quantization" (int8 to int4/PQ/binary). No "runnable miniature" sentence or `scaling/` link exists yet. §C1 is the right home (its int4 paragraph is the demo's deliberate-failure lever); the link does not pre-exist | `NEXT-STEPS` | Demo ADDS the §C1 link and the C-intro core-vs-miniature carve-out at merge. Not a precondition |
| R3 | Brief's fix 2.1 "is correcting the README's 'eight lines'; don't reintroduce a number" | `README.md:91-92` still reads "`toRoutingHint` is eight lines", wrapped in em-dashes. Fix 2.1 has NOT landed (fix 2.4, em-dash thinning of `production-scaling.md`, HAS: 0 em-dashes there) | `nothing` (core-doc seam owned by the brief) | Do not restate any line count in demo prose. Flag to author that 2.1 is still pending; do not fix it here (additive-only mandate) |
| R4 | "Same three-mode shape ... `must-answer` / `must-refuse` / `must-route`" (spec §3) | Gold schema has no `must-*` tags. It is `expectAnswerMode` (one of supported/partial/related-material/not-found, required) plus `expectSources`/`forbidSources`/`forbidRecordCitations`/`forbidAnswerPatterns` (`src/evaluate.ts` `loadGold`). The three "modes" are a conceptual grouping | `spec` | `scaling/gold.yaml` uses the real schema; keep the spec's must-* language as conceptual only |
| R5 | "Default run reproducible without a key ... runs the full gold suite (all three modes) on the quantized index" (spec §5) | `src/cli/eval.ts` embeds gold queries LIVE (`OPENAI_API_KEY` required, lines 169-171). Keyless = `judgeRetrieval` (`expectSources`/`forbidSources`, pure). Answer-mode label needs `--full` -> `judgeAnswer` -> the answer model (key). The structural `not-found` short-circuit (`answer.ts:174`) is the one keyless mode verdict | `spec` (§5) | Demo commits GOLD QUERY vectors too, not only corpus FP vectors. Headline (keyless) = rank-corr + `judgeRetrieval` over committed vectors; `--full` answer-mode pass is the optional key-gated tier. State the two-tier gate precisely. Refuse cases must use `forbidSources` (a near-floor source named) to bite keyless |
| R6 | "Reuse `src/retrieve.ts` + `src/no-leak.ts` untouched, no second pipeline" (budget rule) | Reusable as parameterized pure functions: `readIndexFile(path)` / `writeIndexFile(entries, path)` accept a path (`src/store.ts:40,67`); `buildCorpus(config)` / `buildPrivateNotes(config)` take a config; `retrieve()`, `assembleEvidence`/`toRoutingHint`, `judgeRetrieval`/`judgeAnswer`/`loadGold`, `answerQuestion` are pure/parameterized. The demo points them at `scaling/` data with no fork | `nothing` (confirms pre-seeded row 8) | Build the thin module; no sibling repo needed. Budget rule satisfied at recon |
| R7 | "`production-scaling.md` did not appear in the top-level listing; confirm where it lives" (spec §7) | Lives at `docs/production-scaling.md` (already cross-linked from `README.md:273`). §2 is the int8 prose this demo runs. Em-dashes: 0 (fix 2.4 landed) | `spec` (§7) | Cross-link `docs/production-scaling.md` <-> `scaling/README.md`; do not duplicate its argument |
| R8 | Boosts/floor/wire-format constants | Confirmed verbatim in `src/retrieve.ts` AND `NEXT-STEPS.md` B1: `EXACT_MATCH_BOOST = 0.3`, `THEME_BOOST = 0.15`, `SCORE_FLOOR = 0.2`. `INDEX_SCHEMA_VERSION = 2` (`src/store.ts:18`): the FP wire format is already versioned | `nothing` | Reuse the constants. The demo's int8 wire format needs its OWN version stamp (spec §5: version the wire so a code/data mismatch fails loudly) |
| R9 | Pipeline chain (spec confirmed block) | `validateAnswer` -> `repairCitationsToEvidence` (re-derives mode via `deriveMode`, `answer.ts:123`) -> `assertCitationsGroundedInEvidence` is exact (`answer.ts:196-198`). Four modes live (`types.ts:83`). `no-leak.ts` boundary intact (`RoutingHint` has no text field). Default models `text-embedding-3-large` / `gpt-4o-mini`. Index `artifacts/index.json` gitignored. All frontmatter fields confirmed in `corpus.ts` | `nothing` | None; confirmed as assumed |

## Open-ended rows (add as testing surfaces them)

| # | Spec assumption | What the build actually did | Touches | Downstream action |
|---|---|---|---|---|
| 9 | | | | |
| 10 | | | | |

## Merge-day assembly (do this the day the demo lands, while it's hot)

Walk the log top to bottom:
- Every `spec` row → correct the spec and corpus README so they're true.
- Every `NEXT-STEPS` row → write the C-intro/C1 edit distinguishing core (pulls no levers) from `scaling/` miniature (pulls one, marked), using the actual facts logged.
- Every `paper §5–§6` row → write the one-line bridge so §5's "in-memory and unchunked … pulls none of these levers" reads as describing the core. **If row 4 fired (a unit was split), this is no longer one line — the unchunked claim itself needs revisiting.**
- Confirm the anonymization checklist still covers any new identifying surface the demo added.

The reconciliation is then assembly from recorded facts, not authorship under pressure. That was the point of keeping the log.
