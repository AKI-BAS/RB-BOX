/**
 * Generic HTML-crawling helper.
 *
 * Every adapter that needs to walk HTML pages looking for document links can
 * use `crawlForDocuments`. It:
 *
 *   1. Starts from `seedUrls`
 *   2. Fetches each page (through the ctx's polite fetcher)
 *   3. Extracts links from the HTML
 *   4. Emits any link that looks like a document (PDF, DOCX, etc.) OR matches
 *      the caller's `isDocumentPage` predicate
 *   5. Enqueues in-domain HTML links for further crawling (bounded by maxDepth)
 *
 * The HTML parsing is deliberately simple regex-based — avoids adding
 * cheerio/parse5 as a dep. It handles the shape of real Icelandic government
 * and industry sites (WordPress, Umbraco, custom CMS) well enough. If a
 * specific source needs richer parsing, that adapter can implement its own
 * discover() instead of using this helper.
 */

import type { Candidate, ScraperContext } from './types';
import { looksLikeDocument, normalizeUrl, resolveUrl } from './fetch-utils';

interface CrawlOptions {
  seedUrls: string[];
  allowHosts?: string[];
  denyPatterns?: string[];
  maxDepth?: number;
  /** If the caller wants HTML pages themselves treated as documents. */
  isDocumentPage?: (url: string, html: string) => boolean;
  /** Extract a title hint + optional metadata from an HTML doc's anchor context. */
  hintFromAnchor?: (anchorText: string, href: string) => Partial<Candidate>;
}

const LINK_RE = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const OG_TITLE_RE = /<meta\b[^>]*\bproperty\s*=\s*["']og:title["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i;

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function hostMatches(url: string, allowHosts?: string[]): boolean {
  if (!allowHosts?.length) return true;
  try {
    const host = new URL(url).host.toLowerCase();
    return allowHosts.some((h) => host === h.toLowerCase() || host.endsWith('.' + h.toLowerCase()));
  } catch {
    return false;
  }
}

function pageTitle(html: string): string | undefined {
  const og = OG_TITLE_RE.exec(html);
  if (og) return stripTags(og[1]);
  const t = TITLE_RE.exec(html);
  if (t) return stripTags(t[1]);
  return undefined;
}

export async function* crawlForDocuments(
  ctx: ScraperContext,
  opts: CrawlOptions,
): AsyncIterable<Candidate> {
  const maxDepth = opts.maxDepth ?? 2;
  const denyRegexes = (opts.denyPatterns || []).map((p) => new RegExp(p, 'i'));
  const seen = new Set<string>();

  interface QueueItem { url: string; depth: number; }
  const queue: QueueItem[] = opts.seedUrls
    .map((u) => normalizeUrl(u))
    .map((url) => ({ url, depth: 0 }));

  const isDenied = (url: string): boolean => denyRegexes.some((r) => r.test(url));

  while (queue.length > 0) {
    if (ctx.signal.aborted) return;
    const item = queue.shift()!;
    if (seen.has(item.url)) continue;
    seen.add(item.url);

    if (!hostMatches(item.url, opts.allowHosts)) continue;
    if (isDenied(item.url)) continue;

    // A URL that directly looks like a document → emit as candidate, don't fetch as HTML
    if (looksLikeDocument(item.url)) {
      yield { url: item.url };
      continue;
    }

    let res: Response;
    try {
      res = await ctx.fetch(item.url);
    } catch (err) {
      ctx.log('warn', `Fetch failed while crawling: ${err instanceof Error ? err.message : err}`, { url: item.url });
      continue;
    }
    if (!res.ok) {
      ctx.log('debug', `HTTP ${res.status} at ${item.url}`);
      continue;
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('pdf')) {
      // Server-side content-type reveals this is a doc even if the URL didn't say so
      yield { url: item.url };
      continue;
    }
    if (!contentType.includes('html') && !contentType.includes('xhtml') && contentType !== '') {
      continue;
    }

    const html = await res.text();

    // If the caller says this whole HTML page IS a document (e.g. an article to import),
    // yield it once and don't extract child docs from it.
    if (opts.isDocumentPage?.(item.url, html)) {
      yield { url: item.url, titleHint: pageTitle(html) };
      continue;
    }

    // Extract links
    LINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LINK_RE.exec(html)) !== null) {
      const rawHref = match[1];
      const anchorHtml = match[2];
      const anchorText = stripTags(anchorHtml);

      // Skip anchor-only / mailto / javascript
      if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('mailto:') || rawHref.startsWith('tel:') || rawHref.startsWith('javascript:')) {
        continue;
      }

      const resolved = resolveUrl(rawHref, item.url);
      if (!resolved) continue;
      const nextUrl = normalizeUrl(resolved);
      if (seen.has(nextUrl)) continue;
      if (!hostMatches(nextUrl, opts.allowHosts)) continue;
      if (isDenied(nextUrl)) continue;

      if (looksLikeDocument(nextUrl)) {
        // Emit as a document candidate right away
        const hint = opts.hintFromAnchor?.(anchorText, nextUrl) ?? {};
        yield {
          url: nextUrl,
          titleHint: anchorText || hint.titleHint,
          ...hint,
        };
        seen.add(nextUrl);
        continue;
      }

      // HTML page: enqueue for further crawling if we still have depth
      if (item.depth < maxDepth) {
        queue.push({ url: nextUrl, depth: item.depth + 1 });
      }
    }
  }
}
