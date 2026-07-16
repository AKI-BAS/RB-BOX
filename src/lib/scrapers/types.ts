/**
 * Scraper framework types.
 *
 * The runner drives the pipeline (discover → fetch → sanity-check → store).
 * Adapters implement `discover`, which yields `DiscoveredDoc`s.
 *
 * Two discovery styles are supported:
 *   • Structured adapters (e.g. hms-rb-blod, backed by a CMS's content API)
 *     can populate `categorySlug` (and ideally `tags`/`description`). When a
 *     discovered doc carries a `categorySlug`, the runner treats it as
 *     self-describing and skips the Claude categorizer entirely.
 *   • Unstructured/crawler adapters (HTML link-following) generally can't
 *     know the category from a listing page — they leave `categorySlug`
 *     unset and the runner falls back to AI analysis, same as before.
 */

import type { Database } from '@/types/database';

export type Source = Database['public']['Tables']['sources']['Row'];

/** A document discovered by an adapter. */
export interface DiscoveredDoc {
  /** Absolute URL of the document (PDF, HTML page, etc.) */
  url: string;
  /**
   * Stable identifier for this doc within its source, independent of URL
   * (e.g. "RB(31).101", "HMS-abc123"). Used for dedup — a document with the
   * same (source_id, source_ref) is updated in place rather than
   * re-inserted, even if the underlying file URL changes. Also stored as
   * documents.reference_code when set.
   */
  sourceRef?: string;
  /** Pre-extracted title, if the adapter knows it without opening the doc. */
  title?: string;
  /**
   * Category slug the adapter is confident about (must match categories.slug).
   */
  categorySlug?: string;
  /**
   * Set by adapters whose metadata comes from a structured API (not content
   * inference) — e.g. a CMS content API that reliably supplies title/tags/
   * date for every doc, even when no `categorySlug` mapping was confident
   * enough to set. When true, the runner skips the Claude categorizer
   * entirely; the doc still imports (uncategorized if `categorySlug` is
   * unset) rather than spending an AI call on it.
   *
   * Unstructured/crawler adapters (HTML link-following, which only ever
   * knows a URL + anchor text) must leave this unset so the runner still
   * falls back to AI analysis for them.
   */
  structured?: boolean;
  /** Language hint if the adapter knows. */
  language?: 'is' | 'en';
  /** Free-text tags/keywords carried over from the source site, if any. */
  tags?: string[];
  /** ISO date if the listing page shows a publication date. */
  publishedAt?: string;
  /** Short description/summary, if the source provides one. */
  description?: string;
  /** Suggested document type. */
  documentType?: 'rb_blad' | 'leidbeining' | 'rannsokn' | 'handbok' | 'annad';
  /**
   * Canonical guidance/source page for this doc (e.g. the hms.is content
   * page), when it's distinct from `url` (the thing actually fetched for
   * hashing/content). Stored as documents.source_url.
   */
  guidanceUrl?: string;
  /**
   * Additional downloadable files referenced by this doc (e.g. PDFs linked
   * from a guidance page's body) — becomes the document_files "Downloads"
   * list. The runner decides self-hosted vs external per link based on host.
   */
  pdfLinks?: Array<{ url: string; label?: string }>;
  /**
   * Pre-extracted body text for adapters whose content is rich-text/HTML
   * rather than a PDF (e.g. a Prismic slice body) — the runner uses this in
   * place of PDF-parsed text for categorization, the thin-content gate, and
   * documents.extracted_text when present, skipping pdf-parse entirely.
   */
  bodyText?: string;
}

/** @deprecated use DiscoveredDoc — kept as an alias so older adapter code keeps compiling. */
export type Candidate = DiscoveredDoc;

/**
 * Provenance for how a document's categories were decided — stored verbatim
 * in documents.categorization. One record per document, covering whichever
 * path actually won (explicit tag rule → keyword match → AI → manual).
 */
export interface Categorization {
  method: 'rule' | 'keyword' | 'ai' | 'manual';
  /** Raw source tags the doc carried (adapter tags, or empty for AI-only sources). */
  source_tags: string[];
  /** Every rule/keyword hit that contributed a category, in priority/weight order. */
  matched: Array<{ rule?: string; keyword?: string; category_slug: string }>;
  confidence: number;
  rationale: string;
}

/** Config stored in `sources.scrape_config` (jsonb). */
export interface ScrapeConfig {
  /** URLs the adapter should start crawling from. */
  seed_urls?: string[];
  /** Only follow links to these hosts (defense-in-depth against runaway crawls). */
  allow_hosts?: string[];
  /** Skip URLs matching any of these regex patterns. */
  deny_patterns?: string[];
  /** Cap on new documents ingested per run. Default 50. */
  max_docs_per_run?: number;
  /** Max crawl depth for HTML-following adapters. Default 2. */
  max_depth?: number;
  /** Adapter-specific extra config (e.g. Prismic repo/tag). Adapters cast this themselves. */
  [key: string]: unknown;
}

/** Runtime context passed to every adapter. */
export interface ScraperContext {
  /** The source row from the DB. */
  source: Source;
  /** Parsed config from source.scrape_config. */
  config: ScrapeConfig;
  /** Politeness-aware HTTP fetch. Handles UA, rate limit, robots.txt. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Structured logger — messages end up in scrape_runs.error_log if severity >= 'warn'. */
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void;
  /** Abort signal — respected by fetch and long-running loops. */
  signal: AbortSignal;
}

/** What every adapter exports. */
export interface ScraperAdapter {
  /** Must match sources.slug. */
  slug: string;
  /** Human name for logs. */
  name: string;
  /**
   * Whether the runner should cache this source's PDFs into Supabase
   * Storage (documents.file_path, and self-hosted document_files rows).
   * Defaults to true (existing behavior) when omitted. RB-BOX is a search/
   * discovery layer, not a document host — set this to false for a source
   * whose PDFs should be downloaded only long enough to extract text
   * (documents.extracted_text) and then discarded, with search results
   * deep-linking back to the source's own URL instead of a Storage copy.
   */
  cachesPdf?: boolean;
  /**
   * Yield discovered documents. The runner handles fetch/analyze/store per
   * doc, so adapters just need to walk the source's structure and emit
   * `DiscoveredDoc`s — with as much structured metadata as they can supply.
   */
  discover(ctx: ScraperContext): AsyncIterable<DiscoveredDoc>;
}

/** @deprecated use ScraperAdapter */
export type Adapter = ScraperAdapter;

/** Result of processing one discovered doc through the pipeline. */
export type CandidateResult =
  | { kind: 'added'; documentId: string }
  | { kind: 'updated'; documentId: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'error'; message: string };

/** Summary returned by the runner at the end of a run. */
export interface RunSummary {
  runId: string;
  status: 'ok' | 'partial' | 'error';
  discovered: number;
  added: number;
  updated: number;
  skipped: number;
  errors: number;
}
