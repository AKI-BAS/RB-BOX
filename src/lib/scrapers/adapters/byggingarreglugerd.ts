import type { Adapter } from '../types';
import { crawlForDocuments } from '../html-crawl';

/**
 * Byggingarreglugerð · Leiðbeiningagátt.
 *
 * The leiðbeiningagátt at /leidbeiningagatt is the canonical index of every
 * leiðbeining tied to the 112/2012 building regulation. The site links each
 * guideline as a PDF, usually with the reference code embedded in the anchor
 * text (e.g. "6.7.5 · Loftræsting íbúða").
 *
 * We only walk within the /leidbeiningagatt subtree to keep the crawl focused.
 */
const byggingarreglugerd: Adapter = {
  slug: 'byggingarreglugerd',
  name: 'Byggingarreglugerð',

  async *discover(ctx) {
    const seedUrls = ctx.config.seed_urls ?? ['https://www.byggingarreglugerd.is/leidbeiningagatt'];

    yield* crawlForDocuments(ctx, {
      seedUrls,
      allowHosts: ctx.config.allow_hosts ?? ['byggingarreglugerd.is', 'www.byggingarreglugerd.is'],
      denyPatterns: ['/wp-admin/', '/wp-login', '/feed/', '/tag/', '/author/'],
      maxDepth: 3,
      hintFromAnchor: (text) => {
        const trimmed = text.trim();
        // Reference codes on this site are the standard §X.Y.Z form
        const codeMatch = /^\s*(\d+(?:\.\d+){1,3})/.exec(trimmed);
        return {
          titleHint: trimmed || undefined,
          externalId: codeMatch?.[1],
          documentType: 'leidbeining',
          language: 'is',
        };
      },
    });
  },
};

export default byggingarreglugerd;
