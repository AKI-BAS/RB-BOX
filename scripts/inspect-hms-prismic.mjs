// READ-ONLY diagnostic script — no adapter/source changes, not wired into the runner.
// Run: node scripts/inspect-hms-prismic.mjs
import { createClient } from '@prismicio/client';

const REPO = 'hms-web';
const LCA_UID = 'leidbeiningar-lca';
const LCA_PATH_PREFIX = '/lifsferilsgreining/';
const MISSING_REPORT_UID = 'rb_tveggja_threpa_thetting_skilgreining_og_virkni';
const TIMEOUT_MS = 20000;

const client = createClient(REPO);

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms)),
  ]);
}

async function main() {
  console.log(`=== HMS Prismic inspection (repo: ${REPO}) ===\n`);

  // 1+2. Repository metadata: custom types + tags
  let repo;
  try {
    repo = await withTimeout(client.getRepository(), TIMEOUT_MS, 'getRepository');
  } catch (err) {
    console.log(`FATAL: could not fetch repository metadata: ${err.message}`);
    return;
  }

  const types = repo.types ?? {};
  const typeIds = Object.keys(types);
  console.log(`--- Custom types (${typeIds.length}) ---`);
  for (const id of typeIds) {
    console.log(`  ${id}  ->  ${types[id]}`);
  }

  const tags = repo.tags ?? [];
  console.log(`\n--- Tags (${tags.length}) ---`);
  for (const tag of tags) {
    console.log(`  ${tag}`);
  }

  // 3. Find the LCA doc by UID across every custom type
  console.log(`\n--- Searching for uid === "${LCA_UID}" across all ${typeIds.length} types ---`);
  let lcaDoc = null;
  let lcaType = null;
  for (const typeId of typeIds) {
    try {
      const doc = await withTimeout(client.getByUID(typeId, LCA_UID), TIMEOUT_MS, `getByUID(${typeId})`);
      if (doc) {
        console.log(`  FOUND in type "${typeId}"`);
        lcaDoc = doc;
        lcaType = typeId;
        break;
      }
    } catch (err) {
      // Not found (404) is expected/normal for almost every type — only log
      // anything that looks like a real failure, not routine "no such doc".
      const msg = err?.message ?? String(err);
      if (/TIMEOUT/.test(msg)) {
        console.log(`  SKIP ${typeId}: ${msg}`);
      }
      // else: silent — not-found is the expected case for most types
    }
  }

  if (lcaDoc) {
    console.log('\n--- LCA document ---');
    console.log(JSON.stringify({
      id: lcaDoc.id,
      uid: lcaDoc.uid,
      type: lcaDoc.type,
      tags: lcaDoc.tags,
      url: lcaDoc.url,
      first_publication_date: lcaDoc.first_publication_date,
      last_publication_date: lcaDoc.last_publication_date,
    }, null, 2));
  } else {
    console.log(`\n--- LCA document ---\n  NOT FOUND via getByUID in any type.`);
  }

  // 4. Total doc count per custom type (skip news_item)
  console.log(`\n--- Total doc count per custom type (pageSize:1, skip news_item) ---`);
  for (const typeId of typeIds) {
    if (typeId === 'news_item') {
      console.log(`  ${typeId}: SKIPPED`);
      continue;
    }
    try {
      const page = await withTimeout(
        client.getByType(typeId, { pageSize: 1 }),
        TIMEOUT_MS,
        `getByType(${typeId})`,
      );
      console.log(`  ${typeId}: ${page.total_results_size}`);
    } catch (err) {
      console.log(`  ${typeId}: ERROR (${err.message})`);
    }
  }

  // 5. Sibling pages under /lifsferilsgreining/
  if (lcaType) {
    console.log(`\n--- Sibling pages under "${LCA_PATH_PREFIX}" (type: "${lcaType}") ---`);
    try {
      const page = await withTimeout(
        client.getByType(lcaType, { pageSize: 100 }),
        TIMEOUT_MS,
        `getByType(${lcaType}) for siblings`,
      );
      console.log(`  (fetched page 1 of ${page.total_pages}, ${page.results.length} of ${page.total_results_size} total docs of type "${lcaType}")`);
      const siblings = page.results.filter((d) => typeof d.url === 'string' && d.url.startsWith(LCA_PATH_PREFIX));
      if (siblings.length === 0) {
        console.log(`  No docs with url starting "${LCA_PATH_PREFIX}" found on page 1. Dumping uid/url for all fetched docs of this type instead:`);
        for (const d of page.results) {
          console.log(`    uid=${d.uid ?? '(none)'}  url=${d.url ?? '(null)'}  tags=${JSON.stringify(d.tags)}`);
        }
      } else {
        for (const d of siblings) {
          console.log(`  ${JSON.stringify({ id: d.id, uid: d.uid, url: d.url, tags: d.tags, first_publication_date: d.first_publication_date })}`);
        }
      }
    } catch (err) {
      console.log(`  ERROR fetching siblings: ${err.message}`);
    }
  } else {
    console.log(`\n--- Sibling pages under "${LCA_PATH_PREFIX}" ---\n  SKIPPED (no type identified in step 3)`);
  }

  // 6. (Added after step 5 showed doc.url is null for every doc — this repo
  // has no route resolver configured, so url-prefix filtering can't work.
  // Pivot to the "LCA" tag itself, and a full uid scan of content_page.)
  console.log(`\n--- Extra: all docs with tag "LCA" (any type, getByTag) ---`);
  try {
    const tagged = await withTimeout(
      client.getByTag('LCA', { pageSize: 100 }),
      TIMEOUT_MS,
      'getByTag(LCA)',
    );
    console.log(`  total_results_size: ${tagged.total_results_size}`);
    for (const d of tagged.results) {
      console.log(`  ${JSON.stringify({ id: d.id, uid: d.uid, type: d.type, tags: d.tags, first_publication_date: d.first_publication_date })}`);
    }
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
  }

  if (lcaType) {
    console.log(`\n--- Extra: full uid scan of type "${lcaType}" for lca/meðaltal-looking uids (all pages) ---`);
    try {
      const all = await withTimeout(
        client.getAllByType(lcaType, { pageSize: 100 }),
        TIMEOUT_MS * 3,
        `getAllByType(${lcaType})`,
      );
      console.log(`  fetched ${all.length} docs of type "${lcaType}" total`);
      const candidates = all.filter(
        (d) => /lca|meðaltal|medaltal|skilagatt|skilagátt|spurt.*svarad|spurt.*svarað|lifsferil/i.test(d.uid ?? '')
          || (Array.isArray(d.tags) && d.tags.some((t) => /lca/i.test(t))),
      );
      for (const d of candidates) {
        console.log(`  ${JSON.stringify({ id: d.id, uid: d.uid, tags: d.tags, first_publication_date: d.first_publication_date })}`);
      }
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
    }
  }

  // 7. Find the missing 2026 RB-blöð report by uid, across all custom types.
  console.log(`\n--- Searching for uid === "${MISSING_REPORT_UID}" across all ${typeIds.length} types ---`);
  let reportDoc = null;
  let reportType = null;
  for (const typeId of typeIds) {
    try {
      const doc = await withTimeout(
        client.getByUID(typeId, MISSING_REPORT_UID),
        TIMEOUT_MS,
        `getByUID(${typeId}, missing report)`,
      );
      if (doc) {
        console.log(`  FOUND in type "${typeId}"`);
        reportDoc = doc;
        reportType = typeId;
        break;
      }
    } catch (err) {
      const msg = err?.message ?? String(err);
      if (/TIMEOUT/.test(msg)) console.log(`  SKIP ${typeId}: ${msg}`);
    }
  }

  if (reportDoc) {
    console.log('\n--- Missing report document ---');
    console.log(JSON.stringify({
      id: reportDoc.id,
      uid: reportDoc.uid,
      type: reportDoc.type,
      tags: reportDoc.tags,
      first_publication_date: reportDoc.first_publication_date,
      last_publication_date: reportDoc.last_publication_date,
    }, null, 2));
    console.log(`  data field keys: ${JSON.stringify(Object.keys(reportDoc.data ?? {}))}`);
    // Dump primitive/shallow values for any key that looks file/link-shaped,
    // so we can tell a PDF field from a rich-text/HTML field without
    // guessing from the key name alone.
    for (const [key, val] of Object.entries(reportDoc.data ?? {})) {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        console.log(`    ${key}: ${JSON.stringify(val).slice(0, 200)}`);
      } else if (Array.isArray(val)) {
        console.log(`    ${key}: [array, length ${val.length}]${val.length ? ' first=' + JSON.stringify(val[0]).slice(0, 150) : ''}`);
      } else {
        console.log(`    ${key}: ${JSON.stringify(val)?.slice(0, 150)}`);
      }
    }
  } else {
    console.log(`\n--- Missing report document ---\n  NOT FOUND via getByUID in any type. Trying a title/uid substring scan of likely report-ish types next.`);
  }

  // 8. Scope of the missing set — total count for the report's type, tag
  // sample on that type, and getByTag checks for candidate scoping tags.
  if (reportType) {
    console.log(`\n--- Total doc count for type "${reportType}" ---`);
    try {
      const page = await withTimeout(client.getByType(reportType, { pageSize: 1 }), TIMEOUT_MS, `getByType(${reportType})`);
      console.log(`  total_results_size: ${page.total_results_size}`);
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
    }

    console.log(`\n--- Distinct tags on a sample page (100) of type "${reportType}" ---`);
    try {
      const sample = await withTimeout(client.getByType(reportType, { pageSize: 100 }), TIMEOUT_MS, `getByType(${reportType}) sample`);
      const tagCounts = new Map();
      for (const d of sample.results) {
        for (const t of d.tags ?? []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      }
      const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
      for (const [tag, count] of sorted) console.log(`  ${tag}: ${count}`);
      if (sorted.length === 0) console.log('  (no tags on any sampled doc)');
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
    }
  } else {
    console.log(`\n--- Scope of missing set ---\n  SKIPPED (report type not identified)`);
  }

  const candidateTags = new Set(['RB Blöð', 'Rb-blöð', 'Skýrslur', 'Rannsóknarskýrslur', 'skyrslur']);
  if (reportDoc) for (const t of reportDoc.tags ?? []) candidateTags.add(t);
  console.log(`\n--- getByTag counts for candidate scoping tags ---`);
  for (const tag of candidateTags) {
    try {
      const res = await withTimeout(client.getByTag(tag, { pageSize: 1 }), TIMEOUT_MS, `getByTag(${tag})`);
      console.log(`  "${tag}": total_results_size=${res.total_results_size}`);
    } catch (err) {
      console.log(`  "${tag}": ERROR (${err.message})`);
    }
  }

  // 9. LCA pages — data field keys for leidbeiningar-lca (fetched as lcaDoc
  // in step 3 above), to see whether it's a PDF-file field or rich text/HTML.
  console.log(`\n--- LCA doc "${LCA_UID}" data field keys (PDF file field vs rich text?) ---`);
  if (lcaDoc) {
    console.log(`  data field keys: ${JSON.stringify(Object.keys(lcaDoc.data ?? {}))}`);
    for (const [key, val] of Object.entries(lcaDoc.data ?? {})) {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        console.log(`    ${key}: ${JSON.stringify(val).slice(0, 200)}`);
      } else if (Array.isArray(val)) {
        console.log(`    ${key}: [array, length ${val.length}]${val.length ? ' first=' + JSON.stringify(val[0]).slice(0, 150) : ''}`);
      } else {
        console.log(`    ${key}: ${JSON.stringify(val)?.slice(0, 150)}`);
      }
    }
  } else {
    console.log('  SKIPPED (lcaDoc not found earlier)');
  }

  // 10. Full list of docs tagged 'Rb-blöð' (the legacy/small tag, distinct
  // from the production 'RB Blöð' tag) — this is the actual scope of "the
  // missing set" if that's the right tag to widen to.
  console.log(`\n--- All docs tagged "Rb-blöð" (legacy tag, repo-wide) ---`);
  try {
    const legacyTagged = await withTimeout(client.getByTag('Rb-blöð', { pageSize: 20 }), TIMEOUT_MS, `getByTag(Rb-blöð) full list`);
    console.log(`  total_results_size: ${legacyTagged.total_results_size}`);
    for (const d of legacyTagged.results) {
      console.log(`  ${JSON.stringify({ id: d.id, uid: d.uid, type: d.type, tags: d.tags, first_publication_date: d.first_publication_date })}`);
    }
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
  }

  // 11. Full (untruncated) body field of the missing report, specifically
  // hunting for any file/PDF link inside its slices (vs. the RB-blöð
  // "document" type's direct PDF file field).
  if (reportDoc) {
    console.log(`\n--- Missing report: full "body" slice structure (hunting for a PDF/file link) ---`);
    const body = reportDoc.data?.body ?? [];
    console.log(`  ${body.length} slice(s)`);
    body.forEach((slice, i) => {
      console.log(`  slice[${i}] slice_type=${slice.slice_type ?? '(none)'}`);
      const str = JSON.stringify(slice);
      const hasFileLink = /"link_type"\s*:\s*"Media"|"kind"\s*:\s*"file"|\.pdf/i.test(str);
      console.log(`    contains file/PDF-looking reference: ${hasFileLink}`);
      if (hasFileLink) console.log(`    ${str.slice(0, 500)}`);
    });
    // Also scan every top-level data field (not just body) for a Media link,
    // in case the PDF lives in a field we haven't printed in full above.
    const fullDataStr = JSON.stringify(reportDoc.data ?? {});
    console.log(`  Any "link_type":"Media" anywhere in reportDoc.data: ${/"link_type"\s*:\s*"Media"/i.test(fullDataStr)}`);
    console.log(`  Any ".pdf" anywhere in reportDoc.data: ${/\.pdf/i.test(fullDataStr)}`);
  }

  console.log('\n=== Done ===');
}

main().catch((err) => {
  console.log('FATAL:', err);
  process.exit(1);
});
