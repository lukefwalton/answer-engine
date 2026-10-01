// Adapters between the teaching corpus's two layers (ArchiveRecord, PrivateNote)
// and the contract's Entity + Fragment (docs/CONTRACT.md §12).
//
// Forward: a record becomes a public entity with one `text` fragment whose
// locator is `whole`; a note becomes a private entity (titled by its linted
// label) with one `locator` fragment whose text is the note's private title and
// body, joined exactly as noteEmbedText joins them, so the private title stays
// in the embedding and never leaves `text`.
//
// Reverse (transitional, until the retrieval core reads fragments in Step 3):
// the same two shapes reconstructed losslessly, so today's retrieval, prompt,
// eval and demo code keep running on a schema-4 index without changes.

import type { Entity, Fragment } from '../contract.js';
import { resolveDisclosure } from '../ingest/disclosure.js';
import { locatorKey, renderLocatorLabel } from '../locator.js';
import { assertPublicSafeField } from '../public-safe.js';
import type { ArchiveRecord, PrivateNote } from '../types.js';

export const WHOLE_LOCATOR = { scheme: 'whole', value: '' } as const;

export function fromArchiveRecord(record: ArchiveRecord): { entity: Entity; fragment: Fragment } {
  const disclosure = { raw: 'public', exposure: 'text' } as const;
  const entity: Entity = {
    id: record.id,
    type: record.type,
    title: record.title,
    attribution: [],
    ...(record.date ? { date: record.date } : {}),
    url: record.url,
    identifiers: [],
    themes: record.themes,
    disclosure,
  };
  const fragment: Fragment = {
    id: `${record.id}#whole`,
    entityId: record.id,
    locator: [{ ...WHOLE_LOCATOR }],
    text: record.body,
    disclosure,
    summary: record.summary,
  };
  return { entity, fragment };
}

/** The slug is the part of the id after the first ':' (CONTRACT.md §7). */
export function slugOf(entityId: string): string {
  const i = entityId.indexOf(':');
  return i < 0 ? entityId : entityId.slice(i + 1);
}

export function toArchiveRecord(entity: Entity, fragment: Fragment): ArchiveRecord {
  const record: ArchiveRecord = {
    id: entity.id,
    type: entity.type,
    slug: slugOf(entity.id),
    title: entity.title,
    url: entity.url,
    summary: fragment.summary ?? '',
    body: fragment.text,
    themes: entity.themes ?? [],
  };
  if (entity.date) record.date = entity.date;
  return record;
}

/** The note's private title and body, joined as the embedding sees them.
 *  Mirrors noteEmbedText in src/corpus.ts; kept here so the adapter does not
 *  pull the markdown reader into every consumer. */
export function joinNoteText(title: string, body: string): string {
  return [title, body].filter((s) => s.length > 0).join('\n\n');
}

/** The note's requested exposure becomes the entity default; the fragment's
 *  disclosure is RESOLVED with no projection attached, so a requested
 *  `semantic` reads `locator` here until the build drafts a gist and resolves
 *  again (src/cli/build-index.ts). */
export function fromPrivateNote(note: PrivateNote): { entity: Entity; fragment: Fragment } {
  const locator = [{ scheme: 'note', value: note.locator as string }];
  const entity: Entity = {
    id: note.id,
    type: 'note',
    title: note.label,
    attribution: [],
    url: note.url,
    identifiers: [],
    disclosure: { raw: 'private', exposure: note.exposure ?? 'locator' },
  };
  const fragment: Fragment = {
    id: `${note.id}#${locatorKey(locator)}`,
    entityId: note.id,
    locator,
    text: joinNoteText(note.title, note.text),
    disclosure: resolveDisclosure(entity, {}),
  };
  return { entity, fragment };
}

/**
 * Reverse of fromPrivateNote. The private title is the text before the first
 * blank line and the body is what follows: a note's title is one frontmatter
 * line and its body is whitespace-collapsed by stripMarkdown, so the split is
 * exact for anything the corpus reader produced. The label and locator go back
 * through the lint against the body here rather than being cast: the brand
 * erases at JSON (CONTRACT.md §4), and a stored string is a string until the
 * lint says otherwise, so a hand-edited index fails here as it fails at load.
 */
export function toPrivateNote(entity: Entity, fragment: Fragment): PrivateNote {
  const cut = fragment.text.indexOf('\n\n');
  const title = cut < 0 ? fragment.text : fragment.text.slice(0, cut);
  const text = cut < 0 ? '' : fragment.text.slice(cut + 2);
  const noteLocator = fragment.locator.find((l) => l.scheme === 'note');
  const locator = noteLocator ? noteLocator.value : renderLocatorLabel(fragment.locator);
  const path = fragment.id;
  // The REQUESTED exposure is the entity default; the fragment carries the resolved one.
  const requested = entity.disclosure.raw === 'private' ? entity.disclosure.exposure : 'locator';
  return {
    id: entity.id,
    title,
    label: assertPublicSafeField(entity.title, { field: 'label', path, privateText: text }),
    url: entity.url,
    locator: assertPublicSafeField(locator, { field: 'locator', path, privateText: text }),
    text,
    ...(requested !== 'locator' ? { exposure: requested } : {}),
  };
}
