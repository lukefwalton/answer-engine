// archive.config.ts — point the engine at your corpus.
//
// The shipped values index the bundled example-content/ so everything works
// out of the box. "Person A" is a placeholder, not a person. To make it
// yours: set the names and baseUrl, point contentRoot at your markdown,
// and list your collections.

import type { ArchiveConfig } from './src/types.js';

export const config: ArchiveConfig = {
  archiveName: 'The Example Archive',
  authorName: 'Person A',
  baseUrl: 'https://example.com',
  contentRoot: './example-content',
  collections: [
    { dir: 'essays', urlPrefix: '/essays/', type: 'essay' },
    { dir: 'lyrics', urlPrefix: '/lyrics/', type: 'song' },
  ],
  // The private layer: searchable, never quotable (see src/no-leak.ts). In
  // production this is chunked podcast transcripts; here, notebook entries.
  // Remove the line to run public-only.
  privateNotesDir: './example-content/notebook',
  embeddingModel: 'text-embedding-3-large',
  // Any Responses-API model works; swap this if your key lacks access.
  answerModel: 'gpt-5.4-nano',
};
