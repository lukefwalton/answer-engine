// The in-package synthesis consumer's view of hits (docs/CONTRACT.md §9).
//
// A `text` hit is a record in the 2.x sense: quotable evidence whose body the
// prompt may render. A `semantic` or `locator` hit is a hint: where the
// material is, never what it says. The gist is deliberately NOT carried into
// AnswerEvidence — the prompt shows a semantic hit exactly as it shows a
// locator hit, and the model never sees a description of private material in
// any mode. The related-material template renders the gist after the mode is
// final (a later step wires that; see CHANGELOG).
//
// Citations therefore carry fragment ids: `recordId` and `hintId` are
// `fragmentId`, and the url is the entity's accountable surface.

import { slugOf } from './adapters/teaching.js';
import type { EvidenceHit } from './contract.js';
import type { AnswerEvidence, ArchiveRecord, RoutingHint } from './types.js';

export function toAnswerEvidence(hits: readonly EvidenceHit[]): AnswerEvidence {
  const records: ArchiveRecord[] = [];
  const hints: RoutingHint[] = [];
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
    }
  }
  return { records, hints };
}
