# answer-engine Standards

## Purpose

This repo teaches answerability through code, not prose, and since 3.0.0 it is also the substrate a consumer imports: the archive contract in `docs/CONTRACT.md` is its design of record. Every PR is judged on whether it keeps the promises checkable: the disclosure boundary, citation grounding, and the refusal discipline.

## 1. Boundary Integrity (Non-Negotiable)

This is the whole point. Private text must never reach a model or a caller except as its policy allows, and the policy is a type.

- **`project()` is the one crossing** (`src/no-leak.ts`). Retrieval returns `ScoredHit`, which holds the fragment and never leaves the process; `project()` turns it into an `EvidenceHit`, and `search()` is `retrieve().map(project)`. No other function hands retrieval output onward.
- **`EvidenceHit` has no field for private text.** The `locator` variant carries provenance only; the `semantic` variant carries a lint-passed gist and nothing else; `text` is unreachable for a private fragment because `Disclosure` has no `private + text` member. Scores on private hits are coarse and carry no `breakdown`.
- **Exposure is resolved at build, never at query time.** `resolveDisclosure` only downgrades; `isServableGist` is the one predicate every later check cites; a served index is `toServedIndex(privateIndex)`, and `validateServedIndex` checks the strip at load. `validateIndex` re-earns every served gist against the text at every load of a private index; `lint: 'passed'` in a file is not a verdict. Nothing is generated or decided per query.
- **Authored strings on a private entity are linted, not typed.** Title, version, names, roles, themes, locator values and the rendered label pass `assertPublicSafeMetadata` against the entity's text at build and at every load of a private index. Say "linted" where it is linted; do not describe a bounded string as a structural guarantee.
- **The gist never enters the prompt.** `RoutingHint` has no prose field; `toAnswerEvidence` carries gists beside the hints, and only the related-material template renders one, after the mode is final.
- **Citations are grounded in retrieved evidence.** No invented `(id, url)` pairs. The model cannot claim a citation; the evidence validates it.
- **Modes are derived from evidence after repair/validation, not from model self-report.** Don't trust what the model says about citation count.
- **not-found means empty answer + zero citations.** No partial answers when grounding fails.
- **judgeAnswer citation guards (partial = record-only, related-material = hint-only) must stay aligned with mode semantics in gold eval.**
- **Reject PRs that "fix" behavior by special-casing query text, loosening grounding, or loosening a policy**, even if tests pass. If something breaks, fix the corpus, the scoring, the prompt, or the policy — never the question.

## 2. Eval and Tests (The Regression Contract)

Offline tests are the CI gate; gold eval is the behavioral gate.

- **`npm test` must stay green without an API key.** No hidden dependencies on live OpenAI calls. `npm run test:dist` builds the package and imports it by name; it is in CI too.
- **Changes to prompt, retrieval, validation, repair, or an entity's exposure should consider `eval/gold.yaml`.** An exposure change is gated like a scoring change. Especially: refusals, CANON vs PROCESS modes, the bridge query, `forbidRecordCitations` alignment on boundary gold queries, and the `canaries` list, which `npm run eval` sweeps keylessly over every served gist before any API call.
- **New behavior worth keeping gets a gold query or unit test, not a one-off fix.** Fix corpus, scoring, prompt, or policy — never special-case the question (see §1).
- **Full eval (`npm run eval -- --full`) is manual / pre-merge, not required in CI.** Integration/e2e against OpenAI is not expected in GitHub Actions. **Run `--full` on `--ids` or `--from-report` subsets**, not the whole gold set while iterating.
- **The demo headline does not move** (`npm run demo:run`: int8 7/7 at rho 1.0000; the spire 9/9; int4 rejected). A change that moves it is a scoring change and is gated as one.

## 3. Architecture (Small and Intentional)

The substrate owns the contract types, the projection boundary and its lint, policy resolution, retrieval with plugin seams, ingest helpers (fragmenters, the gist drafter, the projections file, adapters from simple corpus shapes), the two index artifacts, the eval harness, and the teaching-sized synthesis as the reference consumer — and nothing else. Resist growing it.

- **Pure logic in `src/*.ts`; IO in `src/cli/*`.** The CLIs are the clone-and-run teaching path and are not part of `dist/`.
- **Extension points are the seams, not new layers.** A boost is a `BoostPlugin`; a re-rank is a `PostRank`; a drafter is a `GistDrafter`; a corpus shape is an adapter that produces `Entity` + `Fragment`. A contribution that needs a new layer is probably a consumer.
- **HTTP, MCP transport, transcription, site boosts, product routes, caching, and a vector database live in the consumer** (`ask-the-archive/`, or yours), not here. `docs/CONTRACT.md` §15 is the list.
- **Teaching clarity beats abstraction.** A reader should understand the pipeline in one sitting: corpus → ingest → index → retrieve → project → consumer.

## 4. Error Handling (Loud Failures)

Fail fast and name the problem and the remedy. Silent fallbacks hide bugs.

- **Malformed corpus, index, projections file, or answer JSON → clear throw, not swallow.**
- **A private index that would be refused at load is refused at write**: a fragment whose entity is missing, an entity with no fragment, an entity or fragment id listed twice, a `semantic` fragment without a servable gist, an authored string that quotes the private text, a gist that quotes the text it stands in for.
- **Empty evidence → not-found without calling the model.**
- **Validator/repair/grounding rejections stay explicit errors, not "best effort" answers.**
- **Logging: minimal is fine. No PII, no API keys, no private text or gists in logs.**
- **A lint or validator message names ids, fields, and positions, never a value.** A run a string shares with private text is reported as `words 3–7`, not quoted; a malformed field is named, not echoed. What `npm run index`, CI, or a consumer's loader prints is therefore safe to print by construction.

## 5. Security & Performance (Light Touch, Specific)

Not a hardened production service, but a few things matter.

- **Secrets: never commit `.env`; don't log prompts with keys.**
- **Don't leak private embeddings, text, or projections into committed artifacts.** (`artifacts/` is gitignored for a reason: the index and the projections file are private material.) The one exception is `demo/`: it commits only the exact public-domain natural sources and flagged synthetic spire allowlisted in `demo/artifacts.test.ts`, on purpose, to reproduce the headline with no key. Some public-domain sources are routed through the private layer to exercise the boundary, but that is a demo layer assignment, not a secrecy claim. Do not generalize it to genuinely-private corpora.
- **Custody is named, not overstated.** Private text reaches the embedding provider at ingest and, only where a gist was requested, the drafter. The boundary is disclosure on the served path, not confidentiality from the providers the operator chooses (`docs/CONTRACT.md` §10). Don't describe it as more.
- **Performance: brute-force cosine is intentional at this scale.** Don't add pgvector, HTTP, or caching in a drive-by PR unless the README's "Where to take it" story is the explicit goal.

## 6. Style & Naming (Follow the Room)

- **Match surrounding code:** `Entity`, `Fragment`, `EvidenceHit`, `ScoredHit`, `project`, `search`, `resolveDisclosure`, `isServableGist`, `assertSemanticProjection`, `assertPublicSafeMetadata`, `draftProjections`, `BoostPlugin`, `AnswerOutput`, `RoutingHint`, `judgeAnswer`, `repairCitationsToEvidence`.
- **`exposure` names the dimension, `raw` names the layer, `cosine` names the similarity.** Not "visibility", "tier", or "semantic score".
- **TypeScript strictness, existing import style, sober comment tone.**
- **README changes: factual, not pitch-deck. Don't duplicate thesis paragraphs.**
- **Match existing formatting and import style. No new lint tooling without an explicit PR goal.**

## What Matters Less

Unless the PR is explicitly about it:
- E2E browser tests
- Micro-optimizing embedding batching
- A `bin` entry (the CLIs are the clone-and-run path, not the library)
- Matching ask-the-archive feature-for-feature
