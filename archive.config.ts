// archive.config.ts — point the engine at your corpus.
//
// The shipped values index the bundled example-content/ so everything works
// out of the box. "Person A" is a placeholder, not a person; all bundled
// content in example-content/ is synthetic fiction (including first-person
// notebook entries written for the demo).
//
// To make it yours: set the names and baseUrl, point contentRoot at your
// markdown, and list your collections.

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
  // Default is a widely available chat model. Swap for any Responses-API model
  // you have access to (e.g. a reasoning model — see src/answer.ts).
  answerModel: 'gpt-4o-mini',
};
