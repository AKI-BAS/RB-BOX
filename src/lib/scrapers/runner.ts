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
 *      e. Resolve metadata:
 *           - If the adapter marked the doc `structured` (its metadata came
 *             from a CMS content API, not content inference), build it
 *             directly from the DiscoveredDoc fields. No Claude call — even
 *             if `categorySlug` itself couldn't be resolved, the doc still
 *             imports uncategorized rather than spending an AI call on it.
 *           - Otherwise (an unstructured HTML-crawl doc with only a URL/title
 *             hint), fall back to analyzeDocument (Claude).
 *      f. If PDF, run a cheap pdf-parse sanity check. Extracted text < 200
 *         chars forces status='pending_review' regardless of source trust.
 *      g. If PDF, upload to Storage; if HTML, store extracted text only
 *      h. Upsert the documents row:
 *           - If the doc carries a `source_ref` and a document with the same
 *             (source_id, source_ref) already exists, update it in place
 *             (or skip if content is unchanged) instead of inserting a
 *             duplicate — this survives the underlying file URL changing.
 *           - Otherwise insert a new row.
 *         status='published' if source.auto_publish else 'pending_review'.
 *      i. Sync document_categories from the resolved category ids.
 *      j. Update scrape_queue.status='imported', link document_id.
 *   4. Update source.last_scraped_at
 *   5. Update scrape_runs with final tallies
 *
 * AI usage: analyzeDocument (Claude) is now only invoked for docs an adapter
 * *can't* self-describe — i.e. crawler adapters that only know a URL/anchor
 * text. Structured adapters (Prismic-backed hms-rb-blod, and any future
 * adapter that marks its docs `structured: true`) skip it entirely,
 * regardless of whether a categorySlug happened to resolve. The contributor
 * upload flow (`/api/admin/categorize`) is unaffected — it's a separate code
 * path that never went through this runner.
 */

import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { createAdminClient } from '@/lib/supabase/admin';
import type { DiscoveredDoc, RunSummary, ScrapeConfig, ScraperContext, Source } from './types';
import { getAdapter } from './registry';
import { politeFetch, contentHash, normalizeUrl, looksLikeDocument } from './fetch-utils';
import { analyzeDocument } from './analyze';

const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'documents';
const MIN_PDF_TEXT_CHARS = 200;

type Category = { id: string; slug: string; name: string; name_en: string | null };

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

  // 4. Load categories once for the entire run
  const { data: categories } = await supabase
    .from('categories')
    .select('id, slug, name, name_en');

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
      const result = await processDiscoveredDoc(doc, source as Source, runId, categories || [], ctx);
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
  category_ids: string[]; // resolved uuids
  tags: string[];
  confidence: number;
}

function resolveCategoryIds(slugs: string[], categories: Category[]): string[] {
  return slugs
    .map((slug) => categories.find((c) => c.slug === slug)?.id)
    .filter((id): id is string => Boolean(id));
}

/** Build resolved metadata directly from adapter-supplied fields — no AI call. */
function resolveFromDiscoveredDoc(doc: DiscoveredDoc, url: string, categories: Category[]): ResolvedMetadata {
  const slugs = doc.categorySlug ? [doc.categorySlug] : [];
  return {
    title: (doc.title || new URL(url).pathname.split('/').pop() || 'Untitled').slice(0, 500),
    summary: (doc.description ?? '').slice(0, 2000),
    language: doc.language ?? 'is',
    document_type: doc.documentType ?? 'annad',
    categories: slugs,
    category_ids: resolveCategoryIds(slugs, categories),
    tags: (doc.tags ?? []).slice(0, 10),
    confidence: 1, // rule-based from a trusted structured source — no inference involved
  };
}

/**
 * Cheap sanity check that a fetched PDF actually contains extractable text.
 * Catches scans-without-OCR and corrupt/placeholder files. Failure to parse
 * counts as zero-length text, not a pipeline error — the doc still imports,
 * just flagged for review.
 */
async function sanityCheckPdfText(bytes: Buffer): Promise<{ ok: boolean; length: number }> {
  try {
    const result = await pdfParse(bytes);
    const length = result.text?.trim().length ?? 0;
    return { ok: length >= MIN_PDF_TEXT_CHARS, length };
  } catch {
    return { ok: false, length: 0 };
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

async function processDiscoveredDoc(
  doc: DiscoveredDoc,
  source: Source,
  runId: string,
  categories: Category[],
  ctx: ScraperContext,
): Promise<CandidateResult> {
  const supabase = createAdminClient();
  const url = normalizeUrl(doc.url);

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

  // b. Fetch
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

  const bytes = Buffer.from(await res.arrayBuffer());
  const hash = contentHash(bytes);
  const contentType = res.headers.get('content-type') || '';
  const isPdf = contentType.includes('pdf') || looksLikeDocument(url);

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
  let existing: { id: string; metadata: unknown } | null = null;
  if (doc.sourceRef) {
    const { data } = await supabase
      .from('documents')
      .select('id, metadata')
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

  // e. Resolve metadata — skip Claude when the adapter already supplied a category.
  let resolved: ResolvedMetadata;
  if (doc.structured) {
    resolved = resolveFromDiscoveredDoc(doc, url, categories);
    if (resolved.category_ids.length === 0) {
      ctx.log('warn', `No category resolved for structured doc (categorySlug="${doc.categorySlug ?? 'none'}")`, { url });
    }
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
  }

  // f. PDF sanity check — thin/unreadable text forces review regardless of trust.
  let needsReview = false;
  let needsReviewReason: string | undefined;
  if (isPdf) {
    const sanity = await sanityCheckPdfText(bytes);
    if (!sanity.ok) {
      needsReview = true;
      needsReviewReason = `PDF text extraction yielded only ${sanity.length} chars (< ${MIN_PDF_TEXT_CHARS})`;
      ctx.log('warn', needsReviewReason, { url });
    }
  }

  // g. Upload PDF to Storage if applicable
  let storagePath: string | null = null;
  if (isPdf) {
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

  const status: 'published' | 'pending_review' = needsReview
    ? 'pending_review'
    : source.auto_publish ? 'published' : 'pending_review';

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
    metadata: {
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

  // h. Insert or update
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
    await syncDocumentCategories(supabase, existing.id, resolved.category_ids);
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
 * (no categorySlug can be known for a bare pasted URL).
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

  const { data: categories } = await supabase
    .from('categories').select('id, slug, name, name_en');

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
    categories || [],
    ctx,
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
