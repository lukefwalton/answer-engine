// The privacy boundary. This is the whole file on purpose.
//
// Retrieval searches private text (the vectors came from it), but the answer
// model must never read it. assembleEvidence is the ONE place a PrivateNote
// crosses toward the model, and the only thing it does is throw the text
// away. RoutingHint has no text field, so passing private prose through
// this path is a TypeScript error — not a runtime guard to remember.

import type { AnswerEvidence, ArchiveRecord, PrivateNote, RoutingHint } from './types.js';

export function toRoutingHint(note: PrivateNote): RoutingHint {
  return {
    hintId: note.id,
    label: note.label,
    url: note.url,
    locator: note.locator,
    // no text — by design.
  };
}

export function assembleEvidence(
  records: readonly ArchiveRecord[],
  notes: readonly PrivateNote[],
): AnswerEvidence {
  return {
    records: [...records],
    hints: notes.map(toRoutingHint),
  };
}
