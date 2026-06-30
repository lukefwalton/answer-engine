# Security Policy

Answer Engine is a teaching-sized, locally-run example: you clone it, point it at
a corpus, and invoke CLI scripts (`npm run index`, `npm run ask`, `npm run eval`).
There is no hosted endpoint and no server to attack. But the whole point of the
repo is a **security-shaped invariant** — the no-leak boundary — so vulnerability
reports against that boundary are exactly what's most valuable here.

The boundary: private/unauthored text **cannot reach the model's prompt** along
the typed path (`src/no-leak.ts` makes the prohibited move structurally
inexpressible — a type with no field for private prose), and every answer either
cites retrieved evidence or refuses. A "vulnerability," for this repo, is a way
to break that.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Instead:

1. Email **[luke@lukefwalton.com](mailto:luke@lukefwalton.com)** with a
   description of the issue.
2. Include the corpus shape, the query, and the boundary that broke.
3. You'll get an acknowledgement within a few days. Please allow a reasonable
   window to ship a fix before disclosing publicly.

## In scope

- **Boundary bypass:** any path that gets private prose or other unauthored text
  into the prompt despite `src/no-leak.ts`.
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

## Supported versions

Fixes target the `main` branch (and the latest tagged release / archived
artifact). This is a reference implementation, not a deployed service.
