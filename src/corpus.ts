// Build the two corpus layers from markdown:
//   - public collections → ArchiveRecord (quotable; the body travels)
//   - the private notes dir → PrivateNote (searchable; the text never leaves
//     retrieval — see no-leak.ts)
// Field mapping is deliberately generic (title, a summary, themes, a date) so
// one reader serves essays, lyrics, letters — anything with frontmatter.

import matter from 'gray-matter';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Attribution, Identifier } from './contract.js';
import { fragmentByHeadings, fragmentByPageMarkers } from './ingest/fragment.js';
import type { FragmentPiece } from './ingest/fragment.js';
import { assertPublicSafeField } from './public-safe.js';
import type { ArchiveConfig, ArchiveRecord, CollectionConfig, PrivateBook, PrivateNote } from './types.js';

/** Reduce markdown to plain text for indexing (link text kept, syntax dropped). */
export function stripMarkdown(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[#>]+\s?/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstString(...values: unknown[]): string {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim();
  return '';
}

function asThemes(data: Record<string, unknown>): string[] {
  for (const key of ['themes', 'keywords', 'topics']) {
    const v = data[key];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  }
  return [];
}

function asDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  // YAML reads `date: 1900` as a number; a year is a date at its precision.
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

interface ParsedFile {
  slug: string;
  path: string;
  data: Record<string, unknown>;
  content: string;
  title: string;
}

/** Walk a directory of markdown, parse frontmatter, enforce the rules every
 *  layer shares: missing dirs and malformed files fail loudly with the path;
 *  drafts and `_`-prefixed files are skipped; `title` is required. */
function readMarkdownDir(dir: string, what: string): ParsedFile[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (err) {
    // A missing directory must fail loudly: returning [] would silently drop
    // the whole layer from the index while everything else looks healthy.
    throw new Error(
      `cannot read ${what} at ${dir} ` +
        `(check archive.config.ts): ${err instanceof Error ? err.message : err}`,
    );
  }
  const parsed: ParsedFile[] = [];
  for (const file of files) {
    if (!/\.(md|mdx)$/.test(file) || file.startsWith('_')) continue;
    const slug = file.replace(/\.(md|mdx)$/, '');
    const path = join(dir, file);
    let data: Record<string, unknown>;
    let content: string;
    try {
      ({ data, content } = matter(readFileSync(path, 'utf8')));
    } catch (err) {
      // Name the file: a stray tab in one frontmatter block shouldn't surface
      // as a generic YAML error with no path.
      throw new Error(`failed to parse ${path}: ${err instanceof Error ? err.message : err}`);
    }
    if (data.draft === true) continue;
    const title = firstString(data.title);
    // Title is the one required frontmatter field (see README). Skipping
    // silently would make content vanish from the index with no explanation.
    if (!title) {
      throw new Error(
        `${path} has no 'title' in its frontmatter. Add one, or exclude the file ` +
          `with 'draft: true' or a leading underscore in the filename.`,
      );
    }
    parsed.push({ slug, path, data, content, title });
  }
  return parsed;
}

function readCollection(
  contentRoot: string,
  baseUrl: string,
  collection: CollectionConfig,
): ArchiveRecord[] {
  const dir = join(contentRoot, collection.dir);
  const records: ArchiveRecord[] = [];
  for (const { slug, data, content, title } of readMarkdownDir(dir, `collection '${collection.type}'`)) {
    const record: ArchiveRecord = {
      id: `${collection.type}:${slug}`,
      type: collection.type,
      slug,
      title,
      url: `${baseUrl}${collection.urlPrefix}${slug}/`,
      summary: firstString(data.description, data.summary, data.meaning),
      body: stripMarkdown(content),
      themes: asThemes(data),
    };
    const date = asDate(data.date);
    if (date) record.date = date;
    records.push(record);
  }
  return records;
}

export function buildCorpus(config: ArchiveConfig): ArchiveRecord[] {
  const contentRoot = resolve(config.contentRoot);
  return config.collections
    .flatMap((c) => readCollection(contentRoot, config.baseUrl, c))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Read the private layer. Each note needs `title` (private, embedded),
 *  `label` (the public-safe display name that travels), `about` (the public
 *  URL a citation routes to), and `locator` (where in the private material
 *  the moment lives). The body is the private text — indexed, never quoted. */
export function buildPrivateNotes(config: ArchiveConfig): PrivateNote[] {
  if (!config.privateNotesDir) return [];
  const dir = resolve(config.privateNotesDir);
  const notes: PrivateNote[] = [];
  for (const { slug, path, data, content, title } of readMarkdownDir(dir, 'private notes')) {
    const about = firstString(data.about);
    const locator = firstString(data.locator);
    if (!about || !locator) {
      throw new Error(
        `${path} needs 'about' (the public URL this note routes to) and ` +
          `'locator' (where the moment lives) in its frontmatter.`,
      );
    }
    const label = firstString(data.label);
    if (!label) {
      throw new Error(
        `${path} needs 'label' in its frontmatter — the public-safe display name ` +
          `that travels to the model ('title' stays private and is only embedded). ` +
          `It may simply repeat the title when the title is safe to publish; ` +
          `writing it out is the point — the choice is yours, made per note.`,
      );
    }
    const exposure = data.exposure;
    if (exposure !== undefined && exposure !== 'semantic' && exposure !== 'locator' && exposure !== 'none') {
      // The field is named, not echoed: it is authored frontmatter on a private
      // note, and this message is what `npm run index` prints (STANDARDS §4).
      throw new Error(
        `${path}: 'exposure' must be semantic, locator, or none. ` +
          `Private text is never exposed as text; see docs/CONTRACT.md §3.`,
      );
    }
    const text = stripMarkdown(content);
    // `label` and `locator` travel to the model (RoutingHint, the answer
    // prompt, the related-material template). They are typed PublicSafe and
    // constructible only through the build lint below — a field that quotes
    // the private body fails the build here, not in an answer. What the lint
    // can't catch stays owned: it is a 5-gram tripwire, so a short private
    // phrase (or private meaning in public words) still passes. See
    // NEXT-STEPS.md A1 and src/public-safe.ts.
    notes.push({
      id: `note:${slug}`,
      title,
      label: assertPublicSafeField(label, { field: 'label', path, privateText: text }),
      url: about,
      locator: assertPublicSafeField(locator, { field: 'locator', path, privateText: text }),
      text,
      ...(exposure !== undefined ? { exposure } : {}),
    });
  }
  return notes.sort((a, b) => a.id.localeCompare(b.id));
}

const ID_TOKEN = /^[A-Za-z0-9_-]+$/;
const PAGE_LABEL_MAX = 32;
const PAGE_LABEL = /^[\p{L}\p{N}.-]{1,32}$/u;

/** Frontmatter `authors`: a list of names, or of `{ name, role? }` entries.
 *  Malformed entries name the file and the field, never their value. */
function asAttribution(value: unknown, path: string): Attribution[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path}: 'authors' must be a list of names or of { name, role } entries.`);
  return value.map((entry): Attribution => {
    if (typeof entry === 'string' && entry.trim()) return { name: entry.trim(), role: 'author' };
    if (entry && typeof entry === 'object') {
      const { name, role } = entry as { name?: unknown; role?: unknown };
      if (typeof name !== 'string' || !name.trim()) throw new Error(`${path}: an 'authors' entry needs a 'name'.`);
      if (role !== undefined && typeof role !== 'string') throw new Error(`${path}: an 'authors' entry's 'role' must be a string.`);
      return { name: name.trim(), role: role?.trim() || 'author' };
    }
    throw new Error(`${path}: 'authors' must be a list of names or of { name, role } entries.`);
  });
}

/** Frontmatter `identifiers`: a list of `{ scheme, value }` entries. */
function asIdentifiers(value: unknown, path: string): Identifier[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path}: 'identifiers' must be a list of { scheme, value } entries.`);
  return value.map((entry): Identifier => {
    const { scheme, value: v } = (entry ?? {}) as { scheme?: unknown; value?: unknown };
    if (typeof scheme !== 'string' || !scheme.trim() || (typeof v !== 'string' && typeof v !== 'number')) {
      throw new Error(`${path}: 'identifiers' must be a list of { scheme, value } entries.`);
    }
    return { scheme: scheme.trim(), value: String(v).trim() };
  });
}

function asOptionalBoolean(value: unknown, field: string, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${path}: '${field}' must be true or false.`);
  return value;
}

function asOptionalPositiveInteger(value: unknown, field: string, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${path}: '${field}' must be a positive whole number.`);
  }
  return value;
}

/** A leading `# Title` that repeats the frontmatter title is the title page,
 *  not a chapter: dropped, so it neither becomes a fragment of its own nor
 *  collides with the first chapter's ordinal. */
function withoutTitleHeading(body: string, title: string): string {
  const m = /^\s*#\s+(.+?)\s*#*\s*(?:\r?\n|$)/.exec(body);
  if (!m || m[1]!.trim().toLowerCase() !== title.toLowerCase()) return body;
  return body.slice(m[0].length);
}

/** Read the private books. One markdown file per book; the frontmatter is the
 *  book's public surface (`title`, `about`, and optionally `authors`,
 *  `identifiers`, `date`, `version`, `themes`, `exposure`, `publicTitle`,
 *  `requireReview`) plus how to cut it (`fragmentBy: headings | pages`,
 *  `maxFragmentChars`, `firstPage`); the body is the private text, split
 *  here into pieces whose locators are structural (docs/CONTRACT.md §8).
 *  The pieces' text is embedded, never quoted; what the traveling strings may
 *  say about it is checked by the adapter (src/adapters/teaching.ts) before
 *  anything is drafted or embedded. */
export function buildPrivateBooks(config: ArchiveConfig): PrivateBook[] {
  if (!config.privateBooksDir) return [];
  const dir = resolve(config.privateBooksDir);
  const books: PrivateBook[] = [];
  for (const { slug, path, data, content, title } of readMarkdownDir(dir, 'private books')) {
    const url = firstString(data.about);
    if (!url) {
      throw new Error(`${path} needs 'about' (the public URL a hit on this book routes to) in its frontmatter.`);
    }
    const type = firstString(data.type) || 'book';
    if (!ID_TOKEN.test(type)) {
      throw new Error(`${path}: 'type' must be a short token (letters, digits, '-' or '_'): it opens the entity id, as 'book' does.`);
    }
    const exposure = data.exposure;
    if (exposure !== undefined && exposure !== 'semantic' && exposure !== 'locator' && exposure !== 'none') {
      // Named, not echoed: authored frontmatter on a private book (STANDARDS §4).
      throw new Error(
        `${path}: 'exposure' must be semantic, locator, or none. ` +
          `Private text is never exposed as text; see docs/CONTRACT.md §3.`,
      );
    }
    const fragmentBy = data.fragmentBy ?? 'headings';
    if (fragmentBy !== 'headings' && fragmentBy !== 'pages') {
      throw new Error(`${path}: 'fragmentBy' must be headings (the default) or pages.`);
    }
    const maxFragmentChars = asOptionalPositiveInteger(data.maxFragmentChars, 'maxFragmentChars', path);
    const firstPage = asOptionalPositiveInteger(data.firstPage, 'firstPage', path);
    const publicTitle = asOptionalBoolean(data.publicTitle, 'publicTitle', path);
    const requireReview = asOptionalBoolean(data.requireReview, 'requireReview', path);
    const version = firstString(data.version);
    const date = asDate(data.date);

    const body = withoutTitleHeading(content, title);
    const options = { ...(maxFragmentChars !== undefined ? { maxFragmentChars } : {}) };
    const cut =
      fragmentBy === 'pages'
        ? fragmentByPageMarkers(body, { ...options, ...(firstPage !== undefined ? { firstPage } : {}) })
        : fragmentByHeadings(body, options);
    const pieces: FragmentPiece[] = [];
    for (const [i, piece] of cut.entries()) {
      // A page marker's token becomes a locator value and so part of the
      // fragment id, both of which are printed by every refusal that names a
      // fragment. It is bounded here to a short label of label characters, so
      // an id is structural by construction; the message names the piece by
      // position, never the token (STANDARDS §4).
      for (const l of piece.locator) {
        if (l.scheme === 'page' && !PAGE_LABEL.test(l.value)) {
          throw new Error(
            `${path}: piece ${i + 1}'s page marker is not a short label (letters, digits, '.', '-', at most ${PAGE_LABEL_MAX} characters).`,
          );
        }
      }
      const text = stripMarkdown(piece.text);
      if (!text) continue;
      pieces.push({ locator: piece.locator, text, ...(piece.heading !== undefined ? { heading: piece.heading } : {}) });
    }
    if (pieces.length === 0) {
      throw new Error(`${path} has no text after its frontmatter; a private book needs a body to fragment.`);
    }

    books.push({
      id: `${type}:${slug}`,
      type,
      slug,
      title,
      ...(publicTitle !== undefined ? { publicTitle } : {}),
      url,
      attribution: asAttribution(data.authors ?? data.creators, path),
      identifiers: asIdentifiers(data.identifiers, path),
      ...(date ? { date } : {}),
      ...(version ? { version } : {}),
      themes: asThemes(data),
      ...(exposure !== undefined ? { exposure } : {}),
      ...(requireReview !== undefined ? { requireReview } : {}),
      pieces,
    });
  }
  return books.sort((a, b) => a.id.localeCompare(b.id));
}

/** The text the embedding model sees. Themes are included so topic tags
 *  improve retrieval, not just the answer prompt. */
export function embedText(record: ArchiveRecord): string {
  const themes = record.themes.length > 0 ? `Themes: ${record.themes.join(', ')}` : '';
  return [record.title, record.summary, themes, record.body]
    .filter((s) => s.length > 0)
    .join('\n\n');
}

/** Private vectors come from private text: the note's own title + body. The
 *  private title (not the traveling label) is what retrieval searches — and
 *  for any corpus whose labels repeated their titles, this is byte-identical
 *  to the pre-split embed text, so existing vectors stay valid. */
export function noteEmbedText(note: PrivateNote): string {
  return [note.title, note.text].filter((s) => s.length > 0).join('\n\n');
}
