/**
 * The scraper runner.
 *
 * Given a source, drives the pipeline end-to-end:
 *   1. Create a scrape_runs row (status='running')
 *   2. Look up the adapter for source.slug
 *   3. Iterate adapter.discover() → for each Candidate:
 *      a. Skip if scrape_queue already has this URL for this source
 *      b. Insert scrape_queue row (status='pending')
 *      c. Fetch the URL, compute content_hash
 *      d. If content_hash matches an existing document → skip
 *      e. Call analyzeDocument
 *      f. If PDF, upload to Storage; if HTML, store extracted text only
 *      g. Insert documents row (status='published' if source.auto_publish else 'pending_review')
 *      h. Update scrape_queue.status='imported', link document_id
 *   4. Update source.last_scraped_at
 *   5. Update scrape_runs with final tallies
 */

import { createAdminClient } from '@/lib/supabase/admin';
import type { Adapter, Candidate, RunSummary, ScrapeConfig, ScraperContext, Source } from './types';
import { getAdapter } from './registry';
import { politeFetch, contentHash, normalizeUrl, looksLikeDocument } from './fetch-utils';
import { analyzeDocument } from './analyze';

const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'documents';

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
    for await (const candidate of adapter.discover(ctx)) {
      if (signal.aborted) throw new Error('aborted');
      if (tally.added + tally.updated >= maxDocs) {
        ctx.log('info', `Reached max_docs_per_run cap (${maxDocs}); stopping discovery.`);
        break;
      }
      tally.discovered++;
      const result = await processCandidate(candidate, source as Source, runId, categories || [], ctx);
      switch (result.kind) {
        case 'added': tally.added++; break;
        case 'updated': tally.updated++; break;
        case 'skipped': tally.skipped++; break;
        case 'error':
          tally.errors++;
          errorLog.push({ url: candidate.url, message: result.message });
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

// ─── One-candidate pipeline ────────────────────────────────────────────────

type CandidateResult =
  | { kind: 'added'; documentId: string }
  | { kind: 'updated'; documentId: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'error'; message: string };

async function processCandidate(
  candidate: Candidate,
  source: Source,
  runId: string,
  categories: Array<{ id: string; slug: string; name: string; name_en: string | null }>,
  ctx: ScraperContext,
): Promise<CandidateResult> {
  const supabase = createAdminClient();
  const url = normalizeUrl(candidate.url);

  // a. Insert into scrape_queue (idempotent via unique constraint)
  const { data: queueRow, error: queueErr } = await supabase
    .from('scrape_queue')
    .upsert(
      {
        source_id: source.id,
        run_id: runId,
        url,
        title_hint: candidate.titleHint ?? null,
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

  // d. Analyze
  const analysis = await analyzeDocument({
    sourceUrl: url,
    titleHint: candidate.titleHint,
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

  // e. Upload PDF to Storage if applicable
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

  // f. Insert documents row
  const status = source.auto_publish ? 'published' : 'pending_review';
  const { data: doc, error: docErr } = await supabase
    .from('documents')
    .insert({
      title: analysis.title,
      title_en: analysis.title_en ?? null,
      description: analysis.summary,
      source_id: source.id,
      document_type: candidate.documentType || analysis.document_type,
      language: analysis.language,
      reference_code: candidate.externalId ?? null,
      published_date: candidate.publishedDate ?? null,
      access_level: 'open',
      status,
      file_path: storagePath,
      external_url: url,
      metadata: {
        scraper: {
          source_url: url,
          content_hash: hash,
          discovered_at: new Date().toISOString(),
          adapter: source.slug,
          confidence: analysis.confidence,
          tags: analysis.tags,
          suggested_categories: analysis.categories,
        },
      },
    })
    .select('id')
    .single();

  if (docErr || !doc) {
    await supabase
      .from('scrape_queue')
      .update({ status: 'error', error: docErr?.message ?? 'insert failed' })
      .eq('id', queueRow.id);
    return { kind: 'error', message: `Insert failed: ${docErr?.message}` };
  }

  // g. Category assignment: for now we store the suggested category slugs +
  //    resolved ids in documents.metadata.scraper.suggested_categories (set
  //    above). If/when a document_categories join table exists, wire the
  //    insert here — it's straightforward. Keeping the runner join-table-free
  //    means it works against the current schema out of the box.

  await supabase
    .from('scrape_queue')
    .update({
      status: 'imported',
      document_id: doc.id,
      imported_at: new Date().toISOString(),
    })
    .eq('id', queueRow.id);

  return { kind: 'added', documentId: doc.id };
}

/**
 * Import a single URL as a document (the "manual_import" path).
 * Reuses the same pipeline as a crawler run but only processes one candidate.
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

  const result = await processCandidate(
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
