import { createClient } from '@prismicio/client';
import type { Client, PrismicDocument } from '@prismicio/client';
import type { DiscoveredDoc, ScraperAdapter, ScraperContext } from '../types';
import { extractText, richTextToPlainText, collectAllPdfLinks } from './prismic-shared';

/**
 * HMS "web content" RB-blöð + LCA guidance pages (via Prismic Content API).
 *
 * Distinct from hms-rb-blod.ts (the PDF archive: type "document", tag
 * "RB Blöð") — this adapter covers rich-text/HTML-native pages that have no
 * single PDF file of their own:
 *
 *   • type "monthly_report", tag "Rb-blöð" (hyphenated, lowercase b — the
 *     legacy/small tag, NOT "RB Blöð" which the PDF archive uses). Verified
 *     2026-07-12: getByTag('Rb-blöð') across the whole repo returns exactly
 *     3 docs, all type monthly_report — newer RB-blöð-style reports HMS
 *     started publishing as web pages instead of PDFs.
 *   • type "content_page", tag "LCA", excluding anything also tagged
 *     "Hidden". Verified: 7 docs carry the LCA tag; 2 are "...---test"
 *     docs also tagged Hidden (excluded), leaving 5: the lifsferilsgreining
 *     overview page + its 4 sub-pages (leidbeiningar-lca, skilagatt-lca,
 *     spurt-og-svarad-lca, islensk-medaltalsgildi-lca).
 *
 * Neither custom type has Prismic's `url` field populated (no route
 * resolver configured on this repo) — the hms.is URL is CONSTRUCTED from
 * the known site structure, confirmed live for exactly one doc
 * (hms.is/skyrslur/rb_tveggja_threpa_thetting_skilgreining_og_virkni) and
 * assumed for the rest by pattern (hms.is/skyrslur/{uid} for monthly_report,
 * hms.is/lifsferilsgreining[/{uid}] for content_page). This is an
 * ASSUMPTION, not independently verified per-doc — worth a live spot-check
 * before trusting the resulting source_url/guidance links in production.
 *
 * Body text comes directly from the already-fetched Prismic API response's
 * `body` slice array — no live HTML fetch/parse needed, and hms.is is
 * client-rendered anyway (documented in hms-rb-blod.ts) so a bare fetch
 * wouldn't see the real content. PDF links embedded in that body (self-
 * hosted or external, e.g. an althingi.is regulation reference) are
 * collected via `pdfLinks`; the runner decides self-hosted-vs-external
 * per link and writes the document_files "Downloads" list.
 *
 * See: https://prismic.io/docs/content-api
 */

interface WebConfig {
  prismic_repo?: string;
  lang?: string;
  page_size?: number;
}

const RB_BLOD_WEB_TAG = 'Rb-blöð';
const LCA_TAG = 'LCA';
const HIDDEN_TAG = 'Hidden';

/** ASSUMPTION — see module comment. Only hms.is/skyrslur/{uid} has been live-verified. */
function buildGuidanceUrl(type: string, uid: string): string {
  if (type === 'monthly_report') return `https://hms.is/skyrslur/${uid}`;
  if (uid === 'lifsferilsgreining') return 'https://hms.is/lifsferilsgreining';
  return `https://hms.is/lifsferilsgreining/${uid}`;
}

function toDiscoveredDoc(doc: PrismicDocument): DiscoveredDoc | null {
  const data = (doc.data ?? {}) as Record<string, unknown>;
  const uid = doc.uid;
  // Both target types always carry a uid (unlike hms-rb-blod's "document"
  // type, where uid is verified always null) — used both for dedup and to
  // construct the guidance URL, so a doc without one can't be handled here.
  if (!uid) return null;

  const title = extractText(data.title) ?? uid;
  const bodyText = richTextToPlainText(data.body) || undefined;
  const guidanceUrl = buildGuidanceUrl(doc.type, uid);
  const pdfLinks = collectAllPdfLinks(data.body).map((l) => ({ url: l.url, label: l.name }));

  return {
    url: guidanceUrl,
    sourceRef: `HMS-WEB-${doc.id}`,
    title,
    structured: true,
    language: 'is',
    tags: doc.tags ?? [],
    publishedAt: doc.first_publication_date ? doc.first_publication_date.slice(0, 10) : undefined,
    documentType: 'leidbeining',
    guidanceUrl,
    pdfLinks: pdfLinks.length > 0 ? pdfLinks : undefined,
    bodyText,
  };
}

const hmsRbBlodWeb: ScraperAdapter = {
  slug: 'hms-rb-blod-web',
  name: 'HMS · RB-blöð (vefur) og lífsferilsgreining',

  async *discover(ctx: ScraperContext): AsyncIterable<DiscoveredDoc> {
    const config = ctx.config as WebConfig;
    const repo = config.prismic_repo ?? 'hms-web';
    const lang = config.lang ?? '*';
    const pageSize = Math.min(config.page_size ?? 100, 100);

    const client: Client<PrismicDocument> = createClient(repo, { fetch: ctx.fetch });

    let reportDocs: PrismicDocument[] = [];
    let lcaDocs: PrismicDocument[] = [];
    try {
      const page = await client.getByTag(RB_BLOD_WEB_TAG, {
        pageSize,
        lang: lang === '*' ? undefined : lang,
      });
      reportDocs = page.results;
    } catch (err) {
      ctx.log('error', `Prismic query failed (${RB_BLOD_WEB_TAG}): ${err instanceof Error ? err.message : String(err)}`, { repo });
    }
    try {
      const page = await client.getByTag(LCA_TAG, {
        pageSize,
        lang: lang === '*' ? undefined : lang,
      });
      lcaDocs = page.results;
    } catch (err) {
      ctx.log('error', `Prismic query failed (${LCA_TAG}): ${err instanceof Error ? err.message : String(err)}`, { repo });
    }

    const candidates = [
      ...reportDocs.filter((d) => d.type === 'monthly_report'),
      ...lcaDocs.filter((d) => d.type === 'content_page' && !(d.tags ?? []).includes(HIDDEN_TAG)),
    ];

    ctx.log(
      'info',
      `Prismic returned ${reportDocs.length} "${RB_BLOD_WEB_TAG}" + ${lcaDocs.length} "${LCA_TAG}" docs; ${candidates.length} after type/Hidden filtering`,
    );

    for (const doc of candidates) {
      if (ctx.signal.aborted) return;
      const discovered = toDiscoveredDoc(doc);
      if (discovered) yield discovered;
      else ctx.log('warn', `Skipped doc with no uid: ${doc.id}`, { type: doc.type });
    }
  },
};

export default hmsRbBlodWeb;
