# Answer Engine: An AI that Says "I Don't Know"

[![Tests](https://github.com/lukefwalton/answer-engine/actions/workflows/test.yml/badge.svg)](https://github.com/lukefwalton/answer-engine/actions/workflows/test.yml)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20676773.svg)](https://doi.org/10.5281/zenodo.20676773)
[![License](https://img.shields.io/github/license/lukefwalton/answer-engine)](LICENSE)
[![Release](https://img.shields.io/github/v/release/lukefwalton/answer-engine)](https://github.com/lukefwalton/answer-engine/releases)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/lukefwalton/answer-engine)

A small answer engine for a body of work you own. It answers only from your
published sources, keeps your private text out of the prompt, cites what it
uses, and says "I don't know" when it should — and each of those promises is
tested.

It uses an LLM **without being a chatbot**. Point it at essays, lyrics,
letters, documentation, and it answers one question at a time: no
conversation state, no memory, no persona improvising on your behalf.
Question in, cited answer or honest refusal out. A chatbot that's right most
of the time speaks *for* you; an answer engine that cites or declines speaks
*from* you.

This repo is the teaching-sized version of the engine behind "Ask the
Archive" on [lukefwalton.com](https://lukefwalton.com). It runs out of the
box on a bundled example corpus (by "Person A" — a placeholder, not a
person), it's small enough to read in one sitting, and the whole design is
five ideas, laid out below in the order the data flows.

**What this is:** the reference implementation of the archive contract
([`docs/CONTRACT.md`](./docs/CONTRACT.md)), in two forms. Clone it and run the
teaching commands (`npm install`, `npm run …`) on the bundled example corpus;
or, from 3.0.0, import it (`@lukefwalton/answer-engine`) as the substrate
under your own consumer: a question-answering product, or a retrieval-only
endpoint whose caller brings its own model. It is deliberately not a
framework, hosted app, chatbot UI, or vector-database starter. It is the
smallest useful version of the answer contract: what may travel from each
piece of an archive, what must stay behind, how citations are grounded, and
when the system must decline.

**Example content:** everything under `example-content/` is synthetic
fiction, including the first-person notebook entries — written to show the
private-layer boundary, not real notes.

## 1. Every fragment carries a disclosure policy

The corpus is **entities** (a page, a song, a book, an episode) and
**fragments**, the retrievable pieces of one (a whole page, a chapter, a window
of a transcript). Each entity declares two things (`src/contract.ts`,
[`docs/CONTRACT.md`](./docs/CONTRACT.md) §3): which **layer** its text is in,
`raw: public | private`, and how much of a fragment may **travel**,
`exposure: text | semantic | locator | none`. The cell `private + text` has no
member in the type, so it cannot be written down.

- **Public text** travels whole: title, canonical URL, summary, curated
  themes, full body. You already published it.
- **Private material** is searchable but never quotable. A fragment may travel
  as a **locator** (where the moment is: "notebook, p. 12", "12:30–14:05"), as
  a **gist** (`semantic`: a one-paragraph description the system drafts at
  build and the author authorizes, linted so it cannot quote), or not at all
  (`none`: indexed, never served).

In the bundled example, the essays and lyrics are public and the songwriter's
notebook in `example-content/notebook/` is the private layer. Each note
declares the public page it routes to (`about`), where the moment lives
(`locator`), a linted display name (`label`), and, optionally, the `exposure`
it wants; its `title` and body stay private, embedded so retrieval can find the
moment. The teaching adapters (`src/adapters/teaching.ts`) turn those files
into entities and fragments; a consumer writes its own.

> In production ([Ask the Archive](https://lukefwalton.com/ask/)), published
> podcast passages are public fragments while unpublished transcript text is
> private: embedded for search, served as where to listen, never what was
> said. The same contract covers a book the archive holds but may not quote:
> each chapter travels as a gist its author released.

## 2. Retrieval returns hits; `project()` is the one crossing

Both layers share one embedding space in one versioned index
(`artifacts/index.json`, schema 4 — gitignored, because vectors derived from
private text are private). Retrieval (`src/retrieve.ts`) applies filters first
(type, date, creator, speaker, exposure, layer), scores every fragment by
brute-force cosine, adds boosts through a plugin seam (`src/boosts.ts`: an
exact title match, a curated theme, recency, disclosure; the default set is
the two conservative 2.x boosts, 0.30 and 0.15, on public fragments), drops
anything under a score floor, and caps per layer. Weak matches don't get to
masquerade as evidence; an empty result is where "I don't know" begins, before
any model is involved.

Retrieval returns `ScoredHit`s, which hold the fragment and never leave the
process. `project()` in `src/no-leak.ts` is the one place a hit crosses toward
anything a model or a caller may see, and `search()` is `retrieve().map(project)`:

```
corpus ─► ingest ─► index ─► retrieve() ─► ScoredHit[] ─► project() ─► EvidenceHit[]
                                                                             │
  exposure: text     ──► { text, summary, provenance }                       ├─► constrained synthesis: cite or refuse
  exposure: semantic ──► { gist (lint-passed), provenance }                  │   (src/answer.ts, src/prompt.ts, npm run ask)
  exposure: locator  ──► { provenance only }                                 └─► retrieval only: the caller's model thinks
  exposure: none     ──► never served                                            (a consumer's HTTP or MCP endpoint)
```

`EvidenceHit` is a union on `exposure`: the `locator` variant has **no field
for text**, the `semantic` variant carries only a gist the lint passed, and
`text` is unreachable for a private fragment because the policy type has no
such cell. Every variant carries provenance (creators, date, version, URL,
identifiers, a locator and its rendered label), and a private hit's score is
rounded with no breakdown. The short authored strings a hit does carry (a
title, a locator label, a name) are not typed; they are linted against the
private text at build and again at every load of a private index
(`assertPublicSafeMetadata` in `src/public-safe.ts`). The bound on the whole
claim is stated in [`docs/CONTRACT.md`](./docs/CONTRACT.md) §4.

## 3. The model only sees AnswerEvidence

One Responses API call (`src/answer.ts`), with the policy versioned in code
(`src/prompt.ts`). `toAnswerEvidence` (`src/evidence.ts`) turns hits into what
the in-package consumer may show the model: `text` hits render with their full
bodies; `semantic` and `locator` hits become hints (label, locator, URL), and
`RoutingHint` has **no field for text or for a gist**, so `buildUserPrompt`
couldn't leak either if it wanted to. A gist travels beside the hints, not in
them, and only the related-material template renders it, after the mode is
final: the model never holds a description of private material it could
restate. The lint behind the label, the locator, and the gist is a tripwire,
not a classifier — a short private phrase still passes it — so write labels
and locators like captions; what the lint can and can't catch is owned in
[`NEXT-STEPS.md`](./NEXT-STEPS.md) A1 and [`docs/CONTRACT.md`](./docs/CONTRACT.md) §13.
The model is told what a hint *is*: the location of a relevant private
moment, to be routed to, never restated. And if nothing cleared the score
floor, the engine returns `not-found` without making the call at all —
refusal costs nothing.

## 4. Modes are enforced in schema + validator, not vibes

The answer declares one of four modes, and the modes exactly partition the
citation mix — which makes honesty checkable:

| Mode | Citations | Meaning |
| --- | --- | --- |
| `supported` | records + hints | claims grounded in the canon, plus where to look further |
| `partial` | records only | answered from the canon; no private moment bears on it |
| `related-material` | hints only | "I can't quote it, but the moment exists — here" |
| `not-found` | none, empty answer | "I don't know," plainly |

Three layers enforce this, because the first two are requests and only the
third is a guarantee. The JSON schema constrains the shape. `validateAnswer`
rejects contract violations — a `not-found` with prose, a sourced mode
without sources. Then `repairCitationsToEvidence` snaps almost-right
citations onto the exact retrieved pairs (models mangle URLs more often than
they invent sources), dedupes, and **re-derives the mode from the final
mix** — the model can't claim `supported` while citing nothing but hints.
Finally, `assertCitationsGroundedInEvidence` verifies every citation is the
exact (id, url) pair of something actually retrieved. An invented source is
an error, not a footnote.

One mode gets a fourth layer. A `related-material` answer's prose is not the
model's: after grounding, the engine replaces it with a fixed sentence
rendered from the cited hints' label and locator
(`renderRelatedMaterialAnswer` in `src/public-safe.ts`), followed, for a hint
whose fragment is exposed as `semantic`, by the gist the author authorized,
marked as a description and not a quotation. A hint citation is provenance
without backing — the hint carries no text — so free prose there was the one
place a confabulated "summary" of private material could pass every gate. Now
the mode can point, and say only what the author released.

One UI lesson: **retrieved is not cited**. Retrieved neighbors are
candidates; final citations are evidence. If you build a web UI around this,
render source cards from the final citation list, not from raw retrieval
hits — and render none for `not-found`, even if retrieval found nearby
material. Otherwise a refusal can look like it's backed by the very sources
the engine declined to use.

## 5. Gold queries are regression tests for answerability

`eval/gold.yaml` is a fixed set of questions with required behavior —
including questions the engine must refuse, and one that must route to the
notebook without quoting it — plus a `canaries` list: private wording that
must never appear in output. `npm run eval` sweeps the canaries over every
gist the index would serve (keyless, before any API call), then checks
retrieval (one cheap batched embedding call); `-- --full` runs the answer
engine and checks modes. **Prefer `--ids` or `--from-report` for `--full`** —
see [`eval/README.md`](./eval/README.md). An exposure change on an entity is
gated like a scoring change: by the suite, never by intuition.

The rule that makes the eval worth having: **when a query fails, fix the
corpus, the scoring, or the prompt — never special-case the question.** We
learned that the hard way; [`eval/README.md`](./eval/README.md) tells the
story, including a real failing-then-passing walkthrough.

## What this shows, and where it stops

The fair objection: this works because the frame is easy to own — one
archive, one named author, a bounded corpus. The mechanisms don't depend on
that smallness (none of them refers to corpus size), but a small demo can't
prove that holding these boundaries stays affordable at public, plural, or
contested scale. This repo is the bounded case on purpose, not a proof about
the unbounded one.

The limit is narrower than it looks, though. What the engine guarantees is
**soundness**: nothing enters an answer that isn't grounded in retrieved
evidence or honestly refused. What it can't guarantee is **completeness**: a
source that falls below the score floor is simply absent, and a gate only
sees what reaches it. That absence still has owners — the scoring, the
floor, and the corpus boundary are constants someone maintains
(`src/retrieve.ts`, `archive.config.ts`), and the gold set tests recall for
the cases it names (`eval/gold.yaml`). What remains out of reach, for any
system, is the relevant source no one thought to test for.

What the repo does show is concrete: whether a frame is *held* or merely
*inherited* can be settled in running code, not in promissory labels. The
privacy boundary is structural (`src/no-leak.ts`); modes are re-derived from
the evidence, not taken on the model's word (`src/answer.ts`); refusals are
regression-tested like any other behavior (`eval/gold.yaml`).

The [Answerability papers](#related-writing) take up the harder cases —
plural authorship, contested frames, systems where *whose* gate applies is
itself unsettled. This repo is the bounded reference implementation, and
issues and PRs that extend, test, or push against those limits are welcome:
see [`CONTRIBUTING.md`](./CONTRIBUTING.md) for what's in scope (a failing
gold case is the best PR). The bar for new code is the bar the repo sets for
itself: the fewest lines that keep the promises, boundaries enforced by types
or runtime checks, loud failures, and no eval pass by special-casing a
question.

---

## Quick start

Requires Node.js 22+ and an OpenAI API key.

```sh
npm install
cp .env.example .env              # add your OPENAI_API_KEY in an editor

npm run index                                   # embed the example corpus, both layers
npm run ask -- "what does person a think about routine?"      # → partial, cites the essay
npm run ask -- "how was the bridge in harbor lights written?" # → related-material, routes to the notebook
npm run ask -- "what does person a think about crypto?"       # → I don't know.
npm run eval                                    # the promises, checked (retrieval)
npm run eval -- --from-report latest            # rerun failures only (cheap)
npm run eval -- --full --ids q07                # answer engine on one query
```

The default models are in `archive.config.ts` (`text-embedding-3-large` +
`gpt-4o-mini`). Change `answerModel` to any Responses-API model your key
supports — the engine adapts (reasoning models get an effort setting, others
get `temperature: 0`).

## Make it yours

1. Edit `archive.config.ts`: your name, your archive's name, your base URL,
   where your markdown lives.
2. Each collection is a directory of `.md`/`.mdx` files. The filename stem is
   the slug — it becomes part of the record id and the public URL, so name
   files the way you want your citations to read. Frontmatter the engine
   reads: `title` (required), `description`/`summary`/`meaning`,
   `themes`/`keywords`/`topics`, `date`, `draft: true` to skip a file.
3. Private notes additionally need `about` (the public URL to route to),
   `locator` (where the moment lives), and `label` — the display name that
   travels into hints and answers. The `title` and body stay private (they
   are embedded for search, never shown to the model); the `label` and
   `locator` ARE public surface, so write them like captions, not like the
   note itself. A build-time lint rejects a label or locator that quotes the
   note's body — repeating the title as the label is fine *when the title is
   safe to publish*, and declaring that per note is the point. A note may also
   set `exposure: semantic` to have `npm run index` draft a one-paragraph gist
   of it that you then authorize, edit, or veto in `artifacts/projections.json`
   (the gist is what travels; the text never does), or `exposure: none` to
   index it without ever serving it — see `docs/CONTRACT.md` §3 and §5. No
   private layer? Remove `privateNotesDir` from the config and the engine runs
   public-only.
4. Replace `example-content/` with your corpus and rerun `npm run index`.
5. Rewrite `eval/gold.yaml` for your corpus — keep the refusals.

## Commands

```
npm run index          # build/refresh artifacts/index.json and artifacts/projections.json (embeds and drafts only what changed)
npm run migrate:index  # schema 3 → 4 for an index file, in place, keyless
npm run ask            # ask one question, get a cited answer
npm run eval           # canary sweep (keyless), then the gold set's retrieval checks (-- --full for answers; prefer --ids / --from-report)
npm run build          # compile the package to dist/ (what npm publish ships)
npm run test:dist      # build, then import the package by name and smoke it
npm test               # offline, deterministic engine tests — no API key
npm run typecheck      # tsc --noEmit
```

## Where to take it

[`docs/CONTRACT.md`](./docs/CONTRACT.md) is the design of record for 3.0.0, and
this package is its reference implementation: the contract types, the
crossing, the lints, policy resolution, fragmenters, the gist drafter and the
author's projections file, retrieval with plugin seams, the private and served
index artifacts, and the eval harness with its canary sweep. What a consumer
adds, in the order we'd add it:

- **Your corpus as entities and fragments** — an adapter from your shapes
  (`fromArchiveRecord` and `fromPrivateNote` are the teaching ones);
  `fragmentByHeadings` and `fragmentByPageMarkers` split a long document so
  retrieval points at passages, not whole files, with locators that are
  structural (a chapter number, a page) rather than authored prose.
- **Your boosts as plugins** — author aliases, guest speech, distinctive query
  n-grams, a cap on hub pages. `BoostPlugin` and `PostRank` are the seams;
  `ALL_BUILTIN_PLUGINS` is the full built-in set (recency for "what do you
  think *now*", disclosure, the theme boost with its document-frequency cap).
- **Evidence pruning before synthesis** — on a large corpus, wide top-k
  surfaces correlated neighbors instead of distinct sources; keep one fragment
  per entity, plus a single corroborator when the winner leads by a margin.
  This shapes what synthesis *sees*, not what the gate certifies — retrieved
  is still not cited.
- **An HTTP handler** around `search()`, with a rate limit (load-bearing for
  confidentiality: coarse scores bound what one query reveals, the limiter
  bounds how many queries), a query cap, and a cache; a stateless MCP tool
  over the same handler. The wire shape is `SearchResponse` in
  `src/contract.ts`.
- **SQLite or pgvector** when the archive outgrows in-memory cosine — the
  shapes don't change.

In production we also keep the wire contract's `not-found` empty and let the
UI supply plain decline copy at display time, so refusals stay honest *and*
human.

Code the invariant. Document the scaling pattern. Comment the footgun.

The empirical companion to this list — plus two levers it doesn't name
(vector dimension and wire format), which only matter once the index crosses
a network boundary — is in
[`docs/production-scaling.md`](./docs/production-scaling.md).

## Next steps / open problems

[`NEXT-STEPS.md`](./NEXT-STEPS.md) is the standing record of the seams we
can see — places where the design leaves something to be *owned* rather than
structurally guaranteed — and the levers an adopter might pull to trade
quality for cost. It is not a roadmap: nothing in it has to be fixed for the
engine to keep its promises. Each entry is written to be pulled as a ticket.

## What stays out

A running deployment grows layers this engine deliberately omits: an HTTP
layer and the MCP transport, deterministic product routes (help, usage, or
corpus-count answers that never call a model), a domain-specific eval guard
taxonomy, a transcription pipeline, site-specific boosts, and the site's own
config. Those belong to the consumer (for "Ask the Archive," the
`ask-the-archive/` adapter), not the engine — what this repo carries is the
contract, the boundary, and the eval harness, not feature parity
(`.github/STANDARDS.md` §3, "What Matters Less"; `docs/CONTRACT.md` §15). One line
worth holding if you add a deterministic route downstream: it may shortcut
*delivery*, but it must never be how a gold query passes. A route that flips
an eval outcome is special-casing the question wearing a hat — the same thing
§5 forbids, one layer up.

## Citing this software

If you use or build on this repo, please cite the Zenodo archive (not just
the GitHub URL).

- **[`.zenodo.json`](./.zenodo.json)** — metadata for Zenodo's GitHub archive
  (title, ORCID, related paper DOIs, documentation links). Commit this before
  each tag; Zenodo reads it from the release snapshot and ignores
  `CITATION.cff` when it is present.
- **[`CITATION.cff`](./CITATION.cff)** — GitHub **Cite this repository** UI
  only.

**Recommended:** cite the [concept DOI](https://doi.org/10.5281/zenodo.20676773)
— it represents all versions and always resolves to the latest archived release.

| | |
| --- | --- |
| DOI | [10.5281/zenodo.20676773](https://doi.org/10.5281/zenodo.20676773) |
| Code | [github.com/lukefwalton/answer-engine](https://github.com/lukefwalton/answer-engine) |
| About | [lukefwalton.com/ask/about/](https://lukefwalton.com/ask/about/) |

**Artifact note:** cite [10.5281/zenodo.20710897](https://doi.org/10.5281/zenodo.20710897)
for v1.2 of the formal write-up ([`docs/ARTIFACT-NOTE-v1.2.md`](./docs/ARTIFACT-NOTE-v1.2.md)).
Its concept DOI, [10.5281/zenodo.20686053](https://doi.org/10.5281/zenodo.20686053),
is separate from the software archive above and resolves to the latest version.

To pin a specific archived snapshot, pick that release's version DOI on the
[Zenodo versions page](https://zenodo.org/records/20676773) — no README update
required when a new release lands.

**Cutting a release:** on `main`, run **Actions → release**
(patch/minor/major, or `premajor` to start a pre-release line such as
`3.0.0-alpha.1` and `prerelease` to continue it; patch/minor/major on a
pre-release finalize it — [`scripts/next-version.mjs`](./scripts/next-version.mjs)).
Checked-in metadata must match the latest `v*` tag on the remote (`v2.1.0`
today — the tag already exists). The workflow queues concurrent runs, builds
and smoke-imports the package, bumps semver via
[`scripts/sync-release-metadata.mjs`](./scripts/sync-release-metadata.mjs),
pushes `main` and the new tag atomically, creates the GitHub release Zenodo
archives (pre-releases are marked as such), then publishes
`@lukefwalton/answer-engine` to npm with provenance (pre-releases under the
`next` dist-tag). Publishing authenticates through npm trusted publishing or an
`NPM_TOKEN` secret; the workflow file says how to set up either. `CITATION.cff`
and `.zenodo.json` both use the concept DOI for citation; Zenodo assigns a
version DOI per release on its own.
If the workflow pushes refs but GitHub release creation fails, create the release
manually from the existing tag in the GitHub UI — **do not re-run** this workflow:
a rerun would bump semver again (e.g. skip `v1.4.0` and cut `v1.4.1`) because
the latest tag already advanced.

```bibtex
@software{walton_answer_engine_2026,
  author       = {Walton, Luke F.},
  title        = {Answer Engine: An AI that Says "I Don't Know"},
  year         = {2026},
  publisher    = {Zenodo},
  doi          = {10.5281/zenodo.20676773},
  url          = {https://github.com/lukefwalton/answer-engine}
}
```

## Related writing

Formal description of this implementation:
[`docs/ARTIFACT-NOTE-v1.2.md`](./docs/ARTIFACT-NOTE-v1.2.md) —
[DOI](https://doi.org/10.5281/zenodo.20710897) (CC BY-NC-ND 4.0).

This repo is a practical companion to the Answerability papers:

- [The Decision No One Authored](https://lukefwalton.com/writing/the-decision-no-one-authored/) — [DOI](https://doi.org/10.5281/zenodo.20622946)
- [The Captured Oracle](https://lukefwalton.com/writing/the-captured-oracle/) — [DOI](https://doi.org/10.5281/zenodo.20676328)
- [The Invariant of Answerability](https://lukefwalton.com/writing/the-invariant-of-answerability/) — [DOI](https://doi.org/10.5281/zenodo.20606493)
- [Building Answerable AI: Why Automation Needs Owned Error](https://lukefwalton.com/writing/building-answerable-ai/) — [DOI](https://doi.org/10.5281/zenodo.20682307)

## Licenses

| Work | License |
| --- | --- |
| [Artifact note](./docs/ARTIFACT-NOTE-v1.2.md) | [CC BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/) |
| Answerability papers | [CC BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/) |
| answer-engine (this software) | [Apache-2.0](./LICENSE) |

## Contact

Archived on Zenodo: [10.5281/zenodo.20676773](https://doi.org/10.5281/zenodo.20676773).

Built by [Luke F. Walton](https://lukefwalton.com) — contact
[luke@lukefwalton.com](mailto:luke@lukefwalton.com).

Provided as-is for personal use; no support, warranty, or maintenance is
implied. It is a personal project, not written on behalf of any employer.

PRs on this repo are reviewed with
[Surmado Code Review](https://www.surmado.com/review). Luke F. Walton is
Surmado’s founder; this is a personal open-source project, not a Surmado product.
