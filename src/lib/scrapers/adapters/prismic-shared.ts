/**
 * Helpers shared across HMS Prismic adapters (hms-rb-blod.ts, the PDF
 * archive; hms-rb-blod-web.ts, the web-native RB-blöð reports + LCA pages).
 */

/** Prismic "Rich Text" fields are arrays of blocks. Flatten to plain text. */
export function extractText(node: unknown): string | undefined {
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

/**
 * Flattens an arbitrarily-shaped Prismic value (a slice array, a single
 * rich-text field, whatever) into plain text for indexing/categorization.
 * Slice schemas vary per custom type and per slice_type, so this walks
 * generically rather than assuming a fixed shape — every string found under
 * a `text` key is collected, in document order. Skips link/id/url keys so
 * raw hrefs and media ids don't pollute the text index.
 */
export function richTextToPlainText(node: unknown): string {
  const parts: string[] = [];
  const SKIP_KEYS = new Set(['link', 'link_to', 'url', 'id', 'link_type', 'kind']);

  function walk(value: unknown) {
    if (!value) return;
    if (typeof value === 'string') return; // bare strings outside a `text` field are usually ids/slugs, not content
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (typeof obj.text === 'string' && obj.text.trim()) parts.push(obj.text.trim());
      for (const [key, val] of Object.entries(obj)) {
        if (SKIP_KEYS.has(key)) continue;
        walk(val);
      }
    }
  }

  walk(node);
  return parts.join('\n');
}

/**
 * Walks an arbitrarily-shaped Prismic value collecting EVERY PDF-looking
 * link — a Media-type file field, or any hyperlink whose url ends in
 * `.pdf` (e.g. an external regulation reference inside a rich-text
 * hyperlink span). Unlike a single-match "find the primary PDF" walker,
 * this is for building a document's full "Downloads" list.
 */
export function collectAllPdfLinks(
  node: unknown,
  seen: Set<string> = new Set(),
  out: Array<{ url: string; name?: string }> = [],
): Array<{ url: string; name?: string }> {
  if (!node || typeof node !== 'object') return out;
  const obj = node as Record<string, unknown>;

  if (typeof obj.url === 'string' && (/\.pdf(\?|$)/i.test(obj.url) || obj.link_type === 'Media')) {
    if (!seen.has(obj.url)) {
      seen.add(obj.url);
      out.push({ url: obj.url, name: typeof obj.name === 'string' ? obj.name : undefined });
    }
  }

  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) collectAllPdfLinks(item, seen, out);
    } else if (value && typeof value === 'object') {
      collectAllPdfLinks(value, seen, out);
    }
  }
  return out;
}
