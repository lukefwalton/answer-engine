# Testing answerability, not accuracy trivia

The gold set does not test whether the model knows things. It tests whether
the *system* behaves: does the right evidence surface for questions the
archive can answer, does nothing surface for questions it can't, and does the
final answer take the honest mode for what surfaced. That property —
**answerability** — is what the two promises rest on, and it's a property of
the corpus, the retrieval scoring, and the prompt together. The model is the
least interesting part.

So a gold query never asserts a fact ("the answer is 1974"). It asserts
behavior:

```yaml
- query: What does {{author}} say about staying instead of leaving?
  expectAnswerMode: partial              # the mode the engine must return
  expectSources: [song:harbor-lights]  # what retrieval must surface
```

and, just as important, the inverse:

```yaml
- query: What does {{author}} think about cryptocurrency?
  expectAnswerMode: not-found
  forbidSources: [essay:on-listening, essay:craft-and-repetition, ...]
```

`npm run eval` checks the retrieval lines (one cheap batched embedding call);
`npm run eval -- --full` also runs the answer engine and checks modes. Either
exits non-zero on any failure, so it can gate a deploy.

## Cost model (read this first)

| Mode | API spend | When to use |
|------|-----------|-------------|
| **Default** (`npm run eval`) | One **batched embedding** call for selected queries | Always run this first |
| **`--full`** | Embeddings **+ OpenAI synthesis** per query | Only after retrieval passes, on a **subset** |

Do **not** run `npm run eval -- --full` on the whole set while fixing one
failure. That burns synthesis tokens for queries you already know pass retrieval.

```bash
npm run eval                              # full retrieval floor (cheap)
npm run eval -- --from-report latest      # failures only, still cheap
npm run eval -- --full --ids q07          # answer engine on one query ($$$)
npm run eval -- --full --from-report latest
npm run eval -- --list --ids q06,q07      # dry-run selection, no API
npm run eval -- --help                    # full flag list
```

Reports land in `artifacts/eval/<timestamp>.json` (gitignored with `artifacts/`).
Use `--from-report latest` to rerun only `"pass": false` entries. Each gold row
needs a stable `id` (e.g. `q07`) for `--ids` targeting.

## Recommended workflow

1. Change gold YAML, retrieval, or answer code.
2. `npm run eval` — full retrieval floor.
3. If anything fails: `npm run eval -- --from-report latest`.
4. Only then: `npm run eval -- --full --from-report latest` (or `--ids` for new rows).

## A query failing, then passing — the right way

The "staying instead of leaving" query above is in the shipped gold set
because it's the interesting kind: a **vocabulary mismatch**. Harbor Lights
is entirely about staying when leaving would be easier, but the lyric never
says so — it says ferries, maps, harbor lights, flags. Ask the question in
plain words and embedding similarity has very little to grab:

```
  FAIL What does Person A say about staying instead of leaving?
       - expected source 'song:harbor-lights' not retrieved
```

Three fixes are legitimate, and they're all *content or scoring* fixes:

1. **Say what the work is about, in plain language, in frontmatter.** This is
   the one we shipped. The song's `meaning` field reads "A song about staying
   put when leaving would be easier" — that line is part of the embedded text
   (`embedText` in `src/corpus.ts`), so the query now lands. The fix isn't
   clever; it's *curation*. Frontmatter is where you translate imagery into
   the words a reader would actually ask with.
2. **Add a theme.** A `themes: [staying]` entry would catch the query
   verbatim via the theme boost. Right move when one word captures it.
3. **Tune retrieval.** If many queries fail the same way, the floor or the
   boost weights are wrong, not the corpus. Change them once, for every
   question, and watch the rest of the gold set for regressions.

And one fix is forbidden, which is the entire reason this file exists:

> **Do not special-case the question.** No `if (query.includes('staying'))`,
> no per-query answer override, no regex that detects this gold entry and
> forces the mode. We did this once in the production engine — a handful of
> hardcoded patches that made specific gold queries pass. The eval went
> green; the engine stayed wrong for every phrasing we hadn't predicted, and
> a question we'd patched to refuse would have kept refusing even after the
> archive gained the answer. Deleting the patches and fixing the prompt
> passed the same queries honestly. The patches were never the engine getting
> better — they were the eval being defeated.

The asymmetry is the lesson: a corpus fix (the `meaning` line) helps every
future question about the song's subject. A query patch helps exactly one
string, and lies to you about it.

One more legitimate fix arrives only when the archive grows past what
frontmatter can reach: a fact that lives *off-site* (the page never carries
it), a *negative* fact — a question whose honest answer is "none," which pages
rarely state because they describe what is, not what isn't — or simply more
retrieval prose than a short page should show a reader. The scalable answer
there is a keyed enrichment layer: a small authored map that appends retrieval
text to a record *beside* the corpus, leaving the published page as the source
of truth. Reach for frontmatter when you own the page and one line fixes it;
reach for enrichment when the fact lives elsewhere, or you need volume the page
shouldn't carry. It is still corpus-authored content — so it still helps every
future phrasing, and the asymmetry above is exactly why it stays honest rather
than becoming a per-query patch.

## What a good gold set includes

- **Direct hits** — title queries, theme queries, plain-language queries.
  Each exercises a different retrieval signal; label which (see the `note`
  fields in `gold.yaml`).
- **Vocabulary mismatches** — questions phrased nothing like the work, like
  the walkthrough above. These are the queries that keep your frontmatter
  honest.
- **Boundary queries** — questions only the private layer bears on. The
  required mode is `related-material`: route to the moment, never restate it.
- **Refusals** — questions the archive must decline: subjects it doesn't
  cover, private personal facts, the future. Keep these when you replace the
  example queries with your own; they are the half of the eval that protects
  the second promise. The north star is the reader who trusts the engine
  *because* it declined.

When you point the engine at your own corpus, rewrite `gold.yaml` against it
(ids are `type:slug`; `{{author}}` resolves to `authorName` from
`archive.config.ts`). Add a query every time the engine surprises you —
that's the regression suite writing itself.

## What the gold set cannot catch

The set checks recall for the cases it names: a listed source must surface, a
listed refusal must fire. What it cannot own is the case no one wrote down. A
relevant source that sits below the score floor is simply absent, and a
regression suite only ever catches the omission it already thought of. That
residue is irreducible for any open-ended answer system — closing it
completely would mean knowing the answer before the question. So the honest
form of ownership here is the loop above, not a gate: author the query when an
incident reveals the gap, then fix the corpus, the scoring, or the prompt —
never the question. The suite grows toward completeness; it never certifies it.
