/**
 * Scraper framework types.
 *
 * The runner drives the pipeline (discover → fetch → analyze → store).
 * Each adapter only needs to implement `discover`, which yields candidate
 * document URLs. Everything else is uniform across sources.
 */

import type { Database } from '@/types/database';

export type Source = Database['public']['Tables']['sources']['Row'];

/** A document URL discovered by an adapter. */
export interface Candidate {
  /** Absolute URL of the document (PDF, HTML page, etc.) */
  url: string;
  /** Optional pre-extracted title from the listing page. */
  titleHint?: string;
  /** Optional document reference code (e.g. "RB.31.101.03"). */
  externalId?: string;
  /** ISO date if the listing page shows a publication date. */
  publishedDate?: string;
  /** Language hint if the adapter knows. */
  language?: 'is' | 'en';
  /** Suggested document type. */
  documentType?: 'rb_blad' | 'leidbeining' | 'rannsokn' | 'handbok' | 'annad';
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
export interface Adapter {
  /** Must match sources.slug. */
  slug: string;
  /** Human name for logs. */
  name: string;
  /**
   * Yield candidate documents. The runner handles fetch/analyze/store per candidate,
   * so adapters just need to walk the source's structure and emit URLs.
   */
  discover(ctx: ScraperContext): AsyncIterable<Candidate>;
}

/** Result of processing one candidate through the pipeline. */
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
