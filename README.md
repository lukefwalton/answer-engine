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

**What this is:** an example repo you clone and run locally (`npm install`,
`npm run …`). It is not published to npm, and it is deliberately not a
framework, hosted app, chatbot UI, or vector-database starter. It is the
smallest useful version of the answer contract: what evidence may enter the
prompt, what must stay out, how citations are grounded, and when the system
must decline.

**Example content:** everything under `example-content/` is synthetic
fiction, including the first-person notebook entries — written to show the
private-layer boundary, not real notes.

## 1. Public records are quotable; private text is not

The corpus has two layers, and the distinction drives everything downstream
(`src/corpus.ts`, `src/types.ts`):

- **Records** are published pages — each markdown file becomes a flat,
  citable record: title, canonical URL, summary, curated themes, full body.
  The body travels all the way to the model, because you already published it.
- **Private notes** are material you want *searchable but never quotable* —
  here, the songwriter's notebook in `example-content/notebook/`. Each note
  declares the public page it routes to (`about`), where the moment lives
  (`locator`), and a public-safe display name (`label`) — its `title` and
  text stay private, embedded so retrieval can find the moment but never
  shown to the model.

> In production ([Ask the Archive](https://lukefwalton.com/ask/)), published
> podcast passages are **records** — retrieved and cited — while unpublished
> transcript text is embedded for search but reaches the model only as a
> **routing hint**: where to listen, never what was said. This repo shows the
> same boundary with hand-written notebook entries instead of a transcription
> pipeline.

## 2. Retrieval returns both; assembly strips prose

Both layers share one embedding space in one versioned index file
(`artifacts/index.json` — gitignored, because vectors derived from private
text are private). Retrieval (`src/retrieve.ts`) scores everything with
brute-force cosine plus two conservative boosts: naming a work's title
(0.30) and using a curated theme verbatim (0.15) — metadata you maintain
should outrank raw similarity. Anything under a score floor is dropped. Weak
matches don't get to masquerade as evidence; an empty result is where "I
don't know" begins, before any model is involved.

The result keeps records and notes in **two separate lists**, because what
happens next is different for each:

```
                 ┌── records ────────────────────────────► quotable, citable
corpus ─► index ─┤                                         (body travels)
                 └── private notes ──► retrieval finds
                     the moment        │
                                       ▼
                              assembleEvidence()           src/no-leak.ts
                                       │  strips the text
                                       ▼
                         RoutingHint { hintId, label,
                                       url, locator }      ◄─ no field for prose
                                       │
                     AnswerEvidence = { records, hints } ──► the model
```

`src/no-leak.ts` is small enough to audit by eye: the only thing
`toRoutingHint` does is drop the note's text. `RoutingHint` has **no field
for that text**, so there is no path by which private prose can reach the
model. The boundary is the type's *shape*, not a guard somebody has to
remember to write.

## 3. The model only sees AnswerEvidence

One Responses API call (`src/answer.ts`), with the policy versioned in code
(`src/prompt.ts`). Records render with their full bodies. Hints render as
label, locator, and URL — `buildUserPrompt` couldn't leak a hint's text if it
wanted to, because the field doesn't exist. **What does travel is the label
and the locator, and both are typed `PublicSafe`:** the label comes from an
explicit `label:` frontmatter field (the private `title` never travels), and
the only way to construct the type is the build-time lint
(`assertPublicSafeField` in `src/public-safe.ts`), which rejects a traveling
field that quotes the note's own body. The lint is a tripwire, not a
classifier — a short private phrase still passes it — so write labels and
locators like captions; what the lint can and can't catch is owned in
[`NEXT-STEPS.md`](./NEXT-STEPS.md) A1.
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
(`renderRelatedMaterialAnswer` in `src/public-safe.ts`). A hint citation is
provenance without backing — the hint carries no text — so free prose there
was the one place a confabulated "summary" of private material could pass
every gate. Now the mode can point, never assert content.

One UI lesson: **retrieved is not cited**. Retrieved neighbors are
candidates; final citations are evidence. If you build a web UI around this,
render source cards from the final citation list, not from raw retrieval
hits — and render none for `not-found`, even if retrieval found nearby
material. Otherwise a refusal can look like it's backed by the very sources
the engine declined to use.

## 5. Gold queries are regression tests for answerability

`eval/gold.yaml` is a fixed set of questions with required behavior —
including questions the engine must refuse, and one that must route to the
notebook without quoting it. `npm run eval` checks retrieval (one cheap
batched embedding call); `-- --full` runs the answer engine and checks modes.
**Prefer `--ids` or `--from-report` for `--full`** — see [`eval/README.md`](./eval/README.md).

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
   safe to publish*, and declaring that per note is the point. No private
   layer? Remove `privateNotesDir` from the config and the engine runs
   public-only.
4. Replace `example-content/` with your corpus and rerun `npm run index`.
5. Rewrite `eval/gold.yaml` for your corpus — keep the refusals.

## Commands

```
npm run index       # build/refresh artifacts/index.json (only embeds changes)
npm run ask         # ask one question, get a cited answer
npm run eval        # gold set, retrieval checks (-- --full for answers; prefer --ids / --from-report)
npm test            # offline, deterministic engine tests — no API key
npm run typecheck   # tsc --noEmit
```

## Where to take it

In the order we'd add them:

- **Chunking** — split long documents into overlapping windows so retrieval
  points at passages, not whole files.
- **More retrieval signals** — recency (for "what do you think *now*"),
  author aliases, per-collection weights.
- **A document-frequency cap on the theme boost** — at four records a
  verbatim theme match is signal; on a large corpus, a theme that appears on
  half the records boosts nothing and should be discounted.
- **Evidence pruning before synthesis** — on a large corpus, wide top-k
  surfaces correlated neighbors instead of distinct sources; keep one record
  per cluster, plus a single corroborator when the winner leads by a margin.
  This shapes what synthesis *sees*, not what the gate certifies — retrieved
  is still not cited.
- **An HTTP handler** around `retrieve` + `answerQuestion`, with a rate
  limit, query cap, and cache.
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

A running deployment grows layers this engine deliberately omits:
deterministic product routes (help, usage, or corpus-count answers that never
call a model), a domain-specific eval guard taxonomy, an ingestion or
transcription pipeline, and the site's own config. Those belong to the site
layer (for "Ask the Archive," the `ask-the-archive/` adapter), not the
engine — what this repo carries is the boundary and the answer contract, not
feature parity (`.github/STANDARDS.md` §3, "What Matters Less"). One line
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

**Cutting a release:** on `main`, run **Actions → release** (patch/minor/major).
Checked-in metadata must match the latest `v*` tag on the remote (`v2.1.0`
today — the tag already exists). The workflow queues concurrent runs, bumps
semver via [`scripts/sync-release-metadata.mjs`](./scripts/sync-release-metadata.mjs),
pushes `main` and the new tag atomically, then creates the GitHub release
Zenodo archives. `CITATION.cff` and `.zenodo.json` both use the concept DOI for
citation; Zenodo assigns a version DOI per release on its own.
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
