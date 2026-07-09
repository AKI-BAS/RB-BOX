import type { Adapter, Candidate, ScraperContext } from '../types';

/**
 * HMS Rb-leiðbeiningablöð (via Prismic API).
 *
 * hms.is is a Next.js + Prismic-headless-CMS site. The public listing pages
 * are entirely JavaScript-rendered — HTML crawlers see an empty shell. Rather
 * than fight that with a headless browser, we go straight to the underlying
 * data source: Prismic's public REST API. It:
 *
 *   • Returns clean JSON with all document metadata
 *   • Allows 200 req/sec (vs. the front-end's aggressive rate-limiting)
 *   • Provides publication dates, categories (tags), and direct PDF URLs
 *
 * The Prismic repository name is `hms-web` (visible in image URLs on hms.is:
 * `images.prismic.io/hms-web/…`). Public repositories don't need an access
 * token for master-ref queries.
 *
 * See: https://prismic.io/docs/content-api
 */

interface PrismicApiMeta {
  refs: Array<{ id: string; ref: string; label: string; isMasterRef?: boolean }>;
  tags: string[];
  types: Record<string, string>;
}

interface PrismicDoc {
  id: string;
  uid?: string;
  url?: string | null;
  type: string;
  href: string;
  tags: string[];
  first_publication_date: string;
  last_publication_date: string;
  slugs: string[];
  lang: string;
  data: Record<string, unknown>;
}

interface PrismicSearchResult {
  page: number;
  results_per_page: number;
  results_size: number;
  total_results_size: number;
  total_pages: number;
  next_page: string | null;
  prev_page: string | null;
  results: PrismicDoc[];
}

/**
 * Walk arbitrary Prismic data looking for a Media field whose URL points at
 * a PDF. Prismic's file-link shape is stable across all content types:
 *   { link_type: "Media", kind: "document", url: "https://…", name: "foo.pdf" }
 * So we recurse into the doc.data tree and pluck the first match.
 */
function findPdfUrl(node: unknown): { url: string; name?: string } | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  if (
    obj.link_type === 'Media' &&
    typeof obj.url === 'string' &&
    /\.pdf(\?|$)/i.test(obj.url)
  ) {
    return { url: obj.url, name: typeof obj.name === 'string' ? obj.name : undefined };
  }

  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findPdfUrl(item);
        if (found) return found;
      }
    } else if (value && typeof value === 'object') {
      const found = findPdfUrl(value);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Prismic "Rich Text" fields are arrays of blocks. Flatten to plain text.
 * Also handles the simple case where a title is just a string.
 */
function extractText(node: unknown): string | undefined {
  if (typeof node === 'string') return node;
  if (!Array.isArray(node)) return undefined;
  return node
    .map((block: any) => (typeof block?.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join(' ')
    .trim() || undefined;
}

/** Find the best title candidate from a Prismic doc's data blob. */
function extractTitle(data: Record<string, unknown>): string | undefined {
  // Prismic UIs commonly name it "title", "name", or "heading" — try each
  for (const key of ['title', 'heading', 'name', 'nafn', 'titill']) {
    const text = extractText(data[key]);
    if (text) return text;
  }
  return undefined;
}

async function fetchMasterRef(ctx: ScraperContext, apiRoot: string): Promise<string | null> {
  const res = await ctx.fetch(apiRoot);
  if (!res.ok) {
    ctx.log('warn', `Prismic API meta returned HTTP ${res.status}`, { url: apiRoot });
    return null;
  }
  const meta = (await res.json()) as PrismicApiMeta;
  const master = meta.refs.find((r) => r.isMasterRef) ?? meta.refs.find((r) => r.id === 'master');
  if (!master) {
    ctx.log('warn', 'No master ref found in Prismic API meta');
    return null;
  }
  return master.ref;
}

const hmsRbBlod: Adapter = {
  slug: 'hms-rb-blod',
  name: 'HMS · Rb-leiðbeiningablöð',

  async *discover(ctx) {
    interface RbConfig {
      prismic_repo?: string;
      tag?: string;
      lang?: string;
      page_size?: number;
    }
    const config = ctx.config as RbConfig;

    const repo = config.prismic_repo ?? 'hms-web';
    const apiRoot = `https://${repo}.cdn.prismic.io/api/v2`;
    const tag = config.tag ?? 'Rb-blöð';
    const lang = config.lang ?? '*'; // '*' = all languages
    const pageSize = Math.min(config.page_size ?? 100, 100); // Prismic max is 100

    // Step 1: fetch master ref (required for every query)
    const ref = await fetchMasterRef(ctx, apiRoot);
    if (!ref) return;

    // Step 2: paginated query filtered by tag
    // Query shape (unencoded): [[at(document.tags,["Rb-blöð"])]]
    const predicate = `[[at(document.tags,["${tag}"])]]`;
    let page = 1;
    let totalYielded = 0;
    const maxYield = ctx.config.max_docs_per_run ?? 200;

    while (true) {
      if (ctx.signal.aborted) return;

      const url = new URL(`${apiRoot}/documents/search`);
      url.searchParams.set('ref', ref);
      url.searchParams.set('q', predicate);
      url.searchParams.set('pageSize', String(pageSize));
      url.searchParams.set('page', String(page));
      if (lang !== '*') url.searchParams.set('lang', lang);
      url.searchParams.set(
        'orderings',
        '[document.first_publication_date desc]',
      );

      const res = await ctx.fetch(url.toString());
      if (!res.ok) {
        ctx.log('warn', `Prismic search HTTP ${res.status}`, { url: url.toString() });
        return;
      }
      const result = (await res.json()) as PrismicSearchResult;

      if (page === 1) {
        ctx.log(
          'info',
          `Prismic returned ${result.total_results_size} Rb blöð across ${result.total_pages} pages`,
        );
      }

      for (const doc of result.results) {
        if (ctx.signal.aborted) return;
        if (totalYielded >= maxYield) return;

        // The document may point at a PDF (the actual RB blað file), or it
        // may be a container page describing the sheet. Prefer the PDF.
        const pdf = findPdfUrl(doc.data);
        const title = extractTitle(doc.data) ?? doc.uid ?? doc.slugs[0];
        const language: 'is' | 'en' = doc.lang?.startsWith('en') ? 'en' : 'is';

        const candidate: Candidate = {
          url: pdf?.url ?? new URL(doc.url ?? `/${doc.slugs[0] ?? doc.uid ?? ''}`, 'https://hms.is').toString(),
          titleHint: pdf?.name?.replace(/\.[^.]+$/, '') || title,
          externalId: doc.uid,
          publishedDate: doc.first_publication_date?.slice(0, 10),
          documentType: 'rb_blad',
          language,
        };

        yield candidate;
        totalYielded++;
      }

      if (!result.next_page || result.results.length === 0 || page >= result.total_pages) break;
      page++;
    }
  },
};

export default hmsRbBlod;
