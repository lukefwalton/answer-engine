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
