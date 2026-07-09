import type { Adapter } from '../types';
import { crawlForDocuments } from '../html-crawl';

/**
 * Svanurinn.is · Nordic Swan Ecolabel.
 *
 * Publishes environmental criteria for building products and services. The
 * useful documents are the criteria PDFs ("Kröfur til …") and background
 * reports. Their structure is criteria-focused: /vorur/ (products), /bygging/
 * (construction), etc.
 */
const svanurinn: Adapter = {
  slug: 'svanurinn',
  name: 'Svanurinn',

  async *discover(ctx) {
    const seedUrls = ctx.config.seed_urls ?? ['https://svanurinn.is'];

    yield* crawlForDocuments(ctx, {
      seedUrls,
      allowHosts: ctx.config.allow_hosts ?? ['svanurinn.is', 'www.svanurinn.is'],
      denyPatterns: ['/en/', '/frettir/', '/starf/', '/hafa-samband/'],
      maxDepth: 2,
      hintFromAnchor: (text) => ({
        titleHint: text.trim() || undefined,
        documentType: /kröfur|criteria/i.test(text) ? 'leidbeining' : 'handbok',
        language: 'is',
      }),
    });
  },
};

export default svanurinn;
