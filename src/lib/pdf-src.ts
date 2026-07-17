// Deliberately NOT a 'use client' module — this must be safely callable from
// server components (document/[id]/page.tsx) as well as client components
// (PdfPreviewModal, PdfViewer). A plain function exported from a 'use
// client' file becomes a client-reference boundary for everything in that
// module, not just its React components; invoking it directly during
// server-side render throws. Keep this one pure and directive-free.

/** Just the fields a preview needs — works for both the public search results
 * row shape, the admin documents table row shape, and the document detail
 * page's server-fetched row (all come from `select('*')` on `documents`, so
 * this is always a safe subset). */
export interface PreviewableDoc {
  id: string;
  title: string;
  title_en?: string | null;
  file_path?: string | null;
  external_url?: string | null;
  source_url?: string | null;
  extracted_text?: string | null;
}

/**
 * The one place this priority is decided: our own signed-download route
 * (self-hosted primary file) → canonical source link (source_url, e.g. an
 * hms-rb-blod-web guidance page) → the fetched-file URL (external_url —
 * every HMS PDF-archive doc has this, since that adapter never gets a
 * file_path post-retrofit). Used by the modal, the inline detail-page
 * viewer, and the detail page's own "Skoða PDF" button href — one formula,
 * not reimplemented per call site.
 */
export function resolvePdfSrc(doc: PreviewableDoc): string | null {
  return doc.file_path ? `/api/download/${doc.id}` : doc.source_url ?? doc.external_url ?? null;
}
