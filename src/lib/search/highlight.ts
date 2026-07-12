/**
 * Shared with runSearch() (src/app/page.tsx) so highlighting can never
 * diverge from what the ilike query actually matched on. Search here is
 * plain case-insensitive substring matching (not tsvector FTS — see
 * runSearch's comment), so highlighting is done the same way: split on the
 * literal term substrings, not via ts_headline/tsquery lexeme matching.
 */
export function deriveSearchTerms(query: string): string[] {
  const cleaned = query.trim().replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return cleaned.split(/\s+/).filter(Boolean);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One shared case-insensitive, Icelandic-safe regex matching any term. */
export function buildTermRegex(terms: string[]): RegExp | null {
  const clean = terms.filter(Boolean);
  if (clean.length === 0) return null;
  const pattern = clean
    .map(escapeRegExp)
    .sort((a, b) => b.length - a.length) // longest first so overlapping terms don't shadow a longer match
    .join('|');
  return new RegExp(`(${pattern})`, 'giu');
}

const SNIPPET_WORD_RADIUS = 12; // ~ words before/after the match

/**
 * Pull a short window of extracted_text around the first term match, for
 * display as search-result context. Returns null if there's no text or no
 * term appears in it — the caller renders no snippet in that case.
 */
export function buildSnippet(text: string | null | undefined, terms: string[]): string | null {
  if (!text) return null;
  const regex = buildTermRegex(terms);
  if (!regex) return null;

  const match = regex.exec(text);
  if (!match) return null;
  const matchIndex = match.index;

  const words = text.split(/\s+/);
  let cumulative = 0;
  let wordIdx = 0;
  for (let i = 0; i < words.length; i++) {
    cumulative += words[i].length + 1;
    if (cumulative > matchIndex) { wordIdx = i; break; }
  }

  const start = Math.max(0, wordIdx - SNIPPET_WORD_RADIUS);
  const end = Math.min(words.length, wordIdx + SNIPPET_WORD_RADIUS);
  const slice = words.slice(start, end).join(' ');
  const prefix = start > 0 ? '… ' : '';
  const suffix = end < words.length ? ' …' : '';
  return `${prefix}${slice}${suffix}`;
}
