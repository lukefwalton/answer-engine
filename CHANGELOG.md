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
  (`raw: public | private`, `expose: text | semantic | locator | none`, with
  `private + text` unrepresentable); `project()` as the single crossing from
  retrieval to a wire type that cannot carry more than the policy allows;
  system-generated, author-authorized semantic projections with a build-time
  lint; provenance (date, version, creators, identifiers, locators) on every
  hit; a pluggable retrieval core; and the wire contract `archive-search/1`
  for a retrieval-only consumer. Nothing in it is implemented yet.
- This changelog.

### Planned for 3.0.0 (breaking)

Recorded so the shape of the next major is visible before the code lands. See
`docs/CONTRACT.md` for the normative text.

- The package becomes installable (`dist/`, `exports`, published to npm);
  `private: true` is dropped.
- `ArchiveRecord` / `PrivateNote` become inputs to adapters that produce
  `Entity` + `Fragment`; `RoutingHint` generalizes to the `locator` and
  `semantic` variants of `EvidenceHit`.
- `src/no-leak.ts` exports `project()` in place of `toRoutingHint` /
  `assembleEvidence`.
- The cosine score is renamed `cosine`; `semantic` names an exposure level.
- Index schema 4 (entities stored once; fragments reference them).
- Retrieval takes plugins and filters; the built-in boosts keep their values.
- The governance files that describe the 2.x charter (`.github/STANDARDS.md`
  §3 and §5, `CONTRIBUTING.md`, `SECURITY.md`, `NEXT-STEPS.md` A1 and D) are
  revised in the same release.

## [2.1.0] - 2026-07-08

Last release of the 2.x teaching-sized engine. Release notes for 1.1.0 through
2.1.0 are on the
[GitHub releases page](https://github.com/lukefwalton/answer-engine/releases).
