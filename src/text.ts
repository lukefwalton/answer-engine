// Query-side text helpers shared by retrieval and the boosts.

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Whole-token phrase match, so 'now' never matches inside 'snow'. */
export function containsPhrase(query: string, phrase: string): boolean {
  const needle = normalizeText(phrase);
  if (!needle) return false;
  return ` ${normalizeText(query)} `.includes(` ${needle} `);
}
