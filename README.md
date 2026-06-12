# Answer Engine: An AI that Says "I Don't Know"

A small answer engine that keeps the authorial frame outside the model:
sources are bounded, private text cannot leak into the prompt, citations are
grounded, and refusals are tested.

This is site-level search that uses an LLM **without being a chatbot**. You
point it at a body of work — essays, lyrics, letters, philosophy,
documentation — and it answers one question at a time, with no conversation
state, no memory, no persona improvising on your behalf. Each answer is a
one-shot transaction: question in, cited answer or honest refusal out. A
chatbot that's right most of the time speaks *for* you; an answer engine that
cites or declines speaks *from* you.

This repo is the teaching-sized version of the engine behind "Ask the
Archive" on [lukefwalton.com](https://lukefwalton.com). It runs out of the
box on a bundled example corpus (by "Person A" — a placeholder, not a
person), it's small enough to read in one sitting, and the whole design is
five ideas. Here they are, in the order the data flows.

**What this is:** a **GitHub example repo** you clone and run locally (`npm
install`, `npm run …`). It is not published to npm — there is no `bin`,
`main`, or `exports`; you read the source and invoke the CLI scripts, not
`npm install answer-engine` as a dependency.

**Example content:** everything under `example-content/` is synthetic fiction
for the demo, including the first-person notebook entries — written to show
the private-layer boundary, not real notes.

## 1. Public records are quotable; private text is not

The corpus has two layers, and the distinction drives everything downstream
(`src/corpus.ts`, `src/types.ts`):

- **Records** are published pages — each markdown file becomes a flat,
  citable record: title, canonical URL, summary, curated themes, full body.
  The body travels all the way to the model, because you already published it.
- **Private notes** are material you want *searchable but never quotable* —
  here, the songwriter's notebook in `example-content/notebook/`. Each note
  declares the public page it routes to (`about`) and where the moment lives
  (`locator`). Its text gets embedded, so retrieval can find it. It is never
  shown to the model.

> In production, the private layer is chunked podcast transcripts — hours of
> guests' words that routing can point into but the engine must never quote.
> This repo uses hand-written notebook entries to show the same boundary
> without the transcription pipeline.

## 2. Retrieval returns both; assembly strips prose

Both layers share one embedding space in one versioned index file
(`artifacts/index.json` — gitignored, because vectors derived from private
text are private). Retrieval (`src/retrieve.ts`) scores everything with
brute-force cosine plus two conservative boosts — naming a work's title
(0.30) and using a curated theme verbatim (0.15), because metadata you
maintain should outrank raw similarity — and drops anything under a score
floor. Weak matches don't get to masquerade as evidence; an empty result is
where "I don't know" begins, before any model is involved.

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

`src/no-leak.ts` is eight lines of logic and it is the whole point:
`RoutingHint` has **no field for the note's text**, so code that tried to
hand private prose to the model would not compile. The boundary is a type,
not a guard somebody remembers to write.

## 3. The model only sees AnswerEvidence

One Responses API call (`src/answer.ts`), with the policy versioned in code
(`src/prompt.ts`): records render with their bodies; hints render as label,
locator, and URL — `buildUserPrompt` couldn't leak a hint's text if it wanted
to, because the field doesn't exist. The model is told what a hint *is*: the
location of a relevant private moment, to be routed to, never restated. If no
evidence cleared the floor at all, the engine returns `not-found` without
making the call — refusal costs nothing.

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
third is a guarantee: the JSON schema constrains the shape; `validateAnswer`
rejects contract violations (a `not-found` with prose, a sourced mode without
it); then `repairCitationsToEvidence` snaps almost-right citations onto the
exact retrieved pairs (models mangle URLs more often than they invent
sources), dedupes, and **re-derives the mode from the final mix** — the model
can't claim `supported` while citing nothing but hints. Finally
`assertCitationsGroundedInEvidence` verifies every citation is the exact
(id, url) pair of something actually retrieved. An invented source is an
error, not a footnote.

## 5. Gold queries are regression tests for answerability

`eval/gold.yaml` is a fixed set of questions with required behavior —
including questions the engine must refuse, and one that must route to the
notebook without quoting it. `npm run eval` checks retrieval (one cheap
batched embedding call); `-- --full` runs the answer engine and checks modes.

The rule that makes the eval worth having: **when a query fails, fix the
corpus, the scoring, or the prompt — never special-case the question.** We
learned that the hard way; [`eval/README.md`](./eval/README.md) tells the
story, including a real failing-then-passing walkthrough.

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
npm run eval                                    # the promises, checked
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
3. Private notes additionally need `about` (the public URL to route to) and
   `locator` (where the moment lives). One contract to respect: a note's
   `title` and `locator` ARE public-safe surface — they travel into hints and
   answers — so write them like captions, not like the note itself. Only the
   body is private. No private layer? Remove `privateNotesDir` from the
   config and the engine runs public-only.
4. Replace `example-content/` with your corpus and rerun `npm run index`.
5. Rewrite `eval/gold.yaml` for your corpus — keep the refusals.

## Commands

```
npm run index       # build/refresh artifacts/index.json (only embeds changes)
npm run ask         # ask one question, get a cited answer
npm run eval        # gold set, retrieval checks (-- --full to check answers too)
npm test            # offline, deterministic engine tests — no API key
npm run typecheck   # tsc --noEmit
```

## Where to take it

In the order we'd add them: chunk long documents into overlapping windows so
retrieval points at passages; more retrieval signals (recency for "what do
you think *now*", author aliases, per-collection weights); a
document-frequency cap on the theme boost — at four records a verbatim theme
match is signal, but on a large corpus a theme that appears on half the
records boosts nothing and should be discounted; an HTTP handler
around `retrieve` + `answerQuestion` with a rate limit, query cap, and cache;
SQLite or pgvector when the archive outgrows in-memory cosine — the shapes
don't change. In production we also keep the wire contract's `not-found`
empty and let the UI roll plain decline copy at display time, so refusals
stay honest *and* human.

Contributions welcome — the bar for new code is the bar the repo sets for
itself: least lines that keep the promises, boundaries enforced by types or
runtime checks, loud failures, and no change that makes the eval pass by
special-casing a question.

That is the design principle: **answerability**. The model may write the
sentence, but the system owns the frame it must satisfy. Evidence boundaries,
citation validation, refusal modes, and evals stay outside the model so the answer can be checked rather than merely trusted.

## License & contact

Apache-2.0. Built by [Luke F. Walton](https://lukefwalton.com) —
contact [luke@lukefwalton.com](mailto:luke@lukefwalton.com).

Provided as-is for personal use; no support, warranty, or maintenance is
implied. It is a personal project, not written on behalf of any employer.
