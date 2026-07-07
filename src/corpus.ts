// Build the two corpus layers from markdown:
//   - public collections → ArchiveRecord (quotable; the body travels)
//   - the private notes dir → PrivateNote (searchable; the text never leaves
//     retrieval — see no-leak.ts)
// Field mapping is deliberately generic (title, a summary, themes, a date) so
// one reader serves essays, lyrics, letters — anything with frontmatter.

import matter from 'gray-matter';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertPublicSafeField } from './public-safe.js';
import type { ArchiveConfig, ArchiveRecord, CollectionConfig, PrivateNote } from './types.js';

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
    });
  }
  return notes.sort((a, b) => a.id.localeCompare(b.id));
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
