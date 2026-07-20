#!/usr/bin/env node
/**
 * PaddleOCR-VL diagnostic — Phase B report builder.
 *
 * AUTHOR ONLY IN PHASE A — not executed until Phase B, and only meaningful
 * once run-ocr.py has produced sample/{slug}/{id}.ocr.md +
 * sample/{slug}/{id}.timing.json alongside the sample/{slug}/{id}.json
 * (pdf-parse extracted_text + metadata) written by select-sample.mjs.
 *
 * Reads all three files per doc, computes a pdf-parse-vs-OCR diff summary,
 * and writes output/report.md. Read-only against the local filesystem;
 * makes no Supabase calls at all (nothing here needs the DB — the JSON
 * snapshot from select-sample.mjs already has everything).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = path.join(__dirname, 'sample');
const OUTPUT_DIR = path.join(__dirname, 'output');

function wordCount(text) {
  return (text ?? '').trim().split(/\s+/).filter(Boolean).length;
}

function icelandicCharCounts(text) {
  const t = text ?? '';
  const count = (re) => (t.match(re) ?? []).length;
  return {
    d_stroke: count(/[ðÐ]/g),
    thorn: count(/[þÞ]/g),
    ae: count(/[æÆ]/g),
  };
}

// 5-gram Jaccard overlap on whitespace-tokenized, lowercased words — a
// crude but dependency-free measure of how much the two extractions agree
// on running text, independent of exact formatting differences.
function jaccard5gram(a, b) {
  const grams = (text) => {
    const words = (text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const set = new Set();
    for (let i = 0; i + 5 <= words.length; i++) set.add(words.slice(i, i + 5).join(' '));
    return set;
  };
  const setA = grams(a);
  const setB = grams(b);
  if (setA.size === 0 && setB.size === 0) return null;
  let intersection = 0;
  for (const g of setA) if (setB.has(g)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? null : intersection / union;
}

function tablesDetected(markdown) {
  const lines = (markdown ?? '').split('\n');
  const pipeRows = lines.filter((l) => (l.match(/\|/g) ?? []).length >= 2).length;
  const separators = lines.filter((l) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(l)).length;
  return pipeRows + separators;
}

function headingsDetected(markdown) {
  return (markdown ?? '').split('\n').filter((l) => /^#{1,6}\s/.test(l)).length;
}

async function main() {
  if (!existsSync(SAMPLE_DIR)) {
    console.error(`No sample/ directory at ${SAMPLE_DIR} — run select-sample.mjs (and Phase B's run-ocr.py) first.`);
    process.exit(1);
  }

  const slugDirs = readdirSync(SAMPLE_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const docs = [];
  for (const slug of slugDirs) {
    const dir = path.join(SAMPLE_DIR, slug);
    const files = readdirSync(dir);
    const jsonFiles = files.filter((f) => f.endsWith('.json'));
    for (const jsonFile of jsonFiles) {
      const id = jsonFile.replace(/\.json$/, '');
      const jsonPath = path.join(dir, jsonFile);
      const ocrPath = path.join(dir, `${id}.ocr.md`);
      const timingPath = path.join(dir, `${id}.timing.json`);

      const meta = JSON.parse(readFileSync(jsonPath, 'utf8'));
      const hasOcr = existsSync(ocrPath) && existsSync(timingPath);

      docs.push({
        id,
        slug,
        meta,
        ocrMarkdown: hasOcr ? readFileSync(ocrPath, 'utf8') : null,
        timing: hasOcr ? JSON.parse(readFileSync(timingPath, 'utf8')) : null,
      });
    }
  }

  if (docs.length === 0) {
    console.error('No sample docs found under sample/*/*.json — run select-sample.mjs first.');
    process.exit(1);
  }

  const withOcr = docs.filter((d) => d.ocrMarkdown !== null);
  const totalPages = withOcr.reduce((sum, d) => sum + (d.timing?.pages ?? 0), 0);
  const totalWallClock = withOcr.reduce((sum, d) => sum + (d.timing?.wall_clock_sec ?? 0), 0);
  const avgSecPerPage =
    withOcr.length > 0
      ? withOcr.reduce((sum, d) => sum + (d.timing?.sec_per_page ?? 0), 0) / withOcr.length
      : null;
  const deviceName = withOcr[0]?.timing?.device ?? 'unknown';

  const lines = [];
  lines.push('# PaddleOCR-VL Diagnostic Report');
  lines.push('');
  lines.push(`- Run date: ${new Date().toISOString()}`);
  lines.push(`- Device: ${deviceName}`);
  lines.push(`- Docs sampled: ${docs.length} (${withOcr.length} with OCR output, ${docs.length - withOcr.length} skipped — no PDF/OCR available)`);
  lines.push(`- Total pages OCR'd: ${totalPages}`);
  lines.push(`- Total OCR wall clock: ${totalWallClock.toFixed(1)}s`);
  lines.push(`- Avg sec/page: ${avgSecPerPage !== null ? avgSecPerPage.toFixed(2) : 'n/a'}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  const aggregateRows = [];

  for (const doc of docs) {
    const { meta } = doc;
    lines.push(`## ${meta.title}`);
    lines.push('');
    lines.push(`- Source: ${doc.slug}`);
    lines.push(`- Doc ID: ${doc.id}`);
    lines.push(`- External URL: ${meta.external_url ?? 'n/a'}`);
    lines.push(`- Category: ${meta.category}`);

    if (!doc.ocrMarkdown) {
      lines.push(`- **No OCR output** — PDF was not downloaded or OCR was not run for this doc.`);
      lines.push('');
      lines.push('---');
      lines.push('');
      aggregateRows.push({ title: meta.title, charsGained: 'n/a', tables: 'n/a', icelandicOk: 'n/a' });
      continue;
    }

    const pdfText = meta.extracted_text ?? '';
    const ocrText = doc.ocrMarkdown;

    const pdfChars = pdfText.length;
    const ocrChars = ocrText.length;
    const pdfWords = wordCount(pdfText);
    const ocrWords = wordCount(ocrText);
    const jaccard = jaccard5gram(pdfText, ocrText);
    const pdfIcelandic = icelandicCharCounts(pdfText);
    const ocrIcelandic = icelandicCharCounts(ocrText);
    const tables = tablesDetected(ocrText);
    const headings = headingsDetected(ocrText);

    lines.push(`- Pages: ${doc.timing?.pages ?? 'n/a'}`);
    lines.push(`- OCR wall clock: ${doc.timing?.wall_clock_sec?.toFixed?.(1) ?? 'n/a'}s`);
    lines.push('');
    lines.push('**Diff summary**');
    lines.push('');
    lines.push('| Metric | pdf-parse | OCR |');
    lines.push('| --- | --- | --- |');
    lines.push(`| Characters | ${pdfChars} | ${ocrChars} |`);
    lines.push(`| Words | ${pdfWords} | ${ocrWords} |`);
    lines.push(`| ð/Ð count | ${pdfIcelandic.d_stroke} | ${ocrIcelandic.d_stroke} |`);
    lines.push(`| þ/Þ count | ${pdfIcelandic.thorn} | ${ocrIcelandic.thorn} |`);
    lines.push(`| æ/Æ count | ${pdfIcelandic.ae} | ${ocrIcelandic.ae} |`);
    lines.push('');
    lines.push(`- 5-gram Jaccard overlap: ${jaccard !== null ? (jaccard * 100).toFixed(1) + '%' : 'n/a (too little text)'}`);
    lines.push(`- Tables detected in OCR (pipe rows + \`---\` separators): ${tables}`);
    lines.push(`- Headings detected in OCR (\`#\` prefixes): ${headings}`);
    lines.push('');
    lines.push('**pdf-parse (first 2000 chars)**');
    lines.push('```');
    lines.push(pdfText.slice(0, 2000));
    lines.push('```');
    lines.push('');
    lines.push('**OCR (first 2000 chars)**');
    lines.push('```');
    lines.push(ocrText.slice(0, 2000));
    lines.push('```');
    lines.push('');
    lines.push('**Reviewer checklist**');
    lines.push('');
    lines.push('- [ ] Icelandic characters OK');
    lines.push('- [ ] Tables recovered');
    lines.push('- [ ] Reading order correct');
    lines.push('- [ ] Figure callouts preserved');
    lines.push('- [ ] Overall verdict: _____');
    lines.push('');
    lines.push('---');
    lines.push('');

    aggregateRows.push({
      title: meta.title,
      charsGained: ocrChars - pdfChars,
      tables,
      icelandicOk: '',
    });
  }

  lines.push('## Aggregate');
  lines.push('');
  lines.push('| Doc | Chars gained | Tables recovered | Icelandic OK | Verdict |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const row of aggregateRows) {
    lines.push(`| ${row.title} | ${row.charsGained} | ${row.tables} | ${row.icelandicOk} |  |`);
  }
  lines.push('');

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const reportPath = path.join(OUTPUT_DIR, 'report.md');
  writeFileSync(reportPath, lines.join('\n'));
  console.log(`Wrote ${reportPath}`);
}

main();
