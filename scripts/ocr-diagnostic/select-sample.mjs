#!/usr/bin/env node
/**
 * PaddleOCR-VL diagnostic — Phase A sample selection.
 *
 * READ-ONLY. Every Supabase call in this file is a SELECT. No INSERT,
 * UPDATE, DELETE, or upsert appears anywhere in this script or any other
 * file in this directory — verified by grep as part of the Phase A
 * checklist (see README.md). This script never writes to the database;
 * it only reads documents and writes local files under sample/.
 *
 * Picks 10 deliberately-varied documents to stress different failure
 * modes of the current extraction path (pdf-parse) that a vision-language
 * OCR model might recover from:
 *   1. 2x hms-rb-blod, extracted_text > 2000 chars (long, likely table-heavy)
 *   2. 2x byggingarreglugerd — one with a numeric-grid heuristic match
 *      (likely an embedded table), one prose-only
 *   3. 2x taktak (vendor spec sheets / detail drawings with figure callouts)
 *   4. 2x empty-or-<200-char extracted_text — prefers hms-rb-blod (the
 *      Prismic-hosted scans: real PDFs behind no auth wall, so they should
 *      download cleanly) with a same-criteria fallback across all sources
 *      if that source doesn't have enough
 *   5. 2x svanurinn, falling back to byggjum-graenni for any short slots
 *
 * For each doc: writes sample/{source_slug}/{doc_id}.json (id, title,
 * external_url, source_id, source_slug, extracted_text, metadata) and
 * attempts to download the PDF to sample/{source_slug}/{doc_id}.pdf.
 * Some sources (byggingarreglugerd, hms-rb-blod-web) are HTML-native —
 * their external_url is a web page, not a PDF file. Those downloads are
 * EXPECTED to fail; failures (404/timeout/non-PDF content-type) are
 * logged and skipped, never treated as a run failure.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SAMPLE_DIR = path.join(__dirname, 'sample');
const DOWNLOAD_TIMEOUT_MS = 20_000;

function loadEnv() {
  const envText = readFileSync(path.join(PROJECT_ROOT, '.env.local'), 'utf8');
  for (const line of envText.split('\n')) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m) process.env[m[1]] = process.env[m[1]] ?? m[2].trim();
  }
}
loadEnv();

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

async function sourceBySlug(slug) {
  const { data, error } = await supabase
    .from('sources')
    .select('id, slug, name')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function publishedDocs(sourceId) {
  const { data, error } = await supabase
    .from('documents')
    .select('id, title, external_url, source_id, extracted_text, metadata')
    .eq('source_id', sourceId)
    .eq('status', 'published')
    .limit(2000);
  if (error) throw error;
  return data ?? [];
}

async function allPublishedDocsWithSourceSlug() {
  const { data, error } = await supabase
    .from('documents')
    .select('id, title, external_url, source_id, extracted_text, metadata, sources(slug)')
    .eq('status', 'published')
    .limit(2000);
  if (error) throw error;
  return data ?? [];
}

// Crude "looks like a table" heuristic on plain extracted text: a high
// total count of numeric tokens across the WHOLE text (not per-line —
// verified live that byggingarreglugerd's pdf-parse output has NO
// newlines at all, a table gets flattened into one continuous line, so a
// per-line check can never see more than one "line"). Threshold of 8
// chosen against two known reference docs: a real fire-rating table
// (e071c9d0, "Brunamótstaða burðarvirkja") scores 35, a prose-only grein
// (7994ba23, "Ketilrými") scores 4 — 8 sits cleanly between them.
function looksTableLike(text) {
  if (!text) return false;
  const numTokens = (text.match(/\b\d+([.,]\d+)?\b/g) ?? []).length;
  return numTokens >= 8;
}

const isThin = (d) => (d.extracted_text?.length ?? 0) < 200;

const picked = []; // { doc, sourceSlug, category }
const usedIds = new Set();
const skippedSlots = [];

function addPicks(docs, sourceSlug, category, n, filter) {
  const pool = (filter ? docs.filter(filter) : docs).filter((d) => !usedIds.has(d.id));
  const chosen = pool.slice(0, n);
  chosen.forEach((d) => {
    usedIds.add(d.id);
    picked.push({ doc: d, sourceSlug, category });
  });
  if (chosen.length < n) {
    skippedSlots.push(`${category}: wanted ${n}, found ${chosen.length} (source=${sourceSlug})`);
  }
  return chosen;
}

console.log('Selecting sample documents (read-only SELECTs only)...\n');

// 1. HMS RB blöð, long/table-heavy
const hms = await sourceBySlug('hms-rb-blod');
if (hms) {
  const docs = (await publishedDocs(hms.id))
    .slice()
    .sort((a, b) => (b.extracted_text?.length ?? 0) - (a.extracted_text?.length ?? 0));
  addPicks(docs, 'hms-rb-blod', 'hms-long-table-heavy', 2, (d) => (d.extracted_text?.length ?? 0) > 2000);
} else {
  skippedSlots.push('hms-long-table-heavy: source hms-rb-blod not found');
}

// 2. byggingarreglugerd — one table-like, one prose
const byg = await sourceBySlug('byggingarreglugerd');
if (byg) {
  const docs = await publishedDocs(byg.id);
  addPicks(docs, 'byggingarreglugerd', 'byggingarreglugerd-table', 1, (d) => looksTableLike(d.extracted_text));
  addPicks(
    docs,
    'byggingarreglugerd',
    'byggingarreglugerd-prose',
    1,
    (d) => !looksTableLike(d.extracted_text) && (d.extracted_text?.length ?? 0) > 500,
  );
} else {
  skippedSlots.push('byggingarreglugerd: source not found');
}

// 3. taktak — vendor spec sheets / detail drawings
const taktak = await sourceBySlug('taktak');
if (taktak) {
  const docs = await publishedDocs(taktak.id);
  addPicks(docs, 'taktak', 'taktak-detail-drawing', 2);
} else {
  skippedSlots.push('taktak-detail-drawing: source taktak not found');
}

// 4. empty/<200-char extracted_text — prefer hms-rb-blod (real scanned
// PDFs, no auth wall), fall back to any source for remaining slots
{
  const hmsDocs = hms ? await publishedDocs(hms.id) : [];
  const chosen = addPicks(hmsDocs, 'hms-rb-blod', 'thin-extracted-text', 2, isThin);
  if (chosen.length < 2) {
    const remaining = 2 - chosen.length;
    const broad = await allPublishedDocsWithSourceSlug();
    const more = broad.filter((d) => !usedIds.has(d.id) && isThin(d)).slice(0, remaining);
    more.forEach((d) => {
      usedIds.add(d.id);
      picked.push({ doc: d, sourceSlug: d.sources?.slug ?? 'unknown', category: 'thin-extracted-text' });
    });
    if (chosen.length + more.length < 2) {
      skippedSlots.push(`thin-extracted-text: wanted 2, found ${chosen.length + more.length} total`);
    }
  }
}

// 5. svanurinn, falling back to byggjum-graenni for any short slots
{
  const svanurinn = await sourceBySlug('svanurinn');
  const svanDocs = svanurinn ? await publishedDocs(svanurinn.id) : [];
  const chosen = addPicks(svanDocs, 'svanurinn', 'svanurinn-or-bgf', 2);
  if (chosen.length < 2) {
    const bgf = await sourceBySlug('byggjum-graenni');
    if (bgf) {
      const bgfDocs = await publishedDocs(bgf.id);
      addPicks(bgfDocs, 'byggjum-graenni', 'svanurinn-or-bgf', 2 - chosen.length);
    } else if (chosen.length === 0) {
      skippedSlots.push('svanurinn-or-bgf: neither source found');
    }
  }
}

console.log(`Selected ${picked.length} documents:\n`);
picked.forEach((p, i) =>
  console.log(`  ${i + 1}. [${p.category}] ${p.sourceSlug}/${p.doc.id}  "${p.doc.title}"`),
);
if (skippedSlots.length) {
  console.log('\nSlots short of target:');
  skippedSlots.forEach((s) => console.log(`  - ${s}`));
}

// --- Write sample/{slug}/{id}.json + attempt PDF download ---
mkdirSync(SAMPLE_DIR, { recursive: true });

async function downloadPdf(url, destPath) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const contentType = res.headers.get('content-type') ?? '';
    const buf = Buffer.from(await res.arrayBuffer());
    const looksLikePdf = contentType.includes('pdf') || buf.subarray(0, 5).toString('latin1') === '%PDF-';
    if (!looksLikePdf) {
      return { ok: false, reason: `not a PDF (content-type: ${contentType || 'unknown'})` };
    }
    writeFileSync(destPath, buf);
    return { ok: true, bytes: buf.length };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, reason: err.name === 'AbortError' ? 'timeout' : String(err.message ?? err) };
  }
}

console.log('\nWriting sample files + downloading PDFs...\n');

const downloadFailures = [];
const downloaded = [];

for (const { doc, sourceSlug, category } of picked) {
  const dir = path.join(SAMPLE_DIR, sourceSlug);
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    path.join(dir, `${doc.id}.json`),
    JSON.stringify(
      {
        id: doc.id,
        title: doc.title,
        external_url: doc.external_url,
        source_id: doc.source_id,
        source_slug: sourceSlug,
        category,
        extracted_text: doc.extracted_text,
        metadata: doc.metadata,
      },
      null,
      2,
    ),
  );

  if (!doc.external_url) {
    console.log(`  [${sourceSlug}/${doc.id}] SKIP download — no external_url`);
    downloadFailures.push({ id: doc.id, sourceSlug, reason: 'no external_url' });
    continue;
  }

  const outcome = await downloadPdf(doc.external_url, path.join(dir, `${doc.id}.pdf`));
  if (outcome.ok) {
    console.log(`  [${sourceSlug}/${doc.id}] downloaded (${outcome.bytes} bytes)`);
    downloaded.push({ id: doc.id, sourceSlug, bytes: outcome.bytes });
  } else {
    console.log(`  [${sourceSlug}/${doc.id}] SKIP download — ${outcome.reason}`);
    downloadFailures.push({ id: doc.id, sourceSlug, reason: outcome.reason });
  }
}

console.log('\n--- Summary ---');
console.log(`Documents selected: ${picked.length}`);
console.log(`PDFs downloaded: ${downloaded.length}`);
console.log(`Downloads skipped: ${downloadFailures.length}`);
downloadFailures.forEach((f) => console.log(`  - ${f.sourceSlug}/${f.id}: ${f.reason}`));

writeFileSync(
  path.join(SAMPLE_DIR, 'selection-summary.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      picked: picked.map((p) => ({ id: p.doc.id, sourceSlug: p.sourceSlug, category: p.category, title: p.doc.title })),
      skippedSlots,
      downloaded,
      downloadFailures,
    },
    null,
    2,
  ),
);

console.log('\nDone. No database writes were made — every call above was a SELECT.');
