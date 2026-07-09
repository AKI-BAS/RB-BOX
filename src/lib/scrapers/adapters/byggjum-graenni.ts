import type { ScraperAdapter } from '../types';
import { crawlForDocuments } from '../html-crawl';

/**
 * Byggjum grænni framtíð.
 *
 * Sustainability initiative. Guidelines are often HTML pages under numbered
 * paths like /4-10-leidbeiningar-um-abyrgt-nidurrif/. We treat any path that
 * matches the "digit-dash guideline" pattern as a document page (the whole
 * article gets imported and analyzed as text).
 */
const byggjumGraenni: ScraperAdapter = {
  slug: 'byggjum-graenni',
  name: 'Byggjum grænni framtíð',

  async *discover(ctx) {
    const seedUrls = ctx.config.seed_urls ?? ['https://byggjumgraenniframtid.is'];

    yield* crawlForDocuments(ctx, {
      seedUrls,
      allowHosts: ctx.config.allow_hosts ?? ['byggjumgraenniframtid.is', 'www.byggjumgraenniframtid.is'],
      denyPatterns: ['/wp-admin/', '/wp-login', '/tag/', '/category/', '/author/', '/feed/'],
      maxDepth: 2,

      // Pages whose slug starts with "N-N-…" (e.g. "4-10-leidbeiningar-…") are
      // the actual guideline documents on this site.
      isDocumentPage: (url) => /\/\d+-\d+-[a-z\-áéíóúýþæðö]+/i.test(new URL(url).pathname),

      hintFromAnchor: (text) => {
        const trimmed = text.trim();
        const codeMatch = /^(\d+[.\-]\d+)/.exec(trimmed);
        return {
          title: trimmed || undefined,
          sourceRef: codeMatch?.[1]?.replace('-', '.'),
          documentType: 'leidbeining',
          language: 'is',
        };
      },
    });
  },
};

export default byggjumGraenni;
