// scaling.config.ts — points the engine at the int8 scaling-demo corpus.
//
// This is the same ArchiveConfig shape the core uses (src/types.ts), pointed at
// scaling/corpus/ instead of example-content/. The demo reuses the core
// retrieval, the no-leak boundary, and the eval judges untouched; only the
// corpus, the gold set, and a thin int8 pass are new (see scaling/README.md).
//
// Two authors share one colliding name on purpose: Adam Smith the economist
// (1723-1790) and George Adam Smith the theologian (1856-1942). Both write
// dense moral prose about justice and society, so their records sit close in
// embedding space; that proximity is what packs the near-ties int8 rounding can
// reorder. authorName names the collection rather than one person because the
// demo's whole subject is disambiguation; the gold queries name each Smith
// explicitly rather than relying on {{author}} substitution.
//
// On URLs: a record's citation URL is built by the reused corpus path
// (baseUrl + urlPrefix + slug), so it is a demo-canonical surface under the
// reserved .example TLD (RFC 2606), not a live page. The real public-domain
// sources live in scaling/corpus/README.md's provenance table, per work. A
// private note's `about` is taken verbatim from frontmatter, so those route
// targets ARE real public George pages. See the delta log for this divergence
// from the spec's "records carry real public URLs" assumption and why it keeps
// src/corpus.ts untouched.

import type { ArchiveConfig } from '../src/types.js';

export const config: ArchiveConfig = {
  archiveName: 'Smith Collection (int8 scaling demo)',
  authorName: 'Adam Smith and George Adam Smith',
  baseUrl: 'https://smith-collection.example',
  contentRoot: './scaling/corpus',
  collections: [
    { dir: 'public/adam-smith', urlPrefix: '/adam-smith/', type: 'adam-smith' },
    { dir: 'public/george-adam-smith', urlPrefix: '/george/', type: 'george-adam-smith' },
  ],
  // The private layer: George's minor works (sermons, addresses), searchable
  // but never quotable. Designating published work "private" is a layer
  // assignment enforced by the type, not a claim of secrecy (README §2).
  privateNotesDir: './scaling/corpus/private',
  // Matches archive.config.ts. The int8 demo depends on this: the committed
  // vectors must be text-embedding-3-large at native dimensionality or the
  // homogeneity invariant (src/store.ts) rejects them.
  embeddingModel: 'text-embedding-3-large',
  answerModel: 'gpt-4o-mini',
};

// The quarantined synthetic spire (scaling/corpus/synthetic/) is loaded as an
// ADDITIONAL private-notes dir only under --natural+synthetic, never here. Its
// location is the flag: nothing in scaling/corpus/synthetic/ is real George
// text. See scaling/run.ts and README §3.
export const SYNTHETIC_NOTES_DIR = './scaling/corpus/synthetic';
