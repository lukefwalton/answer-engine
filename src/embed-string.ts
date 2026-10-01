// The text the embedding model sees for a fragment (docs/CONTRACT.md §12).
//
// One rule, chosen so the bytes reproduce what 2.x embedded and hashed: a
// public `text` fragment embeds its entity's title, its summary, a themes line,
// and its text (today's embedText for a record); every other fragment embeds
// its text alone (today's noteEmbedText, where the private title is already
// inside `text`). The vector and the contentHash of an index entry are taken
// over this string, so changing it is a re-embed of the whole corpus.

import type { Entity, Fragment } from './contract.js';

export function embedStringFor(fragment: Fragment, entity: Pick<Entity, 'title' | 'themes'>): string {
  if (fragment.disclosure.raw === 'public' && fragment.disclosure.exposure === 'text') {
    const themes = entity.themes ?? [];
    const themesLine = themes.length > 0 ? `Themes: ${themes.join(', ')}` : '';
    return [entity.title, fragment.summary ?? '', themesLine, fragment.text]
      .filter((s) => s.length > 0)
      .join('\n\n');
  }
  return fragment.text;
}
