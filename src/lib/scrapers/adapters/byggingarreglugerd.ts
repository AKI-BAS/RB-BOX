import type { DiscoveredDoc, ScraperAdapter, ScraperContext } from '../types';

/**
 * Byggingarreglugerð 112/2012 — article ("grein") level ingestion via the
 * WordPress REST API.
 *
 * byggingarreglugerd.is is a JS-rendered WordPress/React site (a Cheerio
 * crawl of the rendered page sees nothing — the same class of problem HMS
 * had). The WP REST API bypasses that entirely, and — verified live,
 * checked 2026-07-17 — returns full article text in the LIST response
 * (`content.rendered` is the complete body, not a truncated excerpt), so
 * ingesting all ~440 greinar takes ~7 paginated requests total, not one
 * per article.
 *
 * VERIFIED endpoints (repo root, not the www subdomain the site itself
 * redirects rendered pages to):
 *   • https://byggingarreglugerd.is/wp-json/wp/v2/grein — the regulation
 *     text itself. Custom post type, 440 published items at check time.
 *   • https://byggingarreglugerd.is/wp-json/wp/v2/hlutar_og_kaflar — the
 *     Hluti/Kafli (Part/Chapter) taxonomy. 119 terms at check time.
 *     Two-level: parent=0 terms are Hluti (e.g. "10. Hollusta, heilsa og
 *     umhverfi"), parent=<hluti-term-id> terms are Kafli (e.g. "10.4.
 *     [Ljósvist og útsýni]" under hluti term id 74). Each grein carries
 *     exactly one Kafli term id in its own `hlutar_og_kaflar` field — the
 *     Hluti is derived by following that term's `parent`.
 *   • robots.txt: `Disallow: /api/*` only for `User-agent: *` — /wp-json/
 *     is unaffected, scraping it is allowed.
 *
 * The sitemap the orchestrator suggested (wp-sitemap.xml) 404s; the site's
 * own robots.txt instead points at https://www.byggingarreglugerd.is/
 * sitemap.xml (www, different path) — moot here since the REST API already
 * gives structured data directly, no need to discover URLs via a sitemap.
 *
 * Grein number (source_ref): NOT reliably parseable from the title (format
 * varies — some have "N.N.N. gr. Title", others just "N.N.N. Title") or
 * from a request URL path (there isn't one — the WP `link` field is a
 * QUERY-STRING url: "https://www.byggingarreglugerd.is/?hluti=10&kafli=4&
 * grein=6#table-of-contents"). Parsing hluti/kafli/grein from that query
 * string is the reliable path and doubles as the canonical external_url.
 *
 * Amendment date: there is no dedicated "amendment date" field. `date` is a
 * bulk-import timestamp (most entries share one of a handful of exact
 * timestamps from when this WP site was built) and useless as a signal;
 * `modified` (per-entry, varies) is the best available proxy — used as
 * published_date, with this caveat documented rather than presented as
 * precise. Actual amendment citations (e.g. "Rgl. nr. 11/2026, 6. gr.")
 * appear only as inline footnote links inside the body HTML, not as a
 * separate structured field.
 *
 * Some titles/kafli names are wrapped in a leading "[" (occasionally an
 * unclosed bracket spanning into the body) — an Icelandic legal-drafting
 * convention marking text inserted by a later amendment. Stripped for
 * display; the underlying amendment fact isn't otherwise modeled here.
 */

const WP_API_BASE = 'https://byggingarreglugerd.is/wp-json/wp/v2';
const MAX_PAGE_SIZE = 100;

interface ByggingarreglugerdConfig {
  page_size?: number;
}

interface WpTerm {
  id: number;
  name: string;
  parent: number;
}

interface WpGrein {
  id: number;
  link: string;
  title: { rendered: string };
  content: { rendered: string };
  excerpt: { rendered: string };
  modified: string;
  date: string;
  hlutar_og_kaflar?: number[];
}

/** A handful of named/numeric HTML entities that actually show up in this
 * site's content — not a general-purpose decoder, just enough for Icelandic
 * prose + WordPress's typographic substitutions (curly quotes, en/em dash). */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#8216;|&#8217;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&#038;/g, '&')
    .replace(/&hellip;/g, '…');
}

function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip a leading amendment-bracket "[" and any leading "N.N.N.", "N.N.N.
 * gr." style number prefix — the number is reconstructed from the URL
 * instead (reliable), so the raw text prefix is redundant and inconsistent. */
function cleanTitleText(rawTitle: string): string {
  const decoded = decodeEntities(rawTitle).trim();
  return decoded
    .replace(/^\[/, '')
    .replace(/^\d+(?:\.\d+){1,3}\.?\s*(?:gr\.)?\s*/i, '')
    .trim();
}

function cleanTermName(rawName: string): string {
  return decodeEntities(rawName)
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/^\d+(?:\.\d+){0,2}\.?\s*/, '')
    .trim();
}

function parseGreinRef(link: string): { hluti: string; kafli: string; grein: string } | null {
  try {
    const url = new URL(link);
    const hluti = url.searchParams.get('hluti');
    const kafli = url.searchParams.get('kafli');
    const grein = url.searchParams.get('grein');
    if (!hluti || !kafli || !grein) return null;
    return { hluti, kafli, grein };
  } catch {
    return null;
  }
}

async function fetchAllPaged<T>(
  ctx: ScraperContext,
  endpoint: string,
  pageSize: number,
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  while (true) {
    if (ctx.signal.aborted) return all;
    const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=${pageSize}&page=${page}`;
    const res = await ctx.fetch(url);
    if (!res.ok) {
      ctx.log('warn', `WP REST fetch HTTP ${res.status}`, { url });
      break;
    }
    const batch = (await res.json()) as T[];
    all.push(...batch);
    const totalPages = Number(res.headers.get('x-wp-totalpages') ?? '1');
    if (batch.length < pageSize || page >= totalPages) break;
    page++;
  }
  return all;
}

const byggingarreglugerd: ScraperAdapter = {
  slug: 'byggingarreglugerd',
  name: 'Byggingarreglugerð',
  // HTML-native regulation text, not PDFs — there's nothing to self-host in
  // the first place, but set explicitly for the same reason HMS does: RB-BOX
  // is a search/discovery layer, not a document host.
  cachesPdf: false,

  async *discover(ctx: ScraperContext): AsyncIterable<DiscoveredDoc> {
    const config = ctx.config as ByggingarreglugerdConfig;
    const pageSize = Math.min(config.page_size ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);

    const terms = await fetchAllPaged<WpTerm>(ctx, `${WP_API_BASE}/hlutar_og_kaflar`, pageSize);
    if (ctx.signal.aborted) return;
    const termById = new Map<number, WpTerm>(terms.map((t) => [t.id, t]));
    ctx.log('info', `Loaded ${terms.length} hlutar_og_kaflar (Hluti/Kafli) terms`);

    const greinar = await fetchAllPaged<WpGrein>(
      ctx,
      `${WP_API_BASE}/grein?orderby=id&order=asc`,
      pageSize,
    );
    ctx.log('info', `WP REST returned ${greinar.length} grein posts`);

    const maxYield = ctx.config.max_docs_per_run ?? 500;
    let yielded = 0;

    for (const doc of greinar) {
      if (ctx.signal.aborted) return;
      if (yielded >= maxYield) return;

      const ref = parseGreinRef(doc.link);
      if (!ref) {
        ctx.log('warn', `Grein ${doc.id} has no parseable hluti/kafli/grein in its link — skipped`, { link: doc.link });
        continue;
      }
      const { hluti, kafli, grein } = ref;
      const sourceRef = `${hluti}.${kafli}.${grein}`;

      const kafliTermId = doc.hlutar_og_kaflar?.[0];
      const kafliTerm = kafliTermId !== undefined ? termById.get(kafliTermId) : undefined;
      const hlutiTerm = kafliTerm ? termById.get(kafliTerm.parent) : undefined;
      const kafliName = kafliTerm ? cleanTermName(kafliTerm.name) : undefined;
      const hlutiName = hlutiTerm ? cleanTermName(hlutiTerm.name) : undefined;

      const bodyText = stripHtml(doc.content.rendered);
      const title = `${sourceRef}. ${cleanTitleText(doc.title.rendered)}`.trim();
      const description = stripHtml(doc.excerpt.rendered).replace(/\s*\[…\]\s*$/, '').trim() || undefined;

      // Ltree-style path (stored as a plain string in metadata, not a real
      // Postgres ltree column — no schema change needed). Each level is
      // cumulatively qualified (hluti_10.kafli_10_4.grein_10_4_6) rather
      // than bare numbers, since a bare kafli number ("kafli_4") isn't
      // unique across different hlutar and would collide in the path.
      const ltreePath = `byggingarreglugerd.hluti_${hluti}.kafli_${hluti}_${kafli}.grein_${hluti}_${kafli}_${grein}`;

      const discovered: DiscoveredDoc = {
        url: doc.link,
        sourceRef,
        title,
        structured: true,
        language: 'is',
        tags: [hlutiName, kafliName].filter((t): t is string => Boolean(t)).map((t) => t.toLowerCase()),
        // Best available proxy for an amendment date — see module doc
        // comment. `modified` reflects the last CMS content edit, which
        // correlates with (but isn't a precise citation of) real amendments.
        publishedAt: (doc.modified || doc.date)?.slice(0, 10),
        description,
        documentType: 'leidbeining',
        bodyText,
        adapterMeta: {
          hluti,
          kafli,
          grein,
          hluti_name: hlutiName ?? null,
          kafli_name: kafliName ?? null,
          ltree_path: ltreePath,
          wp_id: doc.id,
          wp_modified: doc.modified,
        },
      };

      yield discovered;
      yielded++;
    }
  },
};

export default byggingarreglugerd;
