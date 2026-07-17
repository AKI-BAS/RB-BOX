/**
 * Lightweight, migration-free typo tolerance ("Áttir þú við…?"). Builds a
 * vocabulary of known-good words client-side (category/tag names + document
 * titles, supplied by the caller) and, when a query word isn't in it, finds
 * the closest vocabulary word by Levenshtein distance. No new dependency and
 * no server round-trip beyond the data the caller already has/fetches.
 *
 * Icelandic letters (á, í, ý, ð, þ, æ, ö) are single UTF-16 code units in
 * JS strings (NFC-precomposed), so plain string indexing/comparison in the
 * distance function handles them the same as any other letter — the only
 * thing that needs to stay Icelandic-aware is the tokenizer's \p{L} class.
 */

const MIN_WORD_LEN = 3;

export function tokenizeVocab(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= MIN_WORD_LEN);
}

export function buildVocabulary(texts: Array<string | null | undefined>): Set<string> {
  const vocab = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const w of tokenizeVocab(text)) vocab.add(w);
  }
  return vocab;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Max edit distance worth suggesting, scaled to word length — a 1-char
 * typo in a short word is as significant as a 2-char typo in a long one. */
function maxDistanceFor(len: number): number {
  if (len <= 4) return 1;
  if (len <= 7) return 2;
  return 3;
}

function closestVocabWord(word: string, vocabulary: Set<string>): string | null {
  if (vocabulary.has(word)) return null; // already known — nothing to correct
  const maxDist = maxDistanceFor(word.length);
  let best: string | null = null;
  let bestDist = Infinity;
  for (const candidate of vocabulary) {
    if (Math.abs(candidate.length - word.length) > maxDist) continue;
    const dist = levenshtein(word, candidate);
    if (dist > 0 && dist <= maxDist && dist < bestDist) {
      bestDist = dist;
      best = candidate;
      if (dist === 1) break; // good enough, stop scanning
    }
  }
  return best;
}

/**
 * Given the raw query and a vocabulary of known-good words, return a
 * corrected query string if at least one word looks like a typo of a
 * vocabulary word, or null if nothing changed (query words are already
 * known, too short to judge, or no close-enough candidate exists).
 */
export function suggestCorrection(query: string, vocabulary: Set<string>): string | null {
  if (vocabulary.size === 0) return null;
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;

  let changed = false;
  const corrected = words.map((w) => {
    const clean = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (clean.length < MIN_WORD_LEN) return w;
    const match = closestVocabWord(clean, vocabulary);
    if (match) {
      changed = true;
      return match;
    }
    return w;
  });

  if (!changed) return null;
  const result = corrected.join(' ');
  return result.toLowerCase() === query.trim().toLowerCase() ? null : result;
}
