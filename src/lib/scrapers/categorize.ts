/**
 * Rule/keyword-based categorizer for structured docs (no AI).
 *
 * Precedence: explicit tag rule → keyword match → uncategorized (flagged for
 * manual review via an empty `matched` array + confidence 0).
 *
 * Both rule tables (category_tag_rules, category_keywords) are DB-driven —
 * loaded once per run by the caller — so tuning the mapping doesn't require
 * a deploy.
 */

import type { Categorization } from './types';

export interface TagRule {
  source_tag: string;
  category_slug: string;
  priority: number; // lower = higher confidence/primary
}

export interface KeywordRule {
  keyword: string;
  category_slug: string;
  weight: number; // higher = stronger signal
}

type Category = { id: string; slug: string; name: string; name_en: string | null };

export interface CategorizeInput {
  /** Raw tags from the source (adapter-provided, e.g. Prismic tags). */
  tags: string[];
  /** Document title, if known. */
  title?: string;
  /** Extracted text to scan for keywords (e.g. first chunk of pdf-parsed text). Optional. */
  text?: string;
  /**
   * A category slug the adapter is directly confident about, independent of
   * tag rules — folded into the tag-rule step at the highest priority (0).
   * No current adapter sets this; it's an escape hatch for a future one that
   * knows its category without needing a DB lookup.
   */
  explicitCategorySlug?: string;
}

export interface CategorizeResult {
  categorySlugs: string[]; // ordered, first = primary
  categoryIds: string[];   // same order, resolved to uuids
  categorization: Categorization;
}

const KEYWORD_MATCH_THRESHOLD = 2;
const KEYWORD_TEXT_SNIPPET_CHARS = 2000;
const KEYWORD_CONFIDENCE_NORMALIZER = 6; // heuristic: a score of 6+ maps to full confidence

function resolveCategoryIds(slugs: string[], categories: Category[]): string[] {
  return slugs
    .map((slug) => categories.find((c) => c.slug === slug)?.id)
    .filter((id): id is string => Boolean(id));
}

export function categorizeStructuredDoc(
  input: CategorizeInput,
  tagRules: TagRule[],
  keywordRules: KeywordRule[],
  categories: Category[],
): CategorizeResult {
  const normalizedTags = input.tags.map((t) => t.toLowerCase());

  // Step 1: explicit tag rules (+ the escape-hatch explicit slug, if any).
  const ruleMatches = new Map<string, { rule: string; priority: number }>();
  if (input.explicitCategorySlug) {
    ruleMatches.set(input.explicitCategorySlug, { rule: 'adapter-provided', priority: 0 });
  }
  for (const tag of normalizedTags) {
    for (const rule of tagRules) {
      if (rule.source_tag.toLowerCase() === tag) {
        const existing = ruleMatches.get(rule.category_slug);
        if (!existing || rule.priority < existing.priority) {
          ruleMatches.set(rule.category_slug, { rule: tag, priority: rule.priority });
        }
      }
    }
  }

  if (ruleMatches.size > 0) {
    const ordered = [...ruleMatches.entries()].sort((a, b) => a[1].priority - b[1].priority);
    const slugs = ordered.map(([slug]) => slug);
    return {
      categorySlugs: slugs,
      categoryIds: resolveCategoryIds(slugs, categories),
      categorization: {
        method: 'rule',
        source_tags: input.tags,
        matched: ordered.map(([slug, m]) => ({ rule: m.rule, category_slug: slug })),
        confidence: 1,
        rationale: `Matched ${ordered.length} categor${ordered.length === 1 ? 'y' : 'ies'} via explicit tag rule(s).`,
      },
    };
  }

  // Step 2: keyword fallback — scan title + tags + a text snippet.
  const haystack = [input.title, input.tags.join(' '), input.text?.slice(0, KEYWORD_TEXT_SNIPPET_CHARS)]
    .filter(Boolean)
    .join(' \n ')
    .toLowerCase();

  const scoreBySlug = new Map<string, number>();
  const hitsBySlug = new Map<string, string[]>();
  for (const kw of keywordRules) {
    const needle = kw.keyword.toLowerCase();
    if (needle && haystack.includes(needle)) {
      scoreBySlug.set(kw.category_slug, (scoreBySlug.get(kw.category_slug) ?? 0) + kw.weight);
      const hits = hitsBySlug.get(kw.category_slug) ?? [];
      hits.push(kw.keyword);
      hitsBySlug.set(kw.category_slug, hits);
    }
  }

  const passing = [...scoreBySlug.entries()].filter(([, score]) => score >= KEYWORD_MATCH_THRESHOLD);
  if (passing.length > 0) {
    passing.sort((a, b) => b[1] - a[1]); // highest accumulated weight first = primary
    const slugs = passing.map(([slug]) => slug);
    const maxScore = passing[0][1];
    return {
      categorySlugs: slugs,
      categoryIds: resolveCategoryIds(slugs, categories),
      categorization: {
        method: 'keyword',
        source_tags: input.tags,
        matched: passing.flatMap(([slug]) =>
          (hitsBySlug.get(slug) ?? []).map((keyword) => ({ keyword, category_slug: slug })),
        ),
        confidence: Math.min(1, maxScore / KEYWORD_CONFIDENCE_NORMALIZER),
        rationale: `Matched ${passing.length} categor${passing.length === 1 ? 'y' : 'ies'} via keyword scan (title/tags${input.text ? '/pdf text' : ''}).`,
      },
    };
  }

  // Step 3: nothing matched — leave uncategorized, flag for manual review.
  return {
    categorySlugs: [],
    categoryIds: [],
    categorization: {
      method: 'keyword',
      source_tags: input.tags,
      matched: [],
      confidence: 0,
      rationale: 'No tag rule or keyword match — needs manual categorization.',
    },
  };
}
