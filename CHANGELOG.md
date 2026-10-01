# Changelog

All notable changes to this repository are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Releases are cut by the `release`
workflow and archived on Zenodo under the concept DOI
[10.5281/zenodo.20676773](https://doi.org/10.5281/zenodo.20676773).

## [Unreleased]

### Added

- `docs/CONTRACT.md`: the archive contract, the design of record for 3.0.0.
  Entities and fragments; a two-dimensional disclosure policy
  (`raw: public | private`, `exposure: text | semantic | locator | none`, with
  `private + text` unrepresentable); `project()` as the single crossing from
  retrieval to a wire type that cannot carry more than the policy allows;
  system-generated, author-authorized semantic projections with a build-time
  lint; provenance (date, version, creators, identifiers, locators) on every
  hit; a pluggable retrieval core; and the wire contract `archive-search/1`
  for a retrieval-only consumer. Documentation only: nothing in it is
  implemented, and the 2.x code and the gold suite's semantics remain the
  source of truth until 3.0.0 ships.
- This changelog.
- Step 1 of 3.0.0 (additive; no 2.x behaviour changes): `src/contract.ts` with the
  contract types; `assertSemanticProjection` and the `LintedGist` brand in
  `src/public-safe.ts`, with Unicode-aware word normalization for both lints and a
  character-run check for scripts without word spacing; `src/ingest/disclosure.ts`
  (`isServableGist`, `resolveDisclosure`); `src/ingest/fragment.ts`
  (`fragmentByHeadings`, `fragmentByPageMarkers`, `splitLong`); `src/locator.ts`
  (`renderLocatorLabel`, `locatorKey`, `formatTimecode`).
- Step 2 of 3.0.0: index schema 4 in `src/store.ts` (entities stored once; every
  entry carries a `Fragment` with its resolved disclosure; `validateIndex`,
  `toServedIndex`, `validateServedIndex`); the teaching adapters
  (`src/adapters/teaching.ts`) and the embed-string rule (`src/embed-string.ts`)
  that reproduce the 2.x embed bytes; a keyless `npm run migrate:index`
  (schema 3 → 4, vectors and hashes untouched), applied to the demo's committed
  `demo/corpus/index.json` and `index.synthetic.json`. `readIndexFile` and
  `writeIndexFile` keep their record/note signatures through a transitional view,
  so `npm run index`, the demo, and retrieval are unchanged. A schema-3 index now
  fails fast with the migration remedy instead of a rebuild.
- Step 3 of 3.0.0, the one behaviour switch: retrieval runs over fragments
  (`src/retrieve.ts`: `RetrievalIndex`, `RetrieveOptions`, filters before
  scoring, `limit` or per-layer `limitPerRaw`, recency modes, `partitionByRaw`,
  `retrieveWithCounts`); boosts are plugins (`src/boosts.ts`; the default set
  reproduces 2.x scoring exactly); `src/no-leak.ts` exports `project()` and
  `search()` in place of `toRoutingHint` / `assembleEvidence`, with coarse scores
  and no breakdown on private hits; `src/evidence.ts` turns hits into the
  in-package consumer's `AnswerEvidence` (the gist never enters the prompt);
  citations carry fragment ids; `judgeRetrieval` matches an expected id against
  entity id or fragment id. `RoutingHint.label` / `locator` are plain strings.
  `cosine` names the similarity everywhere; `ScoredRecord.semantic` is gone.
  The related-material template still renders label and locator; rendering a
  gist for `semantic` hits arrives with the demo entity in Step 4.
- The load-time lint over authored private metadata. The strings a hit on a
  private entity carries besides its text (title, version, creator and speaker
  names and roles, themes, every locator value and the rendered locator label)
  are not typed; they are linted. `assertPublicSafeMetadata` in
  `src/public-safe.ts` runs the 2.x label/locator rule (one line, 120 characters,
  no five-word run; characters for a script without word spacing) over all of
  them against the entity's whole private text, and `validateIndex` runs it on
  every load of a private index, so a hand-edited artifact fails at load with the
  field and the run instead of in an answer. One exemption keeps the shipped
  corpora honest: a fragment whose text opens with the entity's title as its own
  paragraph (the note shape) has that heading removed from the comparison. The
  one tightening against 2.x: a label that lifts a five-word run from a note's
  private title without being that title now fails, where 2.x compared the label
  with the body alone. `writeIndex` and `writeServedIndex` validate before
  writing. `toPrivateNote` re-lints the label and locator instead of casting
  them to `PublicSafe`, so the brand has one constructor again.
  `assertPublicSafeField` accepts any field name and reports "quotes private
  text" for every caller. `npm run migrate:index` fails with the file and the
  remedy on a missing or unparseable path instead of a stack trace.
- Step 4 of 3.0.0, projections and the canary sweep (docs/CONTRACT.md §5, §11).
  `src/ingest/gist.ts`: the `GistDrafter` seam, `createOpenAIGistDrafter`
  (Responses API, `store: false`, JSON-schema output, `GIST_PROMPT_VERSION`
  `gist/1`), and `draftProjections`, which drafts only where the author asked
  for `semantic`, lints every draft against the fragment and the whole entity,
  retries once with the lint's reason, stores a second failure as
  `lint: 'failed'`, skips a generated gist whose text, model, and prompt version
  are unchanged, never overwrites an edit (re-linted; `stale` when the text
  moved), carries a veto across a redraft, and carries a projection for a
  fragment no longer exposed as `semantic`. `contentHash` is the sha1 of the
  fragment text alone, with model and prompt version beside it, so an edited
  gist's staleness does not depend on which model drafted the original.
  `src/ingest/projections.ts`: the author's file, `artifacts/projections.json`,
  gitignored with the index. `npm run index` now builds entities and fragments
  directly (no legacy view), runs the draft step, resolves each fragment's
  exposure, and reuses vectors by fragment id; a run with nothing to draft or
  embed needs no key. A private note may set `exposure: semantic | locator |
  none` in frontmatter; `text` is refused with the file. `archive.config.ts`
  takes an optional `gist` block (model, caps, allowed names per entity).
  `eval/gold.yaml` gains a top-level `canaries` list and `npm run eval` runs
  `sweepCanaries` keylessly over every served gist and each entity's gists
  together before any API call, failing the run on a hit. The related-material
  template renders a `semantic` hit's gist after the fixed sentence; the gist
  travels in `AnswerEvidence.gists`, beside the hints and never into the prompt.
  `search()` excludes `none` fragments before scoring (they are never served);
  `retrieve()` still sees them. The demo's `semantic` entity (a public-domain
  novel with committed gists) is a separate, keyed pull request.

### Planned for 3.0.0 (breaking)

Recorded so the shape of the next major is visible before the code lands. See
`docs/CONTRACT.md` for the normative text.

- The package becomes installable (`dist/`, `exports`, published to npm);
  `private: true` is dropped.
- `ArchiveRecord` / `PrivateNote` become inputs to adapters that produce
  `Entity` + `Fragment`; `RoutingHint` generalizes to the `locator` and
  `semantic` variants of `EvidenceHit`, which carries provenance (creators,
  date, version, identifiers, locator) on every hit.
- `src/no-leak.ts` exports `project()` and `search()` in place of
  `toRoutingHint` / `assembleEvidence`.
- The cosine score is renamed `cosine`; `semantic` names an exposure level.
  Scores on private hits are rounded and carry no breakdown.
- Index schema 4 (entities stored once; fragments reference them), a served
  index produced by `toServedIndex()`, and a keyless schema 3 to 4 migration
  for the demo's committed vectors.
- Retrieval takes plugins and filters; the built-in boosts keep their values.
- The teaching-sized synthesis (`src/answer.ts`, `src/prompt.ts`, `src/cli/ask.ts`,
  the `--full` eval tier) stays as the reference consumer, reading hits.
- The `PublicSafe` brand is retired as a type for labels and locators (the
  check stays, at build); the brand lives on the gist as `LintedGist`.
- The files that describe the 2.x charter are revised in the same release:
  `.github/STANDARDS.md` §1, §3, §5 and §6; `README.md` §§1–3, Quick start
  and Commands; `CONTRIBUTING.md`; `SECURITY.md`; `NEXT-STEPS.md` A1, A2 and
  D; cross-references in `docs/production-scaling.md`.
  `scripts/build-blind-artifact.mjs` is retired.

## [2.1.0] - 2026-07-08

Last release of the 2.x teaching-sized engine. Release notes for 1.1.0 through
2.1.0 are on the
[GitHub releases page](https://github.com/lukefwalton/answer-engine/releases).
