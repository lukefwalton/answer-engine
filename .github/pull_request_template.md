## What & why

<!--
Read CONTRIBUTING.md first: most additions are correctly out of scope. The value
this repo carries is the boundary and the answer contract, not feature coverage.
If a change makes the engine bigger without making a promise more checkable, it
likely belongs in a consumer adapter, not here. Describe what changed and why,
and link any issue (e.g. Closes #12).
-->

## Checklist

- [ ] `npm test` passes **without an API key** (the offline CI gate) — no hidden
      dependency on live calls
- [ ] `npm run typecheck` passes
- [ ] No change that makes the eval pass by special-casing a question (fixes go
      into the corpus, scoring, or prompt)
- [ ] A boundary stays structural (a type, not a checker someone must remember),
      if this touches the no-leak path
- [ ] Touched the prompt / retrieval / validation / repair? Ran the relevant
      `npm run eval` subset
- [ ] Read against [`.github/STANDARDS.md`](.github/STANDARDS.md) — the rubric a PR is judged by
