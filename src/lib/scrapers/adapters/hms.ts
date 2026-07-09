import type { ScraperAdapter } from '../types';
import { crawlForDocuments } from '../html-crawl';

/**
 * HMS (Húsnæðis- og mannvirkjastofnun).
 *
 * The three seed URLs cover the main leiðbeiningar tracks:
 *   • General guidelines at the byggingarreglugerð
 *   • Fire safety (brunavarnir)
 *   • Universal design / accessibility (algild hönnun)
 *
 * hms.is is a Umbraco site — PDFs live under /media/ paths and are linked from
 * article pages by anchor text like "Leiðbeining 6.6.1 · Handbók brunahönnunar".
 * We use that anchor text as the title hint so Claude has good context even
 * before opening the PDF.
 */
const hms: ScraperAdapter = {
  slug: 'hms',
  name: 'Húsnæðis- og mannvirkjastofnun',

  async *discover(ctx) {
    const seedUrls = ctx.config.seed_urls ?? [];
    if (seedUrls.length === 0) {
      ctx.log('warn', 'HMS adapter: no seed_urls in scrape_config');
      return;
    }

    yield* crawlForDocuments(ctx, {
      seedUrls,
      allowHosts: ctx.config.allow_hosts ?? ['hms.is', 'www.hms.is'],
      denyPatterns: [
        // News, events, and org pages produce noise
        '/frettir/(?!.*\\.pdf$)',
        '/vidburdir/',
        '/starfsfolk/',
        '/um-hms/',
        // Language switcher / login
        '/en/',
        '/login',
      ],
      maxDepth: 2,
      hintFromAnchor: (text) => {
        const trimmed = text.trim();
        // Match reference codes like "6.6.1" or "Leiðbeining 6.6.1"
        const codeMatch = /(?:Leiðbeining\s+)?(\d+(?:\.\d+)+)/i.exec(trimmed);
        return {
          title: trimmed || undefined,
          sourceRef: codeMatch?.[1],
          documentType: /brunahönn|brunavarnir|brunatechni/i.test(trimmed)
            ? 'leidbeining'
            : 'leidbeining',
          language: 'is',
        };
      },
    });
  },
};

export default hms;
