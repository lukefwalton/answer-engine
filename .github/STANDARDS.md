# answer-engine Standards

## Purpose

This repo teaches answerability through code, not prose. Every PR is judged on whether it keeps the two promises checkable: the no-leak boundary and citation grounding.

## 1. Boundary Integrity (Non-Negotiable)

This is the whole point. Private text must never reach the prompt.

- **RoutingHint has no prose field.** Private notes stay out of the model's input.
- **assembleEvidence strips private text.** No exceptions, no special cases.
- **Citations are grounded in retrieved evidence.** No invented `(id, url)` pairs. The model cannot claim a citation; the evidence validates it.
- **Modes are derived from evidence after repair/validation, not from model self-report.** Don't trust what the model says about citation count.
- **not-found means empty answer + zero citations.** No partial answers when grounding fails.
- **judgeAnswer citation guards (partial = record-only, related-material = hint-only) must stay aligned with mode semantics in gold eval.**
- **Reject PRs that "fix" behavior by special-casing query text or loosening grounding**, even if tests pass. If something breaks, fix the corpus, scoring, or prompt — never the question.

## 2. Eval and Tests (The Regression Contract)

Offline tests are the CI gate; gold eval is the behavioral gate.

- **`npm test` must stay green without an API key.** No hidden dependencies on live OpenAI calls.
- **Changes to prompt, retrieval, validation, or repair should consider `eval/gold.yaml`.** Especially: refusals, CANON vs PROCESS modes, the bridge query, and `forbidRecordCitations` alignment on boundary gold queries.
- **New behavior worth keeping gets a gold query or unit test, not a one-off fix.** Fix corpus, scoring, or prompt — never special-case the question (see §1).
- **Full eval (`npm run eval -- --full`) is manual / pre-merge, not required in CI.** Integration/e2e against OpenAI is not expected in GitHub Actions. **Run `--full` on `--ids` or `--from-report` subsets**, not the whole gold set while iterating.

## 3. Architecture (Small and Intentional)

The design is five ideas in one pipeline. Resist growing it.

- **Pure logic in `src/*.ts`; IO in `src/cli/*.`**
- **No new layers for one-off helpers.** Match existing file roles: retrieve, answer, no-leak, evaluate, prompt.
- **Teaching clarity beats abstraction.** A reader should understand the pipeline in one sitting.
- **Don't wire in site-specific or transcription logic here.** That belongs in `ask-the-archive/`, not answer-engine.

## 4. Error Handling (Loud Failures)

Fail fast and name the problem. Silent fallbacks hide bugs.

- **Malformed corpus, index, or answer JSON → clear throw, not swallow.**
- **Empty evidence → not-found without calling the model.**
- **Validator/repair/grounding rejections stay explicit errors, not "best effort" answers.**
- **Logging: minimal is fine. No PII, no API keys, no private note bodies in logs.**

## 5. Security & Performance (Light Touch, Specific)

Not a hardened production service, but a few things matter.

- **Secrets: never commit `.env`; don't log prompts with keys.**
- **Don't leak private embeddings/text into committed artifacts.** (The index is gitignored for a reason.) The one exception is `demo/`: it commits only the exact public-domain natural sources and flagged synthetic spire allowlisted in `demo/artifacts.test.ts`, on purpose, to reproduce the headline with no key. Some public-domain sources are routed through the no-leak layer to exercise the boundary, but that is a demo layer assignment, not a secrecy claim. Do not generalize it to genuinely-private corpora.
- **Performance: brute-force cosine is intentional at this scale.** Don't add pgvector, HTTP, or caching in a drive-by PR unless the README's "Where to take it" story is the explicit goal.

## 6. Style & Naming (Follow the Room)

- **Match surrounding code:** `AnswerOutput`, `RoutingHint`, `judgeAnswer`, `repairCitationsToEvidence`, etc.
- **TypeScript strictness, existing import style, sober comment tone.**
- **README changes: factual, not pitch-deck. Don't duplicate thesis paragraphs.**
- **Match existing formatting and import style. No new lint tooling without an explicit PR goal.**

## What Matters Less

Unless the PR is explicitly about it:
- E2E browser tests
- Micro-optimizing embedding batching
- npm package exports / bin (explicitly not a library)
- Matching ask-the-archive feature-for-feature