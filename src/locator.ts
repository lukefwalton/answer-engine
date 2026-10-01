// Locators are structural and open-ended; two pure renderers turn them into
// the strings a hit and a fragment id carry (docs/CONTRACT.md §1, §4).
//
// renderLocatorLabel: the human label on a hit ("p. 184", "12:30–14:05",
// "ch. 12, §3"). A compound locator is ordered coarse to fine by the caller.
// locatorKey: the stable fragment-id suffix ("p184", "t750-845", "ch12.s3").

import type { Locator } from './contract.js';

const RANGE = '–';

/** Seconds (possibly decimal, as a string) to m:ss, or h:mm:ss past an hour. */
export function formatTimecode(seconds: number | string): string {
  const total = Math.max(0, Math.floor(Number(seconds)));
  if (!Number.isFinite(total)) throw new Error(`timecode is not a number: '${seconds}'`);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function renderOne(l: Locator): string {
  const range = (prefix: string, pluralPrefix: string = prefix): string =>
    l.end !== undefined && l.end !== l.value
      ? `${pluralPrefix}${l.value}${RANGE}${l.end}`
      : `${prefix}${l.value}`;
  switch (l.scheme) {
    case 'whole':
      return 'whole record';
    case 'page':
      return range('p. ', 'pp. ');
    case 'chapter':
      return range('ch. ');
    case 'section':
      return range('§');
    case 'paragraph':
      return range('¶');
    case 'chunk':
      return range('part ');
    case 'timecode':
      return l.end !== undefined && l.end !== l.value
        ? `${formatTimecode(l.value)}${RANGE}${formatTimecode(l.end)}`
        : formatTimecode(l.value);
    case 'note':
      return l.value;
    default:
      return range(`${l.scheme} `);
  }
}

/** The label a hit carries. Throws on an empty locator: every fragment has one. */
export function renderLocatorLabel(locator: readonly Locator[]): string {
  if (locator.length === 0) throw new Error('renderLocatorLabel: a fragment must carry at least one locator');
  return locator.map(renderOne).join(', ');
}

function slug(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

function keyOne(l: Locator): string {
  const span = l.end !== undefined && l.end !== l.value ? `${l.value}-${l.end}` : l.value;
  switch (l.scheme) {
    case 'whole':
      return 'whole';
    case 'page':
      return `p${span}`;
    case 'chapter':
      return `ch${span}`;
    case 'section':
      return `s${span}`;
    case 'paragraph':
      return `para${span}`;
    case 'chunk':
      return `c${span}`;
    case 'timecode':
      return `t${span}`;
    case 'note':
      return slug(l.value);
    default:
      return `${slug(l.scheme)}-${slug(span)}`;
  }
}

/** The stable suffix after `#` in a fragment id. */
export function locatorKey(locator: readonly Locator[]): string {
  if (locator.length === 0) throw new Error('locatorKey: a fragment must carry at least one locator');
  return locator.map(keyOne).join('.');
}
