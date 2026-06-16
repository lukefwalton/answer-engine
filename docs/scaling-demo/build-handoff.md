# Build handoff — populate the scaling corpus and generate the vectors

This is an executable brief for an agent (or person) running in an environment **with network access to the public-domain sources and an `OPENAI_API_KEY`**. The session that built `scaling/` had neither: this repo's egress allowed only GitHub, and `api.openai.com` plus Gutenberg / archive.org were all blocked, so the code, structure, gold set, provenance manifest, and deterministic harness tests are authored and committed, but the real text bodies and the committed embedding vectors are not. This brief produces them.

Read the spec (`docs/scaling-demo/SCALING-DEMO-spec.md`), the corpus manifest (`scaling/corpus/README.md`), and the delta log (`docs/scaling-demo/scaling-demo-delta-log.md`) first. The frame governs: verify against the live source not against this doc, prefer the smaller change, and **never fabricate words for the real Adam Smith or the real George Adam Smith** — the only authored text is the quarantined synthetic spire.

## 0. Prerequisites

- `OPENAI_API_KEY` set (in `.env` or the environment). The build embeds with `text-embedding-3-large` at native dimensionality; nothing else will satisfy the homogeneity invariant (`src/store.ts`).
- Network egress to Project Gutenberg and the Internet Archive (and Wikipedia/Wikisource for the real route-target URLs).
- A clean offline baseline first: `npm test` and `npm run typecheck` green (they are, with the fixture tests; do not regress them).

## 1. Create the corpus files

One markdown file per **short whole unit** (a single prophet exposition, one chapter, one sermon). **Never a whole volume as one file** — a whole volume as one embedding dilutes its topical center (`NEXT-STEPS.md` B3) and washes out the near-ties the demo needs. Watch sermon length specifically: if a sermon is long enough that it would have to be split into windows to retrieve well, that is the **highest-stakes delta** (the demo would then chunk, and "in-memory and unchunked" breaks — log it in delta-log row 4 before doing it).

Slugs are the filename stems and must match `scaling/gold.yaml` exactly. Titles **carry the author's full name on purpose**: that is what makes the partial-name boost edge live (a query naming "Adam Smith" phrase-matches a title containing "George Adam Smith"). Author `themes` honestly from the actual text, **including where they collide** (both Smiths on "justice"); do not curate themes to make disambiguation easy.

### Public ledger — Adam Smith (economist), dir `scaling/corpus/public/adam-smith/`

Record frontmatter: `title` (required, lead with "Adam Smith — "), `summary` (or `description`/`meaning`), `themes`. Body: the real unit text, lightly cleaned.

| slug (filename) | unit to extract | suggested themes (verify against text) |
|---|---|---|
| `theory-of-moral-sentiments-justice` | _Theory of Moral Sentiments_, the section on justice and beneficence | justice, morality, society |
| `theory-of-moral-sentiments-sympathy` | _Theory of Moral Sentiments_, the opening on sympathy | sympathy, morality, the passions |
| `wealth-of-nations-division-of-labour` | _Wealth of Nations_, Bk I ch. 1 (division of labour) | labour, economy, society |
| `wealth-of-nations-value` | _Wealth of Nations_, Bk I on value / price | value, money, economy |

### Public ledger — George Adam Smith (theologian), dir `scaling/corpus/public/george-adam-smith/`

Same frontmatter shape; lead titles with "George Adam Smith — ".

| slug (filename) | unit to extract | suggested themes (verify against text) |
|---|---|---|
| `twelve-prophets-amos` | _The Book of the Twelve Prophets_, the Amos exposition | justice, prophecy, righteousness |
| `twelve-prophets-hosea` | _The Book of the Twelve Prophets_, the Hosea exposition | love, mercy, prophecy |
| `twelve-prophets-micah` | _The Book of the Twelve Prophets_, the Micah exposition | justice, judgment, prophecy |
| `isaiah-prophet-of-faith` | _The Book of Isaiah_, one chapter exposition | faith, prophecy, judgment |

Note the deliberate theme collision: Amos and Micah carry "justice," which Adam Smith's _Theory of Moral Sentiments_ also carries. That collision is wanted; the gold suite exposes where the theme boost mis-fires.

### Private ledger — George sermons, dir `scaling/corpus/private/`

These are **real George minor works**, designated private (a layer assignment, not secrecy). Note frontmatter: `title` (the label that travels — keep it public-safe), `about` (a **real** public George page to route to, e.g. the work's Wikisource/IA page or `https://en.wikipedia.org/wiki/George_Adam_Smith`), `locator` (where the moment lives, e.g. "Forgiveness of Sins (1905), sermon II"). Body: the real sermon text. The id is `note:<slug>`.

| slug (filename) | unit to extract |
|---|---|
| `forgiveness-of-sins` | _The Forgiveness of Sins, and Other Sermons_ (1905), the title sermon |
| `sermon-the-eternal-in-man` | the same volume, a second short sermon (use the actual title) |
| `sermon-faith-and-the-unseen` | the same volume, a third short sermon (use the actual title) |

Confirm the actual sermon titles from the volume and rename slugs to match if needed (update `gold.yaml` in lockstep). **No economist material and no name-collision in the private ledger** — every private note is unambiguously George.

## 2. Author the synthetic spire (only if the deliberate failure needs it)

The spire is the scalpel for the deliberate failure (step 4), not a corpus filler. Author it **only if** the real route-margin tie does not flip under a tightened encoding on its own. Each synthetic note:
- lives in `scaling/corpus/synthetic/` (the quarantine **is** the flag; there is no `synthetic` type field),
- is a fabricated **George-private** note (never a third Smith, never words for the real Adam Smith),
- carries a one-line comment at the top of the body naming the gold case, the margin, and the mode it targets,
- is skewed toward must-refuse / route-flip, never an extra must-answer win.

Suggested first spire note: `syn-amos-justice-margin` — a fabricated George note on Amos and justice, tuned to sit at the floor against `george-adam-smith:twelve-prophets-amos` so int8 holds the route but int4 flips it.

## 3. Generate the committed vectors

`npm run scaling:build` (added in `package.json`) reads the corpus through the reused `buildCorpus` / `buildPrivateNotes`, embeds with the configured model, embeds the gold queries, and writes:
- `scaling/corpus/index.json` — natural FP vectors (records + real private notes). The headline source of truth; committed.
- `scaling/corpus/index.synthetic.json` — the spire delta (synthetic notes only), unioned under `--natural+synthetic`.
- `scaling/corpus/query-vectors.json` — the gold-query vectors that make `scaling:run` keyless.

Commit all three. They derive from public-domain text, so committing them exposes nothing private (manifest §2); do not generalize that to private corpora.

## 4. Run the gate, then calibrate the deliberate failure

1. `npm run scaling:run` (the `--natural` headline, no key needed once vectors are committed). Confirm: rank correlation FP-vs-int8 above the bar, and the full gold suite passes. Record the headline numbers in delta-log row 2 / 7.
2. Find the break: re-run at `--bits 4` (int4) or a lowered floor and confirm a **route** case flips and the gold suite **catches it**. Report the spire's effect on its own line, never folded into the headline. **If it does not fire, the near-ties are too loose: tighten the margin (the spire), do NOT add corpus** (delta-log row 3). This caught failure is the result the demo rests on; lead the README with it.
3. Optional keyed bonus: `npm run scaling:run -- --full` runs the answer-mode adjudication (related-material routes without restating). This exercises selection, not A2 — int8 never touches the answer model's confabulation residue.

## 5. Verify and reconcile (do these last, from real facts)

- Fill the provenance table OCR-quality notes in `scaling/corpus/README.md` from the actual files; verify every Gutenberg ID and the IA ARK against the live source.
- Fill the delta log rows with what the build actually did. Flag any `paper §5-§6` row immediately (especially row 4 if any unit had to be split).
- **Only once `scaling:run` confirms the headline**, apply the deferred `NEXT-STEPS.md` reconciliation (prepared text in the delta log): distinguish the deliberately-simple **core** (full-precision, pulls no levers, indexes documents whole) from the **`scaling/` miniature** (pulls exactly one lever, int8, on a short-whole-unit corpus; explicitly marked), and add the §C1 link to `scaling/`. Do not claim "a runnable miniature ships" until it runs — that honesty is the whole point.
- Re-run `npm test` and `npm run typecheck`; both stay green.
