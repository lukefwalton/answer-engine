# Spec: the runnable scaling demo (`demo/`)

This spec was drafted when the proposed module path was `scaling/`. The module
shipped as `demo/`; historical notes that still say `scaling` are proposal
language, while `demo/` is the live path.

A ticket for the agent working on `answer-engine`. Read the repo-agent brief's **frame** first; everything there applies here, especially *confidence not apology*, *verify against the live repo never against this spec*, and *when in doubt prefer the smaller change*. This spec is downstream of `NEXT-STEPS.md` §C1; it is the worked example that backs it, linked from §6 of the paper. **`NEXT-STEPS.md` is created by the repo-agent brief, not yet on `main` — if it isn't present, this ticket waits on it or lands the link when both do.**

This document was written from discussion, then reconciled against the live repo (checked 2026-06-15). **Anything not in the confirmed list below is still a claim to verify before you rely on it.** If the repo disagrees, the repo wins; note it in your summary.

**Confirmed against the live repo (don't re-litigate):**
- License is **Apache-2.0** (LICENSE + NOTICE present). Any code you add is Apache-2.0 — no mixing question.
- Boosts and modes are exactly as the paper states: `EXACT_MATCH_BOOST = 0.30`, `THEME_BOOST = 0.15`, a score floor, in `src/retrieve.ts`. The four modes (`supported` / `partial` / `related-material` / `not-found`) and the pipeline (`validateAnswer` → `repairCitationsToEvidence` → re-derive mode → `assertCitationsGroundedInEvidence`) are live.
- The boundary lives in `src/no-leak.ts` (`assembleEvidence` / the hint type with no text field). Reuse it untouched. **Do not restate any line-count claim about it** — the brief's fix 2.1 is correcting the README's "eight lines"; don't reintroduce a number.
- Default models in `archive.config.ts`: `text-embedding-3-large` (embeddings) + `gpt-4o-mini` (answers, OpenAI Responses API via `src/answer.ts` / `src/prompt.ts`).
- **All existing `example-content/` is already synthetic fiction** ("Person A," a placeholder), notebook entries included. Fabricating private notes is the repo's *established* pattern, not a new liberty.
- The index is `artifacts/index.json`, **gitignored** "because vectors derived from private text are private." This matters for §5 — read it there.
- Frontmatter the engine reads: `title` (required), `description`/`summary`/`meaning`, `themes`/`keywords`/`topics`, `date`, `draft: true` to skip; private notes additionally need `about` (public URL to route to) and `locator` (where the moment lives). **A note's `title` and `locator` are public-safe surface that travels** — the A1 leak contract, already documented in the README's "Make it yours" §3.
- Gold lives in `eval/gold.yaml`; `npm run eval` (retrieval), `-- --full` (answers), `--ids` / `--from-report` for targeted runs; `eval/README.md` carries a failing-then-passing walkthrough — model the deliberate-fail case (§4) on it.
- No `/scaling` convention exists; CLI is `npm run index|ask|eval`. Placement below proposes a new top-level `scaling/` — see §7.

---

## 0. What this demo is, in one paragraph

The paper claims (§6) that the same gold suite which owns grounding and refusal also adjudicated every cost reduction made to run the system at scale. The production figures behind that are private and non-reproducible. This demo makes the *mechanism* runnable on a **public-domain corpus** (public domain is the absence of copyright, not a license — do not call it "permissively licensed"): it quantizes the embedding index to int8, re-ranks, and runs the full gold suite — including the must-refuse and must-route cases — to show the gate either certifying or rejecting the cheaper encoding. The claim it backs is **relative, not absolute**: not "this corpus is realistic," but "int8 preserves the verdicts full-precision produces, and where it doesn't, the gate catches it." Realism is never asserted, so a partly-authored corpus survives the claim — *provided* the honesty rules in §5 hold.

## 1. The budget rule (read before building anything)

This is a **teaching artifact, not a product**, and the paper's central claim is that the design is small enough to read in one sitting. A demo that bloats the repo falsifies the claim it exists to support. Therefore:

- The demo is a **thin module beside the existing repo, not a second system inside it.** Reuse the existing types, retrieval, and the `toRoutingHint` boundary **untouched**.
- The int8 path is an **encode/decode wrapper plus a re-rank**, not a parallel pipeline.
- The spire (§4) is **data with a flag**, not new mechanism.
- The CLI flag selects **corpus + evals only**; it never touches the contracts, the pipeline, or the boundary.
- **If any piece cannot be built within that budget — if it needs its own pipeline, its own types, or a fork of the boundary — stop. Say so in your summary and propose it as a sibling repo.** Do not bloat `answer-engine` to fit it. Halting and flagging is the correct outcome, not a failure.

Run the offline deterministic suite green and `tsc` clean before you start and after you finish.

## 2. The corpus

A name-collision corpus over two **real, public-domain** authors. Verify PD status and clean digital sources before ingesting (Gutenberg first; archive.org/HathiTrust for the minor material, which will be OCR-noisy — that noise is wanted, not a defect).

**Two authors, one colliding name:**
- **Adam Smith**, the economist/moral philosopher (1723–1790). *Wealth of Nations*, *Theory of Moral Sentiments*. Public domain.
- **George Adam Smith**, the theologian and historical geographer (1856–1942; "Adam" is a middle name — keep it, see §3 on the boost edge case). *The Book of the Twelve Prophets*, *The Book of Isaiah*, *Historical Geography of the Holy Land*, sermons, war addresses. Public domain (pre-1931 publication; author died 1942).

**Layer assignment is an authored, answerable decision made for this research — not a claim about the world.** George was a public figure; all his work is published. Designating some of it "private" is the same layer-designation move the repo's existing notebook entries already make. The README must say this plainly: *privacy here is a layer assignment enforced by the type, not a claim of secrecy.*

**The split:**
- **Public ledger (quotable records):** the economist's work **and** George's *major* works, as markdown files with `title`, a `description`/`summary`, and `themes`. **Index as short units — single prophet expositions, individual chapters — never whole volumes.** A whole volume as one embedding dilutes its topical center (see `NEXT-STEPS.md` B3) and washes out the near-ties the demo needs. Both authors' records carry real public URLs via the normal record path (Gutenberg/Wikipedia). Symmetric: linking one author but not the other is a tell that George is a decoy layer. He isn't.
- **Private ledger (searchable, never quotable):** George's *minor / windy / unstructured* material (sermons, war addresses) only, as private notes with `about` (the public George page to route to) and `locator` (where the moment lives). Real text, designated private. **No economist material in the private ledger, and no name-collision in the private ledger at all** — every private note is unambiguously George. This keeps the disambiguation problem (which Smith?) entirely in the public layer, where text is allowed to travel, and keeps the boundary demonstration uncontaminated by it.

**Watch the theme boost.** Both Smiths write on justice, morality, society — so a verbatim `themes` value (e.g. "justice") may match records by *both* authors and hand `THEME_BOOST = 0.15` to the wrong Smith. That is not a bug to design around; it is one of the near-ties the demo should *expose* (it's also the document-frequency-cap issue the README's "Where to take it" already flags). Author themes honestly per record and let the gold suite catch where the boost mis-fires under quantization. Do not curate themes to make disambiguation easy — that would be special-casing the corpus.

**Two distinct kinds of near-tie, two distinct jobs:**
1. **Name-collision near-ties (public ↔ public, George ↔ Adam):** both write dense moral prose about justice, ethics, society. These pack the space and stress **answer-mode** disambiguation under quantization. They arrive for free from real text.
2. **Layer-margin near-ties (George-private ↔ George-public, same topic):** at least one private note must be deliberately near-tied, *at the floor*, to a public George record on the *same* prophet/theme. This is the **only** thing that puts **route mode** under the quantization knife. Because it's George-against-George, it's a pure topical tie with zero name confound. **Build this on purpose; it will not appear by accident, and without it the demo silently skips route mode.** **Scope it honestly: this tests route *selection* — whether quantization flips which note wins the top slot, and whether the gate catches the resulting mode change. It does *not* touch A2.** A2 (the answer model fabricating content about a hint and citing it) is a property of the generator, orthogonal to the encoding; int8 never exercises it. A2 remains the acknowledged, untouched residue — the demo neither stresses nor closes it. Do not let "route mode" imply otherwise anywhere in the demo's prose.

**Free result worth a sentence in the notes:** because the private ledger is George-only and his titles aren't sensitive, the labels that travel (the A1 leak surface) are *naturally public-safe*. The corpus models the discipline A1 preaches, in the good case — not just the warning case.

## 3. The gold suite

Same three-mode shape as the existing gold set (`must-answer` / `must-refuse` / `must-route`), tuned so cases live where quantization bites — **near the floor and near each other.** A must-refuse case comfortably below floor proves nothing about int8; a must-route case comfortably clear proves nothing either. The marginal cases are the whole point.

Required cases:
- **Answer-mode disambiguation:** "What did Adam Smith say about justice / moral sentiments?" must resolve to the *economist*; the parallel question about the prophets must resolve to *George*. These ride the name-collision near-ties.
- **The boost edge case:** a query naming "Adam Smith" against a record authored by "George Adam Smith" — does `EXACT_MATCH_BOOST` (0.30, confirmed in `src/retrieve.ts`) fire on the partial name match? Author a gold case that pins the intended behavior, because it's exactly the kind of thing int8 reordering could tip.
- **Route mode at the margin (selection, not A2):** the George-private-vs-George-public topical tie from §2, where the private note must win the top slot and the answer must *route without restating*. The case tests whether quantization flips the selection and the gate catches it; it is not a test of A2 confabulation, which the encoding doesn't touch.
- **Refuse:** a question no Smith addressed, where nothing clears the floor.

## 4. The CLI flag and the spire

Two flags expressing one additive relationship; `--natural` is the default:

- **`--natural` (default):** real corpus only. **This run owns the headline §6/C1 numbers** (rank correlation, gold-suite pass). Nothing fabricated touches it.
- **`--natural+synthetic`:** loads the real corpus **plus** a small set of fabricated private notes and an expanded gold set. The name says it: an addition on top of the always-real baseline, not an alternative corpus. The synthetic embeddings file is the natural set **plus** the spire vectors — **same embedding model, same dimensionality**, so the homogeneity invariant (verify it; `NEXT-STEPS.md` B4) holds across the union and the spire is strictly baseline-plus-delta. Do not let the two sets drift to different models or dims; they must be mixable because synthetic *is* natural plus delta.

The flag selects **embeddings + gold set**. Both runs go through the **identical pipeline, identical contracts, identical `toRoutingHint` boundary.** If the flag touches the mechanism, the comparison is meaningless.

**Spire rules — keep it a spire, not a column:**
- Real George minor works are the **floor** of the private layer; the route mode runs on genuine found text so the baseline isn't something you authored to win. The spire is the **scalpel** for edges real text won't supply at the needed precision.
- **No third Smith. No fabricated words attributed to the real Adam Smith.** Synthetic notes are fabricated George-private notes — and because that means inventing words in a real person's mouth, every synthetic note must be **flagged in the record itself** (a `synthetic: true` field or a quarantined file), not merely in the README. Nothing can be mistaken for George's actual writing even lifted out of context.
- **Every synthetic note names the edge it tests**, in a one-line comment: which gold case, which margin, which mode. A synthetic note with no stated target is corpus-stuffing, which is the special-casing §4 of the paper forbids. The legitimate direction is *authoring an adversarial setup to make a verdict fail visibly* — never authoring the verdict itself to pass. Skew synthetic gold toward **must-refuse and route-flip** cases, not extra must-answer wins.
- **The deliberate failure lives here.** Author the note that a *tightened* encoding (int4, or a lowered floor) breaks — flipping a route into a refuse or a wrong answer — and show the gold suite catching the break. The default run proves int8 holds on real text; the spire proves the gate says *no* when pushed. That failure-caught result is worth more than any clean pass.

## 5. The int8 harness

Thin. Ship full-precision vectors as the source of truth; the demo:
1. quantizes the shipped FP vectors to one signed byte per dimension **in process**,
2. re-ranks against the quantized bytes,
3. reports **rank correlation** against the FP ranking, **and**
4. runs the **full gold suite** (all three modes) on the quantized index.

**On shipping vectors — note the deliberate divergence from the main repo.** The repo gitignores `artifacts/index.json` "because vectors derived from private text are private." The scaling demo does the **opposite**: it commits its FP vectors, so the headline run is reproducible with no key. This is not a contradiction — it's the layer-designation point made concrete, and it works here for a reason the demo's README must *state*, not gesture at: the demo's "private" layer is public-domain George text, so its embeddings reveal nothing that isn't already public. **With genuinely private text, committed embeddings are a real exposure surface — embedding inversion can recover approximate source content — which is exactly why the main repo gitignores its index.** Say this explicitly, or an adopter copies "commit your vectors" as a general pattern and learns the wrong lesson. (The vectors must be `text-embedding-3-large` at its native dimensionality, matching `archive.config.ts`, or the homogeneity invariant rejects them.)

**The trap to avoid:** a demo that reports rank correlation and stops has shown a retrieval benchmark, not answerability governing tuning. The point is that the *same gate that owns refusal and routing* signed off. Rank correlation is necessary, not sufficient; the gold suite including refuse/route is the actual adjudicator. State the two-part admissibility the paper draws (§6): norm cancellation is *algebra* (exact, guaranteed); integer rounding reordering near-ties is *measured* (gated by the suite, not proven). Version the wire format so a code/data mismatch fails loudly.

**Headline metrics come from the default (real-only) run. The spire's effect is reported on its own line, broken out — never folded into the headline number** — so a reader can tell whether int8 held because the encoding is sound or because notes were hand-placed to look sound.

## 6. README disclosures (non-negotiable)

Three things, plainly:
1. **Layer designation, not secrecy.** "Private" means the type cannot carry this text, regardless of what the text is; George's minor works are public-domain and the split is an authored research decision.
2. **The synthetic spire is fabricated and flagged.** Loaded only under `--natural+synthetic`; additive; never in the headline metrics; each note labeled in the data.
3. **The claim is relative.** int8 preserves the verdicts full-precision produces; the corpus is not offered as realistic and nothing turns on its realism.

Optionally, the George/Adam disambiguation mirrors the real two-tier citation surface on the production site, and the architecture (not the scale) is what's reproducible here — reproduce the architecture publicly, the scale stays reported in §6.

**Register:** write the demo's README and notes in the papers' sparser punctuation register — prefer colon, semicolon, comma, or parentheses over the em-dash, and split sentences when none fits. The brief's fix 2.4 is thinning em-dashes out of the existing `production-scaling.md`; don't author new prose that immediately needs the same pass.

## 7. Placement and done-criteria

No `/scaling` convention exists in the repo; the CLI is `npm run index|ask|eval` over `src/`, `example-content/`, and `eval/`. Proposed placement, as a thin module **beside** the existing code:

- A new top-level **`scaling/`** holding: its own README (the disclosures in §6), the corpus (`scaling/corpus/` — public collections + private George notes, plus a flagged spire subset), **a `scaling/corpus/README.md` (the dataset manifest — see below)**, its gold file (`scaling/gold.yaml`), the committed FP vectors, and the quantize + harness code. The int8 wrapper and re-rank reuse `src/retrieve.ts` and the `src/no-leak.ts` boundary rather than reimplementing them.
- **The dataset README (`scaling/corpus/README.md`) is a required deliverable, drafted (`scaling-corpus-README.md`).** It is the corpus's answerable half: a public-domain provenance table (per work: author, date, source ID, PD basis, OCR-quality note) plus a short manifest owning the authored choices a hostile referee would otherwise "expose" — the partly-fabricated corpus, privacy-as-layer-designation, the synthetic-flagging rule, the deliberate failure, honest colliding themes, the split rationale, and the spire-not-column limit. Write it confidence-not-apology: each entry names the choice and the reason, then stops. It is also the home of the open George-minor-works sourcing item.
- Two `npm run` scripts (e.g. `scaling:run` / `scaling:run -- --natural+synthetic`) that point the existing pipeline at the scaling corpus and apply the int8 pass. The flag selects corpus + gold only; it never forks the pipeline.
- **If a clean build needs more than that — its own retrieval, its own types, a second pipeline — stop and propose it as a sibling repo per §1.** A new top-level dir is the ceiling; a second system inside the repo is the line.
- Linked from `NEXT-STEPS.md` §C1 ("a runnable miniature of the mechanism ships at `scaling/`") and reachable from the README's next-steps link — once `NEXT-STEPS.md` exists (see header).
- **Cohere with `production-scaling.md`.** The repo carries a prose scaling doc (`production-scaling.md`, edited by the brief's fix 2.4) that argues the C1 case in words; this demo is its runnable counterpart. Cross-link the two and do not duplicate its argument — the prose makes the case, the demo runs it. **That file did not appear in the repo's top-level listing when checked; confirm where it lives (subdir or pending) before linking, and note the location in your summary.**

Done-criteria:
- **Reconcile the "pulls none of these levers" claim (do this, it's a real omission).** Once `scaling/` lands, `NEXT-STEPS.md`'s section-C intro ("This repository is full-precision and indexes documents whole; it pulls none of these levers") is false: the repo now contains int8 code. Update C-intro and C1 to distinguish the **deliberately-simple core** (full-precision, pulls no levers) from the **`scaling/` miniature** (an explicitly-marked illustration that pulls exactly one, int8, on a short-unit corpus). The core's claims stay true of the core; the demo is named as the exception. *Note the demo indexes short **whole** units, not chunked windows — so "indexes documents whole" stays true and only the int8 claim needs the carve-out.*
- **Flag for the author (not an agent task):** the paper's §5 ("retrieval is in-memory and unchunked … pulls none of these levers") has the same tension *if `scaling/` is in the anonymized submission snapshot*. That's a paper edit (a one-line §6 bridge so §5 reads as describing the core), and it's the author's, not the agent's. It is also **conditional**: if `scaling/` is deferred past review, §5 is correct for the snapshot and this is a later public-repo concern only. The agent should note in its summary whether `scaling/` is present in any snapshot it builds.
- Offline deterministic suite (`npm test`) green; `npm run typecheck` clean — **both before you start and after you finish** (brief's frame).
- Default (`--natural`) run reproducible **without a key**, because FP vectors are committed (§5). A key, if used at all, only *regenerates* embeddings or runs the answer-model pass; it is never a gate on the headline demo.
- **One sourcing check that can block the build:** confirm George's *minor/windy* material (sermons, war addresses) actually exists in clean public-domain digital form. The major commentaries are confirmed on Gutenberg; the minor material is the private layer's whole foundation. If only the big commentaries are digitized, the private ledger is thin — use the fallback (designate a short *section* of a major work private) rather than padding with synthetic, which would turn the spire into a column. Record the outcome in `scaling/corpus/README.md`'s provenance table, where this item already lives as "OPEN."
- In your summary: the corpus sources and their verified PD status; any place the repo disagreed with this spec; the headline numbers (real-only) with the spire's effect broken out separately; and confirmation that the int8 path reused the existing retrieval and boundary rather than forking them.
