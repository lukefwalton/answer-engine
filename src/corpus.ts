// Build the two corpus layers from markdown:
//   - public collections → ArchiveRecord (quotable; the body travels)
//   - the private notes dir → PrivateNote (searchable; the text never leaves
//     retrieval — see no-leak.ts)
// Field mapping is deliberately generic (title, a summary, themes, a date) so
// one reader serves essays, lyrics, letters — anything with frontmatter.

import matter from 'gray-matter';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

/** Read the private layer. Each note needs `title`, `about` (the public URL
 *  a citation routes to), and `locator` (where in the private material the
 *  moment lives). The body is the private text — indexed, never quoted. */
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
    // ⚠ WARNING — these fields TRAVEL TO THE MODEL. no-leak.ts strips the note's
    // body, but `label` (the note's title) and `locator` ride along in the
    // RoutingHint and into the answer prompt. Any frontmatter field that becomes
    // a label or locator reaches the model: keep titles and locators
    // public-safe. A privately-titled note leaks through its own label, and
    // nothing in the type stops it. Making this structural instead of advisory
    // is tracked in NEXT-STEPS.md (A1).
    notes.push({
      id: `note:${slug}`,
      label: title,
      url: about,
      locator,
      text: stripMarkdown(content),
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

/** Private vectors come from private text: label + the note body. */
export function noteEmbedText(note: PrivateNote): string {
  return [note.label, note.text].filter((s) => s.length > 0).join('\n\n');
}
