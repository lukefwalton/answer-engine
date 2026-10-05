// The in-package synthesis consumer's view of hits (docs/CONTRACT.md §9).
//
// A `text` hit is a record in the 2.x sense: quotable evidence whose body the
// prompt may render. A `semantic` or `locator` hit is a hint: where the
// material is, never what it says. The gist is deliberately NOT carried on the
// hint — the prompt shows a semantic hit exactly as it shows a locator hit,
// and the model never sees a description of private material in any mode. It
// travels beside the hints, in `gists` keyed by hintId, which only the
// related-material template reads, after the mode is final (src/answer.ts
// finalizeAnswer → src/public-safe.ts renderRelatedMaterialAnswer).
//
// Citations therefore carry fragment ids: `recordId` and `hintId` are
// `fragmentId`, and the url is the entity's accountable surface.

import { slugOf } from './adapters/teaching.js';
import type { EvidenceHit, LintedGist } from './contract.js';
import type { AnswerEvidence, ArchiveRecord, RoutingHint } from './types.js';

export function toAnswerEvidence(hits: readonly EvidenceHit[]): AnswerEvidence {
  const records: ArchiveRecord[] = [];
  const hints: RoutingHint[] = [];
  const gists: Record<string, LintedGist> = {};
  for (const hit of hits) {
    if (hit.exposure === 'text') {
      const record: ArchiveRecord = {
        id: hit.fragmentId,
        type: hit.entity.type,
        slug: slugOf(hit.entity.id),
        title: hit.entity.title,
        url: hit.entity.url,
        summary: hit.summary ?? '',
        body: hit.text,
        themes: hit.entity.themes ?? [],
      };
      if (hit.date) record.date = hit.date;
      records.push(record);
    } else {
      hints.push({
        hintId: hit.fragmentId,
        label: hit.entity.title,
        url: hit.entity.url,
        locator: hit.locatorLabel,
      });
      if (hit.exposure === 'semantic') gists[hit.fragmentId] = hit.gist;
    }
  }
  return { records, hints, gists };
}
