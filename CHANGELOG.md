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

- Step 5 of 3.0.0, packaging and the governance re-charter (#30, #31). The
  package is installable: `@lukefwalton/answer-engine` (`private: true` dropped;
  `main`, `types`, `exports` for `.`, `./contract`, `./retrieve`, `./boosts`,
  `./no-leak`, `./store`, `./ingest`, `./eval`, `./public-safe`, `./locator`;
  `tsconfig.build.json` emits `dist/` from `src/` without the CLIs, which stay
  the clone-and-run path). `npm run build`; `npm run test:dist` builds and
  imports the package by name through its own `exports`, keyless, and runs in
  CI. The release workflow learns pre-releases (`premajor` starts
  `3.0.0-alpha.1`, `prerelease` continues the line, patch/minor/major finalize
  it; `scripts/next-version.mjs`, tested), sorts tags so a finalized release
  outranks its pre-releases, builds and smokes before any ref is pushed, marks
  GitHub pre-releases, and publishes to npm with provenance (trusted publishing
  or an `NPM_TOKEN` secret; pre-releases under the `next` dist-tag).
  `scripts/sync-release-metadata.mjs` accepts pre-release versions.
  `.github/STANDARDS.md` is re-chartered for the substrate (`project()` as the
  one crossing, exposure resolved at build, the linted-not-typed metadata rule,
  the gist never in the prompt, the seams as the extension points, the
  consumer's list); `README.md` §§1–3, the eval section, Commands, "Where to
  take it", "What stays out", and the release notes are rewritten for entities,
  fragments, and hits; `CONTRIBUTING.md` names generic plugins and ingest
  helpers as in scope; `SECURITY.md` states custody and what is and is not a
  boundary report; `NEXT-STEPS.md` A1 is superseded by the contract's §6 and
  §13 with the residue restated, A2 extends to gists, B3 is closed as a design
  question, D names the rate limiter as load-bearing; `docs/production-scaling.md`
  points at the contract; `CITATION.cff` and `.zenodo.json` describe the
  substrate (the title is unchanged).

- Review fixes on the 3.0.0 line. A lint failure names the position of the
  shared run in the string under test (`quotes private text at words 3–7`),
  never the run: the message is what `npm run index`, CI, and a consumer's
  loader print, and the run is private text (STANDARDS §4). Both lints throw
  `PublicSafeLintError`; `findSharedWordRun` and `findSharedCharRun` are
  replaced by `privateTextMatcher`, which reports positions. `validateIndex`
  re-earns a `semantic` fragment's gist at every load of a private index instead
  of reading `lint: 'passed'` from the file: the projection's `contentHash` must
  be the hash of the fragment's text, and the gist must pass
  `assertSemanticProjection` against that text and, for an entity with more than
  one fragment, the whole entity's text (`entityLintText`: fragment-id order,
  the one definition the drafter and the loader share). The lints' window is
  authored per entity as `policy.lint` (`ngramWords`, `ngramChars`,
  `gistMaxChars`), stored in the index, and read the same way at build and at
  load; `npm run index` stamps `archive.config.ts`'s `gist.maxChars` and
  `gist.ngramWords` onto every entity's policy, and `draftProjections` no longer
  takes them as options. `validateIndex` and `validateServedIndex` check nested
  items (attribution, identifiers, locators, projection, policy) and every
  vector element (exactly `dimensions` finite numbers), and name the field in
  the message, never a value; both refuse an entity with no fragment, a
  fragment id listed twice, and a `timecode` locator whose value is not decimal
  seconds (checked by field name, so `formatTimecode`, which now throws without
  echoing the value, never meets one inside the lint). The eval reports a
  canary or an answer pattern that fired by its index in the gold file
  (`canaries[3] appears in the served gist of '…'`,
  `answer matched forbidAnswerPatterns[0]`), never by its text: canaries are
  private wording, and `npm run eval` prints the issues. `projectionContentHash` moves to
  `src/ingest/projections.ts`, beside `projectionProblem`.

### Removed

- `scripts/build-blind-artifact.mjs`. Review is open, not blind; the script's
  anonymized tarball has no remaining use.

### Breaking in the 3.0.0 line (summary)

Recorded here in one place; `docs/CONTRACT.md` is the normative text.

- `ArchiveRecord` / `PrivateNote` are inputs to the teaching adapters, which
  produce `Entity` + `Fragment`; the index is schema 4 and a schema-3 file is
  migrated with `npm run migrate:index`.
- `src/no-leak.ts` exports `project()` and `search()` in place of
  `toRoutingHint` / `assembleEvidence`; `RoutingHint` is a plain-string view
  the in-package consumer derives from `EvidenceHit`, which carries provenance
  on every hit.
- `retrieve()` takes a `RetrievalIndex` and `RetrieveOptions` (plugins,
  filters, `limit` or `limitPerRaw`, recency modes) and returns `ScoredHit[]`;
  the cosine score is `cosine` and `semantic` names an exposure; scores on
  private hits are rounded and carry no breakdown.
- `npm run index` writes `artifacts/index.json` (schema 4) and
  `artifacts/projections.json`; the `PublicSafe` brand is retired as a type (the
  check stays, at build and at every load) and the brand lives on the gist as
  `LintedGist`.
- `judgeRetrieval` reads `ScoredHit[]` and matches an expected id against an
  entity id or a fragment id; `loadGoldFile` returns queries and canaries.
- The package name is `@lukefwalton/answer-engine`.

## [2.1.0] - 2026-07-08

Last release of the 2.x teaching-sized engine. Release notes for 1.1.0 through
2.1.0 are on the
[GitHub releases page](https://github.com/lukefwalton/answer-engine/releases).
