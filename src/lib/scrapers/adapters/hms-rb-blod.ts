import { createClient } from '@prismicio/client';
import type { Client, PrismicDocument } from '@prismicio/client';
import type { DiscoveredDoc, ScraperAdapter, ScraperContext } from '../types';

/**
 * HMS Rb-leiðbeiningablöð (via Prismic Content API).
 *
 * hms.is is a Next.js + Prismic-headless-CMS site. The public listing page
 * (utgafusafn-rb) is entirely JavaScript-rendered — an HTML/Cheerio crawler
 * sees an empty table. Rather than run a headless browser, we go straight to
 * Prismic's public Content API, which returns clean structured JSON: title,
 * tags, a version/date field, and a direct PDF link for every Rb blað.
 *
 * The Prismic repository name is `hms-web` (visible in image URLs on hms.is:
 * `images.prismic.io/hms-web/…`). Public repositories don't need an access
 * token to query the master ref.
 *
 * VERIFIED against the live repo (381 documents, checked 2026-07-09 — see
 * field-path notes below). Custom type is `document`, not the `Rb-blöð`
 * hyphenated string originally assumed:
 *
 *   • Tag is exactly "RB Blöð" (space, title case) — NOT "Rb-blöð". Querying
 *     "Rb-blöð" (the old default) matched only 3 unrelated narrative articles
 *     of a different custom type ("monthly_report") that happened to carry a
 *     stray legacy tag of that spelling — not the actual archive.
 *   • doc.type === "document" for every real Rb blað. Tag-only search (no
 *     type filter) returns 400 docs; only 381 of those are type "document"
 *     with the schema below — the other 19 are unrelated content tagged
 *     "RB Blöð" by mistake elsewhere on the site. We filter by type as a
 *     defensive guard after the tag query.
 *   • doc.uid is always null for this type — do NOT use it as a fallback key
 *     (the original `HMS-{uid}` fallback would produce "HMS-null" for every
 *     document). Use doc.id (Prismic's globally unique id) instead.
 *   • data.title — rich text (heading1), e.g. "Ljósvist - almenn atriði".
 *   • data.date — plain string field, already "YYYY-MM-DD". Not rich text.
 *   • data.version — free-text field, present on ~most docs, absent (null)
 *     on some. Two rough shapes seen: "<chapter> / <number>" (e.g.
 *     "31 / 104.2", "Yt4 / 005") and a bare legacy bulletin number (e.g.
 *     "78", "95"). The PDF itself prints this as "Númer: (99) 26 01 15" —
 *     confirmed by downloading and pdf-parsing a real file — so `version` is
 *     the genuine source_ref basis, not a title-embedded "Rb NN.NNN" code
 *     (0/381 titles matched that pattern; the doc titles are plain Icelandic
 *     phrases with no code in them at all).
 *   • data.file — Media link field, single well-typed object:
 *       { link_type: "Media", kind: "file", id, url, name, size }
 *     100% of the 381 documents have this field populated. No nesting, no
 *     per-custom-type variance — `data.file` is used directly. The generic
 *     recursive walker is kept only as a defensive fallback in case a future
 *     document uses a differently-named field.
 *   • No description/summary field exists on this custom type.
 *
 * Because this source gives us real category + title + tag data, discovered
 * docs come back with `categorySlug` populated where we have a confident tag
 * mapping — the runner skips the Claude categorizer entirely for this
 * adapter and inserts documents straight from this metadata (see runner.ts's
 * "structured" path).
 *
 * See: https://prismic.io/docs/content-api
 */

interface RbConfig {
  prismic_repo?: string;
  tag?: string;
  lang?: string;
  page_size?: number;
}

// RB-BOX category slugs (from categories seed migration), for reference:
//   steypa, einangrun, thok, burdarvirki, lagnir, rafmagn, brunavarnir,
//   hljodvist, vinnuvernd, umhverfismal
//
// Tag frequency across all 381 live "RB Blöð" documents (checked 2026-07-09),
// most → least common: Byggingarvörur(124), Byggingarhlutar(88),
// Verkþættir og þarfir(81), Sérrit(54), Timbur(29), Byggingartimbur(28),
// Hlutvörur(27), Steypa(27), Tré(24), "Þök, veggir og gólf"(23),
// Reynslublöð(23), Klæðningar(21), "Ýmsir byggingarhlutar"(21),
// "Hreinlætis-, hita-, og loftræstibúnaður"(20), "Áhrif vatns og vinda"(19),
// Flísar(17), Klæðning(17), Magnvörur(16), innréttingar(16), "Hljóð o.fl."(15),
// "Hljóð og hljómburður"(15), Hleðslusteinar(14), "Almennar þarfir"(13),
// Kröfur(13), ... Einangrun(6), Einangrunarefni(4), Burður(3), "Lóð og lagnir"(2),
// Steinsteypa(2), "raflagnir og rafbúnaður"(1).
//
// Most of that vocabulary classifies by *material/product type*
// (Byggingarvörur, Timbur, Flísar, Málningarvörur…) or is too generic
// (Byggingarhlutar, "Verkþættir og þarfir", Sérrit) to safely bucket into
// RB-BOX's *subject* categories — mapping those would guess wrong more often
// than it'd help, so they're deliberately left unmapped (categorySlug stays
// undefined; the doc still imports, just uncategorized). Only tags with an
// unambiguous, near-literal match to an existing category slug are mapped:
const PRISMIC_TAG_CATEGORY_MAP: Record<string, string> = {
  'Steypa': 'steypa',
  'Steinsteypa': 'steypa',
  'Einangrun': 'einangrun',
  'Einangrunarefni': 'einangrun',
  'Burður': 'burdarvirki',
  'Þök, veggir og gólf': 'thok', // compound tag (roofs+walls+floors) — best-effort, roofs named first
  'Hljóð o.fl.': 'hljodvist',
  'Hljóð og hljómburður': 'hljodvist',
  'Lóð og lagnir': 'lagnir',
  'Hreinlætis-, hita-, og loftræstibúnaður': 'lagnir', // sanitary/heating/ventilation — closest existing category
  'raflagnir og rafbúnaður': 'rafmagn',
};

/**
 * Prismic's link-to-media shape is stable across custom types:
 *   { link_type: "Media", kind: "file"|"document", url: "https://…", name: "foo.pdf" }
 * Verified: every real Rb blað has this at the top-level `data.file` field
 * (see module doc comment). Try that exact path first; fall back to a
 * recursive walk for resilience against future schema drift or a
 * differently-shaped document.
 */
function findPdfUrl(data: Record<string, unknown>): { url: string; name?: string } | null {
  const direct = data.file as Record<string, unknown> | undefined;
  if (direct && typeof direct === 'object' && typeof direct.url === 'string') {
    return { url: direct.url, name: typeof direct.name === 'string' ? direct.name : undefined };
  }
  return walkForPdfUrl(data);
}

function walkForPdfUrl(node: unknown): { url: string; name?: string } | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  if (typeof obj.url === 'string' && (/\.pdf(\?|$)/i.test(obj.url) || obj.link_type === 'Media')) {
    return { url: obj.url, name: typeof obj.name === 'string' ? obj.name : undefined };
  }

  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walkForPdfUrl(item);
        if (found) return found;
      }
    } else if (value && typeof value === 'object') {
      const found = walkForPdfUrl(value);
      if (found) return found;
    }
  }
  return null;
}

/** Prismic "Rich Text" fields are arrays of blocks. Flatten to plain text. */
function extractText(node: unknown): string | undefined {
  if (typeof node === 'string') return node;
  if (!Array.isArray(node)) return undefined;
  return node
    .map((block) => (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
      ? (block as { text: string }).text
      : ''))
    .filter(Boolean)
    .join(' ')
    .trim() || undefined;
}

/** Verified: data.title (rich text, heading1). Other keys kept as a fallback only. */
function extractTitle(data: Record<string, unknown>): string | undefined {
  for (const key of ['title', 'heading', 'name', 'nafn', 'titill']) {
    const text = extractText(data[key]);
    if (text) return text;
  }
  return undefined;
}

/** Verified: this custom type has no description/summary field. Kept as a harmless no-op fallback. */
function extractDescription(data: Record<string, unknown>): string | undefined {
  for (const key of ['description', 'summary', 'lysing', 'samantekt']) {
    const text = extractText(data[key]);
    if (text) return text;
  }
  return undefined;
}

// Matches the two `data.version` shapes seen live: "<chapter> / <number>"
// (e.g. "31 / 104.2", "Yt4 / 005") and a bare legacy bulletin number ("78").
const VERSION_SPLIT_RE = /^\s*([A-Za-zÁÉÍÓÚÝÞÆÖáéíóúýþæö0-9]+)\s*\/\s*(\d+(?:\.\d+)*)\s*$/;
const VERSION_BARE_RE = /^\s*(\d+)\s*$/;

/**
 * Derive a stable source_ref from `data.version`. Falls back to `HMS-{id}`
 * (Prismic's document id — uid is always null for this type, verified) when
 * version is missing or doesn't match either known shape.
 */
function deriveSourceRef(version: unknown, docId: string): string {
  if (typeof version === 'string' && version.trim()) {
    const split = VERSION_SPLIT_RE.exec(version);
    if (split) return `RB(${split[1]}).${split[2]}`;
    const bare = VERSION_BARE_RE.exec(version);
    if (bare) return `RB-Nr.${bare[1]}`;
  }
  return `HMS-${docId}`;
}

/** First doc tag (besides the discovery tag itself) that maps to a known category. */
function resolveCategorySlug(tags: string[]): string | undefined {
  for (const tag of tags) {
    const slug = PRISMIC_TAG_CATEGORY_MAP[tag];
    if (slug) return slug;
  }
  return undefined;
}

const hmsRbBlod: ScraperAdapter = {
  slug: 'hms-rb-blod',
  name: 'HMS · Rb-leiðbeiningablöð',

  async *discover(ctx: ScraperContext): AsyncIterable<DiscoveredDoc> {
    const config = ctx.config as RbConfig;
    const repo = config.prismic_repo ?? 'hms-web';
    const tag = config.tag ?? 'RB Blöð';
    const lang = config.lang ?? '*'; // '*' = all languages
    const pageSize = Math.min(config.page_size ?? 100, 100); // Prismic max is 100
    const maxYield = ctx.config.max_docs_per_run ?? 200;

    // Route Prismic's HTTP calls through the runner's polite fetcher, so the
    // 1 req/sec throttle, robots.txt check, and RB-BOX User-Agent all apply
    // exactly as they do for every other adapter.
    const client: Client<PrismicDocument> = createClient(repo, {
      fetch: ctx.fetch,
    });

    let allTagged: PrismicDocument[];
    try {
      allTagged = await client.getAllByTag(tag, {
        pageSize,
        lang: lang === '*' ? undefined : lang,
        orderings: ['document.first_publication_date desc'],
      });
    } catch (err) {
      ctx.log('error', `Prismic query failed: ${err instanceof Error ? err.message : String(err)}`, {
        repo,
        tag,
      });
      return;
    }

    // Verified: the tag alone also catches ~19 unrelated documents of other
    // custom types. Only "document" has the file/title/version/date schema
    // this adapter expects.
    const docs = allTagged.filter((d) => d.type === 'document');
    ctx.log(
      'info',
      `Prismic returned ${allTagged.length} documents tagged "${tag}" (${docs.length} of type "document")`,
    );

    let yielded = 0;
    for (const doc of docs) {
      if (ctx.signal.aborted) return;
      if (yielded >= maxYield) return;

      const data = doc.data as Record<string, unknown>;
      const pdf = findPdfUrl(data);
      if (!pdf) {
        ctx.log('warn', `No PDF field found on Prismic doc, skipping`, { id: doc.id });
        continue;
      }

      const title = extractTitle(data) ?? pdf.name?.replace(/\.[^.]+$/, '') ?? doc.id;
      const language: 'is' | 'en' = doc.lang?.startsWith('en') ? 'en' : 'is';
      const categorySlug = resolveCategorySlug(doc.tags ?? []);
      const sourceRef = deriveSourceRef(data.version, doc.id);
      const publishedAt = typeof data.date === 'string' && data.date
        ? data.date
        : doc.first_publication_date?.slice(0, 10);

      if (!categorySlug) {
        ctx.log(
          'warn',
          `No category mapping for tags [${(doc.tags ?? []).join(', ')}] — importing without a category`,
          { id: doc.id, sourceRef },
        );
      }

      const discovered: DiscoveredDoc = {
        url: pdf.url,
        sourceRef,
        title,
        categorySlug,
        structured: true, // every field above comes from the Prismic API, not content inference — never spend an AI call here
        language,
        tags: (doc.tags ?? []).filter((t) => t !== tag).map((t) => t.toLowerCase()),
        publishedAt,
        description: extractDescription(data),
        documentType: 'rb_blad',
      };

      yield discovered;
      yielded++;
    }
  },
};

export default hmsRbBlod;
