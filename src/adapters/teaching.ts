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

import type { Entity, EntityPolicy, Fragment } from '../contract.js';
import { locatorKey, renderLocatorLabel } from '../locator.js';
import { assertPublicSafeField, assertPublicSafeMetadata } from '../public-safe.js';
import type { ArchiveRecord, PrivateBook, PrivateNote } from '../types.js';

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

/** The note's requested exposure becomes the entity default, and the fragment
 *  carries the same request: an adapter emits what the author asked for, and
 *  the build resolves it once the projection is known (src/cli/build-index.ts;
 *  the legacy view, which drafts nothing, resolves it in src/store.ts). A
 *  fragment's `disclosure` is a request until a build stores it. */
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
    disclosure: entity.disclosure,
  };
  return { entity, fragment };
}

/**
 * A private book is one entity with many fragments (CONTRACT.md §8, §12): one
 * per piece the corpus reader cut, ids `${entityId}#${locatorKey}` (book:x#ch12,
 * book:x#ch12.s3, book:x#p184), each fragment's text its heading and its piece
 * joined as a note's title and body are, so a chapter title is in the
 * embedding and never leaves `text`. The entity default is the exposure the
 * frontmatter asked for, carried on every fragment as a request until the
 * build resolves it against a projection. The frontmatter's `publicTitle` and
 * `requireReview` become the entity's policy.
 *
 * The strings a hit on the book would carry (title, version, creators,
 * themes, locator labels) go through the metadata lint here, against the whole
 * book, before anything is drafted or embedded: a quoting title fails in the
 * reader's output, not after a paid build. The store runs the same lint again
 * at every load (CONTRACT.md §12).
 */
export function fromPrivateBook(book: PrivateBook): { entity: Entity; fragment: Fragment }[] {
  const disclosure = { raw: 'private', exposure: book.exposure ?? 'locator' } as const;
  const policy: EntityPolicy = {
    ...(book.publicTitle ? { publicTitle: true } : {}),
    ...(book.requireReview ? { requireReview: true } : {}),
  };
  const entity: Entity = {
    id: book.id,
    type: book.type,
    title: book.title,
    attribution: book.attribution,
    ...(book.date ? { date: book.date } : {}),
    ...(book.version ? { version: book.version } : {}),
    url: book.url,
    identifiers: book.identifiers,
    ...(book.themes.length > 0 ? { themes: book.themes } : {}),
    disclosure,
    ...(Object.keys(policy).length > 0 ? { policy } : {}),
  };
  if (book.pieces.length === 0) {
    throw new Error(`private book '${book.id}' has no pieces; a book is at least one fragment.`);
  }
  const fragments: Fragment[] = [];
  const keys = new Map<string, number>();
  for (const [index, piece] of book.pieces.entries()) {
    const key = locatorKey(piece.locator);
    const first = keys.get(key);
    if (first !== undefined) {
      // Two chapters numbered the same, or two pages marked the same: the
      // locator is the id, so the author fixes the source. Named by position
      // and scheme, never by value: a chapter value is a parsed number or an
      // ordinal, but a page value is the author's own marker token, and this
      // message is what `npm run index` prints (STANDARDS §4).
      const schemes = piece.locator.map((l) => l.scheme).join('.');
      throw new Error(
        `private book '${book.id}': pieces ${first + 1} and ${index + 1} of ${book.pieces.length} share a ` +
          `'${schemes}' locator; each chapter heading or page marker must be distinct.`,
      );
    }
    keys.set(key, index);
    // The key carries the locator values (ch12, p184, p184.s2). A locator is
    // public surface by contract (CONTRACT.md §1: structural, on every hit as
    // the label), and the metadata lint below checks every value and label
    // against the whole book before this id goes anywhere, so an id is safe to
    // print by the same construction as the hit's locatorLabel. A page
    // marker's token is one such value, bounded to a short label by the
    // reader (src/corpus.ts) before it reaches this id.
    fragments.push({
      id: `${book.id}#${key}`,
      entityId: book.id,
      locator: piece.locator,
      text: joinNoteText(piece.heading ?? '', piece.text),
      disclosure,
    });
  }
  assertPublicSafeMetadata(entity, fragments, { path: `private book '${book.id}'` });
  return fragments.map((fragment) => ({ entity, fragment }));
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
