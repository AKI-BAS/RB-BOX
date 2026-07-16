/**
 * The scraper runner.
 *
 * Given a source, drives the pipeline end-to-end:
 *   1. Create a scrape_runs row (status='running')
 *   2. Look up the adapter for source.slug
 *   3. Iterate adapter.discover() → for each DiscoveredDoc:
 *      a. Skip if scrape_queue already has this URL for this source
 *      b. Insert scrape_queue row (status='pending')
 *      c. Fetch the URL, compute content_hash
 *      d. If content_hash matches an existing document → skip
 *      e. If the doc carries a `source_ref` and a document with the same
 *         (source_id, source_ref) already exists and is unchanged → skip
 *      f. If PDF, run pdf-parse once — feeds both the sanity check (< 200
 *         chars forces status='pending_review' regardless of source trust)
 *         and the keyword categorizer below.
 *      g. Resolve categories + provenance:
 *           - If the adapter marked the doc `structured` (metadata came from
 *             a CMS API, not content inference): run the DB-driven
 *             categorizer (explicit tag rule → keyword match → uncategorized)
 *             on the doc's tags/title/pdf-text. No Claude call, regardless of
 *             whether anything actually matched.
 *           - Otherwise (an unstructured HTML-crawl doc with only a URL/title
 *             hint): fall back to analyzeDocument (Claude).
 *         Either way, a `categorization` record is built recording which
 *         path won and why.
 *      h. If PDF, upload to Storage; if HTML, store extracted text only
 *      i. Upsert the documents row (insert new, or update in place if a
 *         source_ref match existed) — status='published' if
 *         source.auto_publish else 'pending_review'. A doc with ZERO
 *         resolved categories is always forced to 'pending_review' even on
 *         an auto_publish source — an uncategorized doc in the main library
 *         can't be found by subject and isn't worth showing yet. The admin
 *         UI (src/app/admin/documents) lists these as "Unsorted" (status
 *         pending_review + no document_categories rows) so they can be
 *         found and manually categorized.
 *      j. Sync document_categories from the resolved category ids (multiple
 *         rows per doc are normal now — first in `categorySlugs` is primary).
 *      k. Update scrape_queue.status='imported', link document_id.
 *   4. Update source.last_scraped_at
 *   5. Update scrape_runs with final tallies
 *
 * AI usage: analyzeDocument (Claude) is now only invoked for docs an adapter
 * *can't* self-describe — i.e. crawler adapters that only know a URL/anchor
 * text. Structured adapters (Prismic-backed hms-rb-blod, and any future
 * adapter that marks its docs `structured: true`) skip it entirely,
 * regardless of whether a category ended up resolved. The contributor
 * upload flow (`/api/admin/categorize`) is unaffected — it's a separate code
 * path that never went through this runner.
 *
 * Multi-attachment docs (documents.source_url + document_files): an adapter
 * can supply `guidanceUrl` (a canonical HTML source page, stored as
 * documents.source_url — distinct from `url`/external_url, the thing
 * actually fetched), `bodyText` (pre-extracted rich text used in place of
 * pdf-parse for text-only content), and `pdfLinks` (PDFs referenced by that
 * content). Each pdfLink is self-hosted (downloaded + uploaded to Storage)
 * if it's on hms.is/Prismic's CDN, else kept as an external link — synced
 * into document_files the same way categories are synced, and skipped
 * entirely when metadata.admin_override.locked is set.
 */

import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/types/database';
import type { Categorization, DiscoveredDoc, RunSummary, ScrapeConfig, ScraperContext, Source } from './types';
import { getAdapter } from './registry';
import { politeFetch, contentHash, normalizeUrl, looksLikeDocument } from './fetch-utils';
import { analyzeDocument } from './analyze';
import { categorizeStructuredDoc, type KeywordRule, type TagRule } from './categorize';

const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'documents';
const MIN_PDF_TEXT_CHARS = 200;
// Sane upper bound so a pathological PDF can't blow up row size — comfortably
// above any normal RB-blað's text length.
const MAX_EXTRACTED_TEXT_CHARS = 200_000;

/**
 * documents.source_url and document_files are additive schema (see
 * 20260709080000_document_files.sql) that may not be applied to a given
 * environment yet. Rather than hard-require it, probe once per process and
 * degrade gracefully: omit source_url from writes and skip document_files
 * sync entirely until the migration lands — no redeploy needed once it
 * does, the next scrape run's probe just picks it up. Without this, EVERY
 * source's insert/update would fail (not just this feature's), since
 * rowFields would reference a column that doesn't exist.
 */
let schemaCapsCache: { hasSourceUrl: boolean; hasDocumentFiles: boolean } | null = null;

async function detectSchemaCapabilities(
  supabase: ReturnType<typeof createAdminClient>,
): Promise<{ hasSourceUrl: boolean; hasDocumentFiles: boolean }> {
  if (schemaCapsCache) return schemaCapsCache;
  const [sourceUrlProbe, filesProbe] = await Promise.all([
    supabase.from('documents').select('source_url').limit(1),
    supabase.from('document_files').select('id').limit(1),
  ]);
  schemaCapsCache = {
    hasSourceUrl: !sourceUrlProbe.error,
    hasDocumentFiles: !filesProbe.error,
  };
  return schemaCapsCache;
}

type Category = { id: string; slug: string; name: string; name_en: string | null };

interface RulesBundle {
  categories: Category[];
  tagRules: TagRule[];
  keywordRules: KeywordRule[];
}

async function loadRules(supabase: ReturnType<typeof createAdminClient>): Promise<RulesBundle> {
  const [{ data: categories }, { data: tagRules }, { data: keywordRules }] = await Promise.all([
    supabase.from('categories').select('id, slug, name, name_en'),
    supabase.from('category_tag_rules').select('source_tag, category_slug, priority'),
    supabase.from('category_keywords').select('keyword, category_slug, weight'),
  ]);
  return {
    categories: categories || [],
    tagRules: tagRules || [],
    keywordRules: keywordRules || [],
  };
}

interface RunOptions {
  sourceId: string;
  trigger: 'cron' | 'manual';
  triggeredBy?: string;
  /** Abort the run early if this promise resolves. */
  signal?: AbortSignal;
}

export async function runScrape(opts: RunOptions): Promise<RunSummary> {
  const supabase = createAdminClient();
  const signal = opts.signal ?? new AbortController().signal;

  // 1. Load source
  const { data: source, error: srcErr } = await supabase
    .from('sources')
    .select('*')
    .eq('id', opts.sourceId)
    .single();
  if (srcErr || !source) throw new Error(`Source not found: ${opts.sourceId}`);
  if (!source.is_active) throw new Error(`Source is inactive: ${source.slug}`);

  // 2. Adapter lookup
  const adapter = getAdapter(source.slug);
  if (!adapter) throw new Error(`No adapter registered for slug: ${source.slug}`);

  // 3. Create run row
  const { data: runRow, error: runErr } = await supabase
    .from('scrape_runs')
    .insert({
      source_id: source.id,
      trigger: opts.trigger,
      triggered_by: opts.triggeredBy ?? null,
      status: 'running',
    })
    .select('id')
    .single();
  if (runErr || !runRow) throw new Error(`Failed to create scrape_runs row: ${runErr?.message}`);
  const runId: string = runRow.id;

  const errorLog: Array<{ url?: string; message: string }> = [];
  const tally = { discovered: 0, added: 0, updated: 0, skipped: 0, errors: 0 };

  // 4. Load categories + categorization rules once for the entire run
  const rules = await loadRules(supabase);

  const config: ScrapeConfig = (source.scrape_config as ScrapeConfig) || {};
  const maxDocs = config.max_docs_per_run ?? 50;

  const ctx: ScraperContext = {
    source: source as Source,
    config,
    fetch: (url, init) => politeFetch(url, init, signal),
    log: (level, message, extra) => {
      if (level === 'warn' || level === 'error') {
        errorLog.push({ url: extra?.url as string | undefined, message });
      }
      // eslint-disable-next-line no-console
      console.log(`[scraper:${source.slug}] ${level.toUpperCase()} ${message}`, extra ?? '');
    },
    signal,
  };

  try {
    for await (const doc of adapter.discover(ctx)) {
      if (signal.aborted) throw new Error('aborted');
      if (tally.added + tally.updated >= maxDocs) {
        ctx.log('info', `Reached max_docs_per_run cap (${maxDocs}); stopping discovery.`);
        break;
      }
      tally.discovered++;
      const result = await processDiscoveredDoc(doc, source as Source, runId, rules, ctx, adapter.cachesPdf ?? true);
      switch (result.kind) {
        case 'added': tally.added++; break;
        case 'updated': tally.updated++; break;
        case 'skipped': tally.skipped++; break;
        case 'error':
          tally.errors++;
          errorLog.push({ url: doc.url, message: result.message });
          break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errorLog.push({ message: `Discovery failed: ${message}` });
    tally.errors++;
  }

  // 5. Determine final status
  const status: 'ok' | 'partial' | 'error' =
    tally.errors === 0 ? 'ok'
    : tally.added + tally.updated > 0 ? 'partial'
    : 'error';

  // 6. Update source + run
  await supabase
    .from('sources')
    .update({ last_scraped_at: new Date().toISOString() })
    .eq('id', source.id);

  await supabase
    .from('scrape_runs')
    .update({
      status,
      finished_at: new Date().toISOString(),
      discovered: tally.discovered,
      added: tally.added,
      updated: tally.updated,
      skipped: tally.skipped,
      errors: tally.errors,
      error_log: errorLog.slice(0, 100), // cap so we don't blow up jsonb
    })
    .eq('id', runId);

  return { runId, status, ...tally };
}

// ─── One-document pipeline ─────────────────────────────────────────────────

type CandidateResult =
  | { kind: 'added'; documentId: string }
  | { kind: 'updated'; documentId: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'error'; message: string };

/** Metadata shape the insert/update step needs, regardless of where it came from. */
interface ResolvedMetadata {
  title: string;
  title_en?: string;
  summary: string;
  language: 'is' | 'en';
  document_type: 'rb_blad' | 'leidbeining' | 'rannsokn' | 'handbok' | 'annad';
  categories: string[];   // slugs
  category_ids: string[]; // resolved uuids, primary first
  tags: string[];
  confidence: number;
}

/** Non-category fields for a structured doc — title/summary/language/type/tags. */
function buildStructuredFields(doc: DiscoveredDoc, url: string): Omit<ResolvedMetadata, 'categories' | 'category_ids' | 'confidence'> {
  return {
    title: (doc.title || new URL(url).pathname.split('/').pop() || 'Untitled').slice(0, 500),
    summary: (doc.description ?? '').slice(0, 2000),
    language: doc.language ?? 'is',
    document_type: doc.documentType ?? 'annad',
    tags: (doc.tags ?? []).slice(0, 10),
  };
}

/**
 * Parse a fetched PDF's text once. Used both for the thin-content sanity
 * check and as keyword-scan input for the categorizer. Failure to parse
 * counts as zero-length text, not a pipeline error — the doc still imports,
 * just flagged for review.
 */
async function parsePdfText(bytes: Buffer): Promise<{ text: string; length: number }> {
  try {
    const result = await pdfParse(bytes);
    const text = (result.text || '').trim();
    return { text, length: text.length };
  } catch {
    return { text: '', length: 0 };
  }
}

/** Replace a document's category links with the given set (first = primary). */
async function syncDocumentCategories(
  supabase: ReturnType<typeof createAdminClient>,
  documentId: string,
  categoryIds: string[],
): Promise<void> {
  await supabase.from('document_categories').delete().eq('document_id', documentId);
  if (categoryIds.length === 0) return;
  await supabase.from('document_categories').insert(
    categoryIds.map((category_id, i) => ({
      document_id: documentId,
      category_id,
      is_primary: i === 0,
    })),
  );
}

type ResolvedFile = { kind: 'self_hosted' | 'external'; file_path: string | null; url: string; label: string | null };

/** Replace a document's "Downloads" list with the given set (order preserved). */
async function syncDocumentFiles(
  supabase: ReturnType<typeof createAdminClient>,
  documentId: string,
  files: ResolvedFile[],
): Promise<void> {
  await supabase.from('document_files').delete().eq('document_id', documentId);
  if (files.length === 0) return;
  await supabase.from('document_files').insert(
    files.map((f, i) => ({
      document_id: documentId,
      kind: f.kind,
      file_path: f.file_path,
      url: f.url,
      label: f.label,
      sort_order: i,
    })),
  );
}

/** hms.is itself, or Prismic's CDN — anything else is left as an external link. */
function isHmsHostedUrl(url: string): boolean {
  try {
    const host = new URL(url).host.toLowerCase();
    return host.endsWith('hms.is') || host.endsWith('prismic.io');
  } catch {
    return false;
  }
}

/** A couple of gentle retries (short backoff) — not hammering a host that's rate-limiting us. */
async function fetchWithGentleRetry(
  ctx: ScraperContext,
  url: string,
  attempts = 2,
  backoffMs = 3000,
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await ctx.fetch(url);
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Turn an adapter's `pdfLinks` into document_files rows: self-host
 * (download + upload to Storage) anything on hms.is/Prismic's CDN, keep
 * everything else (e.g. an althingi.is regulation reference) as an external
 * link. A fetch/upload failure (even after a couple of gentle retries)
 * degrades to an external link rather than dropping the reference entirely
 * — so a host that's temporarily rate-limiting us doesn't sink the doc,
 * just its self-hosting; a later re-scrape can pick it up once it clears.
 *
 * When cachesPdf is false, self-hosting is skipped entirely — every link
 * becomes an external reference to its own source URL, no fetch attempted.
 */
async function resolvePdfLinks(
  ctx: ScraperContext,
  source: Source,
  links: Array<{ url: string; label?: string }>,
  cachesPdf: boolean,
): Promise<ResolvedFile[]> {
  const supabase = createAdminClient();
  const resolved: ResolvedFile[] = [];

  for (const link of links) {
    if (!cachesPdf || !isHmsHostedUrl(link.url)) {
      resolved.push({ kind: 'external', file_path: null, url: link.url, label: link.label ?? null });
      continue;
    }
    try {
      const res = await fetchWithGentleRetry(ctx, link.url);
      const bytes = Buffer.from(await res.arrayBuffer());
      const hash = contentHash(bytes);
      const year = new Date().getFullYear();
      const storagePath = `${source.slug}/${year}/files/${hash}.pdf`;
      const { error: upErr } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, bytes, { contentType: 'application/pdf', upsert: false });
      if (upErr && !/already exists/i.test(upErr.message)) {
        ctx.log('warn', `Attachment upload failed: ${upErr.message}`, { url: link.url });
        resolved.push({ kind: 'external', file_path: null, url: link.url, label: link.label ?? null });
        continue;
      }
      resolved.push({ kind: 'self_hosted', file_path: storagePath, url: link.url, label: link.label ?? null });
    } catch (err) {
      ctx.log('warn', `Attachment fetch/upload error: ${err instanceof Error ? err.message : String(err)}`, { url: link.url });
      resolved.push({ kind: 'external', file_path: null, url: link.url, label: link.label ?? null });
    }
  }
  return resolved;
}

async function processDiscoveredDoc(
  doc: DiscoveredDoc,
  source: Source,
  runId: string,
  rules: RulesBundle,
  ctx: ScraperContext,
  cachesPdf: boolean,
): Promise<CandidateResult> {
  const supabase = createAdminClient();
  const url = normalizeUrl(doc.url);
  const { categories, tagRules, keywordRules } = rules;

  // a. Insert into scrape_queue (idempotent via unique constraint)
  const { data: queueRow, error: queueErr } = await supabase
    .from('scrape_queue')
    .upsert(
      {
        source_id: source.id,
        run_id: runId,
        url,
        title_hint: doc.title ?? null,
        status: 'fetching',
      },
      { onConflict: 'source_id,url_hash' },
    )
    .select('id, document_id, content_hash, status')
    .single();

  if (queueErr || !queueRow) {
    return { kind: 'error', message: `Queue upsert failed: ${queueErr?.message}` };
  }

  // If this URL was already imported in a prior run, skip re-processing
  if (queueRow.document_id) {
    // Reset status back so we don't leave it as 'fetching'
    await supabase.from('scrape_queue').update({ status: 'imported' }).eq('id', queueRow.id);
    return { kind: 'skipped', reason: 'Already imported in a prior run' };
  }

  // b. Fetch — skipped when the adapter already supplied the doc's content
  // directly (doc.bodyText, e.g. a Prismic API response): the live page
  // fetch would only ever be used for hashing here, hms.is is client-
  // rendered anyway (a bare fetch wouldn't see real content), and hms.is has
  // proven unreliable to hit repeatedly (429s) for a fetch whose result
  // isn't even used for content. Hash the supplied text instead.
  let bytes: Buffer;
  let contentType = '';
  const skipLiveFetch = Boolean(doc.bodyText);
  if (skipLiveFetch) {
    bytes = Buffer.from(doc.bodyText!, 'utf-8');
  } else {
    let res: Response;
    try {
      res = await ctx.fetch(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await supabase.from('scrape_queue').update({ status: 'error', error: msg }).eq('id', queueRow.id);
      return { kind: 'error', message: `Fetch failed: ${msg}` };
    }
    if (!res.ok) {
      const msg = `HTTP ${res.status}`;
      await supabase.from('scrape_queue').update({ status: 'error', error: msg }).eq('id', queueRow.id);
      return { kind: 'error', message: msg };
    }
    bytes = Buffer.from(await res.arrayBuffer());
    contentType = res.headers.get('content-type') || '';
  }
  const hash = contentHash(bytes);
  const isPdf = !skipLiveFetch && (contentType.includes('pdf') || looksLikeDocument(url));

  // c. Content-hash dedup: if any document already has this exact hash, skip
  const { data: dup } = await supabase
    .from('scrape_queue')
    .select('id, document_id')
    .eq('content_hash', hash)
    .not('document_id', 'is', null)
    .neq('id', queueRow.id)
    .limit(1)
    .maybeSingle();

  if (dup?.document_id) {
    await supabase
      .from('scrape_queue')
      .update({
        status: 'skipped',
        content_hash: hash,
        document_id: dup.document_id,
        fetched_at: new Date().toISOString(),
      })
      .eq('id', queueRow.id);
    return { kind: 'skipped', reason: 'Duplicate content (already imported at another URL)' };
  }

  await supabase
    .from('scrape_queue')
    .update({
      status: 'analyzing',
      content_hash: hash,
      fetched_at: new Date().toISOString(),
    })
    .eq('id', queueRow.id);

  // d. source_ref dedup: an existing doc with the same (source, source_ref)
  // means the underlying file moved but represents the same logical document.
  let existing: {
    id: string;
    metadata: unknown;
    status: 'draft' | 'pending_review' | 'published' | 'archived';
  } | null = null;
  if (doc.sourceRef) {
    const { data } = await supabase
      .from('documents')
      .select('id, metadata, status')
      .eq('source_id', source.id)
      .eq('source_ref', doc.sourceRef)
      .maybeSingle();
    existing = data;
  }
  const prevHash = (existing?.metadata as { scraper?: { content_hash?: string } } | null)?.scraper?.content_hash;
  if (existing && prevHash === hash) {
    await supabase
      .from('scrape_queue')
      .update({ status: 'skipped', document_id: existing.id, imported_at: new Date().toISOString() })
      .eq('id', queueRow.id);
    return { kind: 'skipped', reason: 'Unchanged (source_ref + content_hash match)' };
  }

  // e. Extract text once — feeds both the thin-content sanity check and the
  // keyword categorizer. PDF docs get it via pdf-parse; adapters whose
  // content is rich-text/HTML (e.g. a Prismic slice body) supply it directly
  // via doc.bodyText, skipping pdf-parse entirely — same downstream handling
  // either way.
  let pdfText = '';
  let pdfTextLength = 0;
  if (doc.bodyText) {
    pdfText = doc.bodyText.trim();
    pdfTextLength = pdfText.length;
  } else if (isPdf) {
    const parsed = await parsePdfText(bytes);
    pdfText = parsed.text;
    pdfTextLength = parsed.length;
  }

  // f. Resolve categories + provenance — skip Claude for structured docs.
  let resolved: ResolvedMetadata;
  let categorization: Categorization;
  if (doc.structured) {
    const cat = categorizeStructuredDoc(
      { tags: doc.tags ?? [], title: doc.title, text: pdfText || undefined, explicitCategorySlug: doc.categorySlug },
      tagRules,
      keywordRules,
      categories,
    );
    if (cat.categorySlugs.length === 0) {
      ctx.log('warn', 'No tag rule or keyword match — importing uncategorized', { url });
    }
    resolved = {
      ...buildStructuredFields(doc, url),
      categories: cat.categorySlugs,
      category_ids: cat.categoryIds,
      confidence: cat.categorization.confidence,
    };
    categorization = cat.categorization;
  } else {
    const analysis = await analyzeDocument({
      sourceUrl: url,
      titleHint: doc.title,
      categories,
      pdfBytes: isPdf ? bytes : undefined,
      text: !isPdf ? bytes.toString('utf-8') : undefined,
    });
    if (!analysis) {
      await supabase
        .from('scrape_queue')
        .update({ status: 'error', error: 'Analysis returned null' })
        .eq('id', queueRow.id);
      return { kind: 'error', message: 'Analysis failed' };
    }
    resolved = analysis;
    categorization = {
      method: 'ai',
      source_tags: doc.tags ?? [],
      matched: analysis.categories.map((slug) => ({ category_slug: slug })),
      confidence: analysis.confidence,
      rationale: analysis.summary ? `AI categorization: ${analysis.summary}` : 'AI categorization via Claude.',
    };
  }

  // g. Thin-content sanity check — applies to any doc that claims to have
  // extractable text (a PDF, or an adapter that supplied bodyText); thin/
  // unreadable text forces review regardless of source trust.
  let needsReview = false;
  let needsReviewReason: string | undefined;
  if ((isPdf || doc.bodyText) && pdfTextLength < MIN_PDF_TEXT_CHARS) {
    needsReview = true;
    needsReviewReason = `Text extraction yielded only ${pdfTextLength} chars (< ${MIN_PDF_TEXT_CHARS})`;
    ctx.log('warn', needsReviewReason, { url });
  }

  // A doc with zero resolved categories never gets auto-published, regardless
  // of source trust — it lands in the same admin-only queue as pending_review,
  // distinguished there by having no document_categories rows ("unsorted").
  // Surfacing it to the main library uncategorized would make it unfindable
  // by subject and unfilterable — worse than just not showing it yet.
  const isUncategorized = resolved.category_ids.length === 0;

  // h. Upload PDF to Storage if applicable — skipped entirely for sources
  // marked cachesPdf: false. RB-BOX is a search/discovery layer, not a
  // document host: bytes were already fetched (above, for hashing + text
  // extraction) and are discarded once this function returns — nothing on
  // disk to clean up, since they were never written anywhere but memory.
  // file_path stays null; the frontend already falls back to external_url
  // for the "open PDF" action (see document/[id]/page.tsx's guidanceUrl).
  let storagePath: string | null = null;
  if (isPdf && cachesPdf) {
    // Path: <source-slug>/<yyyy>/<hash>.pdf — hash prevents collisions
    const year = new Date().getFullYear();
    storagePath = `${source.slug}/${year}/${hash}.pdf`;
    const { error: upErr } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, bytes, { contentType: 'application/pdf', upsert: false });
    if (upErr && !/already exists/i.test(upErr.message)) {
      ctx.log('warn', `Storage upload failed: ${upErr.message}`, { url });
      storagePath = null;
    }
  }

  // An admin who manually published/unpublished or recategorized this doc via
  // the admin UI sets metadata.admin_override.locked — respect that decision
  // on re-scrape instead of letting the auto gate/categorizer silently
  // recompute status or overwrite the categories they chose.
  const existingMeta = (existing?.metadata as { admin_override?: { locked?: boolean } } | null) ?? null;
  const hasAdminOverride = Boolean(existingMeta?.admin_override?.locked);

  const autoStatus: 'published' | 'pending_review' = needsReview || isUncategorized
    ? 'pending_review'
    : source.auto_publish ? 'published' : 'pending_review';
  const status: 'draft' | 'pending_review' | 'published' | 'archived' =
    hasAdminOverride && existing ? existing.status : autoStatus;

  const caps = await detectSchemaCapabilities(supabase);

  const rowFields = {
    title: resolved.title,
    title_en: resolved.title_en ?? null,
    description: resolved.summary,
    source_id: source.id,
    document_type: doc.documentType || resolved.document_type,
    language: resolved.language,
    reference_code: doc.sourceRef ?? null,
    source_ref: doc.sourceRef ?? null,
    published_date: doc.publishedAt ?? null,
    access_level: 'open' as const,
    status,
    file_path: storagePath,
    external_url: url,
    ...(caps.hasSourceUrl ? { source_url: doc.guidanceUrl ?? null } : {}),
    extracted_text: pdfText ? pdfText.slice(0, MAX_EXTRACTED_TEXT_CHARS) : null,
    categorization: categorization as unknown as Json,
    metadata: {
      ...(existingMeta ?? {}),
      scraper: {
        source_url: url,
        content_hash: hash,
        discovered_at: new Date().toISOString(),
        adapter: source.slug,
        confidence: resolved.confidence,
        tags: resolved.tags,
        suggested_categories: resolved.categories,
        needs_review: needsReview,
        needs_review_reason: needsReviewReason ?? null,
      },
    },
  };

  // i. Insert or update
  if (existing) {
    const { error: updErr } = await supabase
      .from('documents')
      .update(rowFields)
      .eq('id', existing.id);
    if (updErr) {
      await supabase
        .from('scrape_queue')
        .update({ status: 'error', error: updErr.message })
        .eq('id', queueRow.id);
      return { kind: 'error', message: `Update failed: ${updErr.message}` };
    }
    if (!hasAdminOverride) {
      await syncDocumentCategories(supabase, existing.id, resolved.category_ids);
      if (caps.hasDocumentFiles && doc.pdfLinks && doc.pdfLinks.length > 0) {
        const files = await resolvePdfLinks(ctx, source, doc.pdfLinks, cachesPdf);
        await syncDocumentFiles(supabase, existing.id, files);
      }
    }
    await supabase
      .from('scrape_queue')
      .update({ status: 'imported', document_id: existing.id, imported_at: new Date().toISOString() })
      .eq('id', queueRow.id);
    return { kind: 'updated', documentId: existing.id };
  }

  const { data: newDoc, error: docErr } = await supabase
    .from('documents')
    .insert(rowFields)
    .select('id')
    .single();

  if (docErr || !newDoc) {
    await supabase
      .from('scrape_queue')
      .update({ status: 'error', error: docErr?.message ?? 'insert failed' })
      .eq('id', queueRow.id);
    return { kind: 'error', message: `Insert failed: ${docErr?.message}` };
  }

  await syncDocumentCategories(supabase, newDoc.id, resolved.category_ids);
  if (caps.hasDocumentFiles && doc.pdfLinks && doc.pdfLinks.length > 0) {
    const files = await resolvePdfLinks(ctx, source, doc.pdfLinks, cachesPdf);
    await syncDocumentFiles(supabase, newDoc.id, files);
  }

  await supabase
    .from('scrape_queue')
    .update({
      status: 'imported',
      document_id: newDoc.id,
      imported_at: new Date().toISOString(),
    })
    .eq('id', queueRow.id);

  return { kind: 'added', documentId: newDoc.id };
}

/**
 * Import a single URL as a document (the "manual_import" path).
 * Reuses the same pipeline as a crawler run but only processes one doc.
 * There's no adapter involved, so this always goes through the AI fallback
 * (a bare pasted URL is never marked `structured`).
 */
export async function importSingleUrl(opts: {
  sourceId: string;
  url: string;
  triggeredBy?: string;
}): Promise<{ runId: string; documentId: string | null; error?: string }> {
  const supabase = createAdminClient();
  const { data: source } = await supabase
    .from('sources').select('*').eq('id', opts.sourceId).single();
  if (!source) return { runId: '', documentId: null, error: 'Source not found' };

  const { data: runRow } = await supabase
    .from('scrape_runs')
    .insert({
      source_id: source.id,
      trigger: 'import',
      triggered_by: opts.triggeredBy ?? null,
      status: 'running',
    })
    .select('id')
    .single();
  const runId = runRow?.id;
  if (!runId) return { runId: '', documentId: null, error: 'Failed to create run' };

  const rules = await loadRules(supabase);

  const config: ScrapeConfig = (source.scrape_config as ScrapeConfig) || {};
  const controller = new AbortController();
  const ctx: ScraperContext = {
    source: source as Source,
    config,
    fetch: (u, init) => politeFetch(u, init, controller.signal),
    log: (_lvl, msg) => console.log(`[import:${source.slug}] ${msg}`),
    signal: controller.signal,
  };

  const result = await processDiscoveredDoc(
    { url: opts.url },
    source as Source,
    runId,
    rules,
    ctx,
    true, // manual admin URL-paste is out of scope for the no-caching retrofit — unchanged behavior
  );

  const isOk = result.kind === 'added' || result.kind === 'updated' || result.kind === 'skipped';
  await supabase
    .from('scrape_runs')
    .update({
      status: isOk ? 'ok' : 'error',
      finished_at: new Date().toISOString(),
      discovered: 1,
      added: result.kind === 'added' ? 1 : 0,
      updated: result.kind === 'updated' ? 1 : 0,
      skipped: result.kind === 'skipped' ? 1 : 0,
      errors: result.kind === 'error' ? 1 : 0,
      error_log: result.kind === 'error' ? [{ url: opts.url, message: result.message }] : [],
    })
    .eq('id', runId);

  return {
    runId,
    documentId: result.kind === 'added' || result.kind === 'updated' ? result.documentId : null,
    error: result.kind === 'error' ? result.message : undefined,
  };
}
