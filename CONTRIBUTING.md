# Contributing

This repo is deliberately the smallest version of the answer contract that keeps
its promises (see [What stays out](./README.md#what-stays-out) and
[`.github/STANDARDS.md`](./.github/STANDARDS.md)). That makes it an unusual place
to contribute: **most additions are, correctly, out of scope.** A caching layer,
a nicer CLI, a vector-store adapter, an ingestion pipeline — all reasonable, all
declined here, not because the work is poor but because the value this repo
carries is the boundary and the answer contract, not feature coverage. If a
change makes the engine bigger without making a promise more checkable, it
belongs in a consumer adapter, not here.

So this file names the surface where contribution *is* in scope — the one
boundary the repo otherwise leaves implicit.

## The most valuable contribution: a gold case that broke

The best PR is a failing gold case. Point the engine at your own corpus, find a
question it answers when it should decline, or one that should route to a private
note and instead leaks, restates, or refuses — and contribute it as a gold entry
with the behavior it *should* have had. That is pure signal: it is the
"grown from incident" discipline the eval is built on, and it strengthens exactly
what the repo is about.

The rule that comes with it — the same one the repo holds itself to — is that
when a query fails, the fix goes into the corpus, the scoring, or the prompt,
**never** into a special case for that question. A PR that makes the eval pass by
special-casing the question will be declined even when it is green. See
[`eval/README.md`](./eval/README.md).

## Also in scope

- **A port that keeps the boundary structural.** The no-leak boundary here is a
  type with no field for private prose, so the prohibited move is structurally
  inexpressible — a property of the type's *shape*, not a checker that complains
  (`src/no-leak.ts`). A port to another language is a real contribution if it
  keeps that boundary structural rather than a guard someone has to remember, and
  it stress-tests whether the pattern is language-independent or secretly
  TypeScript-shaped. A port that demotes the boundary to a runtime check is not
  the same artifact.
- **Adversarial cases against the boundary.** Try to get private prose into the
  prompt, or to make the model claim `supported` while citing only hints. Either
  it breaks — we fix it, and the suite grows — or it holds, and the boundary
  earns more credibility. Both outcomes are useful; the second most of all.

## Forking is a contribution too

PRs improve this reference implementation. But the harder questions — skewed
corpora, public scale, contested frames — are not answered by PRs to a teaching
repo; they are answered by people building their *own* bounded systems with this
pattern and reporting what bent. **A fork that reports its own gold failures is
as valuable as a PR here.** If you take the pattern somewhere this corpus will
never go and tell us where it held and where it did not, that is the
contribution the author most wants to learn from. Open an issue or a discussion.

## The bar

For any code that does land, the bar is the one the repo sets for itself: least
lines that keep the promises, boundaries enforced by types or runtime checks,
loud failures, and no change that makes the eval pass by special-casing a
question. [`.github/STANDARDS.md`](./.github/STANDARDS.md) is the full rubric a
PR is read against.

Always, before any PR — both are offline and need no API key:

```sh
npm test          # offline, deterministic engine tests — the CI gate
npm run typecheck # tsc --noEmit
```

`npm test` must stay green **without an API key**; don't add hidden dependencies
on live calls.

If your change touches the prompt, retrieval, validation, or repair, run the
eval too (it needs a key — one cheap embedding call per query):

```sh
npm run eval                          # retrieval checks against eval/gold.yaml
npm run eval -- --from-report latest  # rerun just the failures
```

The full answer-engine eval (`npm run eval -- --full`) is **manual and
pre-merge, not a CI requirement**; run it on `--ids` or `--from-report` subsets
while iterating, never the whole gold set on every pass (see
[`eval/README.md`](./eval/README.md)).

## Practical notes

- **Discuss large changes first.** For anything beyond a gold case or a small
  fix, open an issue before writing code, so a "this is out of scope" can land
  before your weekend does rather than after it.
- **Standards.** [`.github/STANDARDS.md`](./.github/STANDARDS.md) is the rubric
  every PR is read against — the rejection criteria made explicit, on purpose.
- **Review.** PRs are reviewed with
  [Surmado Code Review](https://www.surmado.com/review) alongside human judgment.
- **License.** Contributions are accepted under the repo's
  [Apache-2.0](./LICENSE) license; by opening a PR you agree your contribution is
  licensed under it.
- **Conduct.** Issues and PRs are governed by the
  [Code of Conduct](./CODE_OF_CONDUCT.md).
- **Security.** Found a way past the no-leak boundary, or a leaked key? Report it
  privately — see [SECURITY.md](./SECURITY.md), not a public issue.
