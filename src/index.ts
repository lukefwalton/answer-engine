// The package surface (docs/CONTRACT.md). A consumer imports the contract types,
// builds or loads an index, retrieves with its own plugins, and crosses with
// project() or search(); the in-package synthesis consumer and the eval harness
// are exported too, as the reference consumer and the admission gate. The CLIs
// under src/cli/ are the clone-and-run teaching path and are not part of dist.

export type * from './contract.js';
export type * from './types.js';

export * from './no-leak.js';
export * from './wire.js';
export * from './retrieve.js';
export * from './boosts.js';
export * from './store.js';
export * from './locator.js';
export * from './dates.js';
export * from './embed-string.js';
export * from './ingest/index.js';
export * from './adapters/teaching.js';
export * from './evaluate.js';
export * from './eval-select.js';
export * from './evidence.js';
export * from './answer.js';
export * from './prompt.js';
export * from './corpus.js';
export * from './embedding.js';

export {
  PUBLIC_SAFE_MAX_CHARS,
  PUBLIC_SAFE_NGRAM_WORDS,
  GIST_MAX_CHARS,
  GIST_NGRAM_WORDS,
  GIST_NGRAM_CHARS,
  PublicSafeLintError,
  normalizeWords,
  hasUnspacedScript,
  privateTextMatcher,
  entityLintText,
  assertPublicSafeField,
  assertPublicSafeMetadata,
  assertSemanticProjection,
  renderRelatedMaterialAnswer,
} from './public-safe.js';
export type { SharedRun } from './public-safe.js';
