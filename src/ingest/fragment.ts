// Fragmenting a long document into retrievable pieces (docs/CONTRACT.md §8, §12).
//
// Two splitters, both deterministic and both producing locators that are
// structural (ordinals, page numbers), never authored prose: a heading-based
// splitter for manuscripts and markdown, and a page-marker splitter for
// typeset text. A piece longer than `maxFragmentChars` is sub-split on
// paragraph boundaries and gets a `section` (or `paragraph`) locator appended.
// Heading text is returned separately as `heading` so the caller can decide
// whether it is public; it is never placed in the locator.

import type { Locator } from '../contract.js';

export interface FragmentPiece {
  locator: Locator[];
  text: string;
  /** The heading that opened this piece, if any. Private until the caller says otherwise. */
  heading?: string;
}

export interface FragmentOptions {
  /** Pieces longer than this are sub-split on paragraph boundaries. */
  maxFragmentChars?: number;
}

export const DEFAULT_MAX_FRAGMENT_CHARS = 6000;

const HEADING = /^#{1,2}\s+(.+?)\s*#*\s*$/;
const CHAPTER_NUMBER = /^(?:chapter|ch\.?|part|book)\s+([0-9]+|[ivxlc]+)\b/i;
const PAGE_MARKER = /^<<<page\s+(\S+)>>>\s*$/;

/**
 * Split markdown on level-1 and level-2 headings. A heading that names a
 * chapter number ("Chapter 12", "CHAPTER XII") yields `chapter:<number>`;
 * any other heading yields `chapter:<ordinal>` counted among headings. Text
 * before the first heading, when non-blank, is `section:front`.
 */
export function fragmentByHeadings(markdown: string, options: FragmentOptions = {}): FragmentPiece[] {
  const lines = markdown.split(/\r?\n/);
  const pieces: FragmentPiece[] = [];
  let buffer: string[] = [];
  let heading: string | undefined;
  let locator: Locator[] = [{ scheme: 'section', value: 'front' }];
  let ordinal = 0;

  const flush = (): void => {
    const text = buffer.join('\n').trim();
    if (text) pieces.push({ locator, text, ...(heading !== undefined ? { heading } : {}) });
    buffer = [];
  };

  for (const line of lines) {
    const m = HEADING.exec(line);
    if (m) {
      flush();
      ordinal += 1;
      heading = m[1]!.trim();
      const numbered = CHAPTER_NUMBER.exec(heading);
      locator = [{ scheme: 'chapter', value: numbered ? numbered[1]!.toUpperCase() : String(ordinal) }];
      continue;
    }
    buffer.push(line);
  }
  flush();

  const max = options.maxFragmentChars ?? DEFAULT_MAX_FRAGMENT_CHARS;
  return pieces.flatMap((piece) => splitLong(piece, max));
}

/**
 * Split typeset text on page markers: a form feed (`\f`) starts a new page and
 * pages are numbered from `firstPage`; or an explicit line `<<<page N>>>`
 * carries its own number. Text before the first explicit marker, when
 * non-blank, is `section:front`.
 */
export function fragmentByPageMarkers(
  text: string,
  options: FragmentOptions & { firstPage?: number } = {},
): FragmentPiece[] {
  const max = options.maxFragmentChars ?? DEFAULT_MAX_FRAGMENT_CHARS;
  const pieces: FragmentPiece[] = [];

  if (text.includes('\f')) {
    let page = options.firstPage ?? 1;
    for (const chunk of text.split('\f')) {
      const body = chunk.trim();
      if (body) pieces.push({ locator: [{ scheme: 'page', value: String(page) }], text: body });
      page += 1;
    }
    return pieces.flatMap((piece) => splitLong(piece, max));
  }

  let buffer: string[] = [];
  let locator: Locator[] = [{ scheme: 'section', value: 'front' }];
  const flush = (): void => {
    const body = buffer.join('\n').trim();
    if (body) pieces.push({ locator, text: body });
    buffer = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const m = PAGE_MARKER.exec(line);
    if (m) {
      flush();
      locator = [{ scheme: 'page', value: m[1]! }];
      continue;
    }
    buffer.push(line);
  }
  flush();
  return pieces.flatMap((piece) => splitLong(piece, max));
}

/**
 * Sub-split a piece longer than `maxChars` on blank-line paragraph boundaries,
 * appending a `section` locator (or `paragraph`, when the piece already ends
 * in a section). A single paragraph longer than `maxChars` is cut at the last
 * whitespace before the limit so no piece exceeds it.
 */
export function splitLong(piece: FragmentPiece, maxChars: number): FragmentPiece[] {
  if (piece.text.length <= maxChars) return [piece];
  const paragraphs = piece.text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => hardWrap(p, maxChars));

  const parts: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxChars && current) {
      parts.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);

  const last = piece.locator[piece.locator.length - 1];
  const subScheme = last?.scheme === 'section' ? 'paragraph' : 'section';
  return parts.map((text, i) => ({
    ...piece,
    locator: [...piece.locator, { scheme: subScheme, value: String(i + 1) }],
    text,
  }));
}

function hardWrap(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) return [paragraph];
  const out: string[] = [];
  let rest = paragraph;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(' ', maxChars);
    if (cut <= 0) cut = maxChars;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
