import type { Adapter } from '../types';
import { crawlForDocuments } from '../html-crawl';

/**
 * Taktak.is.
 *
 * Iceland's construction industry knowledge base. Content is a mix of PDF
 * guides and long-form HTML articles. We treat article pages themselves as
 * "documents" (candidate.url is the article URL), and let the runner extract
 * text from the HTML for analysis.
 *
 * Article URLs follow patterns like /grein/ or /leidbeining/ — we tighten the
 * document-page heuristic to those subtrees so we don't accidentally import
 * category listing pages.
 */
const taktak: Adapter = {
  slug: 'taktak',
  name: 'Taktak',

  async *discover(ctx) {
    const seedUrls = ctx.config.seed_urls ?? ['https://taktak.is'];

    yield* crawlForDocuments(ctx, {
      seedUrls,
      allowHosts: ctx.config.allow_hosts ?? ['taktak.is', 'www.taktak.is'],
      denyPatterns: ['/tag/', '/category/', '/author/', '/wp-json/', '/feed/'],
      maxDepth: 2,

      // Treat certain URL shapes as "the page IS the document"
      isDocumentPage: (url) =>
        /\/grein\//.test(url) || /\/leidbeining\//.test(url) || /\/handbok\//.test(url),

      hintFromAnchor: (text) => ({
        titleHint: text.trim() || undefined,
        language: 'is',
      }),
    });
  },
};

export default taktak;
