# Security Policy

Answer Engine is the reference implementation of the archive contract
(`docs/CONTRACT.md`): a package a consumer imports, and a set of teaching
commands you run locally (`npm run index`, `npm run ask`, `npm run eval`). This
repository hosts no endpoint. The author operates a consumer of this pattern,
[Ask the Archive](https://lukefwalton.com/ask/), which carries its own copy of
it today and imports this package as the 3.0.0 line lands; a report about that
deployment is welcome at the same address below. The whole point of the repo is a **security-shaped invariant**, the
disclosure boundary, so vulnerability reports against that boundary are
exactly what's most valuable here.

The boundary: every fragment carries a disclosure policy, and the only object
a consumer may hand to a model or a caller is an `EvidenceHit` whose type
cannot hold more than that policy allows (`src/no-leak.ts` `project()` is the
one crossing; the `locator` variant has no field for text, the `semantic`
variant carries only a lint-passed gist, and `private + text` is not a member
of the policy type). Every answer either cites retrieved evidence or refuses.
A "vulnerability," for this repo, is a way to break that.

What the boundary is, and is not. It is disclosure on the served path: what a
hit, an answer, a served index, or a log line built from them can carry.
Private text does leave the operator's machine at ingest, for the embedding
provider and, only where the author asked for a gist, for the drafter; what
those providers retain is governed by their data-use terms, which the operator
chooses and checks (`docs/CONTRACT.md` §10). A report that the embedding
provider holds the text is a report about the operator's provider choice, not
about this package.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Instead:

1. Email **[luke@lukefwalton.com](mailto:luke@lukefwalton.com)** with a
   description of the issue.
2. Include the corpus shape, the query, and the boundary that broke.
3. You'll get an acknowledgement within a few days. Please allow a reasonable
   window to ship a fix before disclosing publicly.

## In scope

- **Boundary bypass:** any path along the supported, typed path that gets a
  private fragment's text into an `EvidenceHit`, a prompt, or a served index
  despite `project()` and `toServedIndex()`.
- **A gist served against policy:** a gist for a fragment whose resolved
  exposure is `locator` or `none`; a gist that quotes its source and passed
  `assertSemanticProjection`; a stale, vetoed, or unreviewed-where-review-is-required
  gist that `isServableGist` lets through.
- **Authored metadata that quotes:** a title, locator value, label, name, or
  theme on a private entity that reproduces a run of the private text and
  passes `assertPublicSafeMetadata` at load.
- **Fabricated grounding:** any path that makes the engine claim an answer is
  `supported` while citing only hints, or that leaks a private note's contents
  rather than routing to it.
- **Prompt injection** through corpus documents or the query that subverts the
  answer contract (refuse-or-cite).
- **Secret handling:** leaking the LLM API key read from `.env`, or any script
  that writes it somewhere it shouldn't.

## Not a security issue

- An answer you think is wrong but that *is* grounded in a citation, or a refusal
  you disagree with. That's eval/quality — the most useful response is a failing
  **gold case** (see [`CONTRIBUTING.md`](CONTRIBUTING.md) and
  [`eval/README.md`](eval/README.md)), not a security report.
- The lint's residue by design: a private phrase shorter than its window, a
  paraphrase, private meaning in public words, or a gist that describes more
  than its author intended. Those are owned by the exposure policy, the veto,
  review, and the canary sweep (`docs/CONTRACT.md` §13); a canary that should
  have caught one is a gold contribution.
- Inversion of a private vector by someone who already holds it. The private
  index is gitignored for that reason; a consumer that publishes vectors has
  made its own choice (see `demo/README.md` for the one deliberate exception).

## Supported versions

Fixes target the `main` branch (and the latest tagged release / archived
artifact). This is a reference implementation, not a deployed service.
