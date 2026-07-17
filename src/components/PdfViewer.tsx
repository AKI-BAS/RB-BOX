'use client';

import { useEffect, useState } from 'react';

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

// If the iframe hasn't fired `onLoad` within this window, the source is
// either slow or (more likely for an external host) silently refusing to be
// framed — X-Frame-Options/CSP blocks don't raise a catchable JS error, so a
// timeout is the only practical signal available. Generous enough to not
// false-positive on a normal PDF over a normal connection.
const LOAD_TIMEOUT_MS = 6000;

function TextPreview({ text, lang }: { text: string; lang: 'is' | 'en' }) {
  return (
    <div className="h-full overflow-y-auto p-6">
      <p className="text-[11px] uppercase tracking-wide text-paper-faint dark:text-ink-faint mb-3">
        {lang === 'is' ? 'Útdráttur úr skjalinu' : 'Extracted text'}
      </p>
      <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-paper-soft dark:text-ink-soft">
        {text}
      </p>
    </div>
  );
}

function EmptyState({ lang }: { lang: 'is' | 'en' }) {
  return (
    <div className="h-full flex items-center justify-center p-8 text-center">
      <p className="text-[13px] text-paper-faint dark:text-ink-faint">
        {lang === 'is' ? 'Engin forskoðun tiltæk fyrir þetta skjal.' : 'No preview available for this document.'}
      </p>
    </div>
  );
}

export interface PdfViewerProps {
  pdfSrc: string | null;
  title: string;
  textPreview: string | null;
  lang: 'is' | 'en';
  /** Sizing/positioning is the caller's call (modal body vs. an inline page
   * section have very different needs) — pass height/width classes here. */
  className?: string;
}

/** The actual iframe-with-fallback body — shared between PdfPreviewModal
 * (a floating panel) and the document detail page's inline embed. Handles
 * its own load-state; the caller only decides where/how big to put it. */
export function PdfViewer({ pdfSrc, title, textPreview, lang, className }: PdfViewerProps) {
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'maybe-blocked'>('loading');
  const [peekAnyway, setPeekAnyway] = useState(false);

  useEffect(() => {
    setLoadState('loading');
    setPeekAnyway(false);
    if (!pdfSrc) return;
    const timer = setTimeout(() => {
      setLoadState((s) => (s === 'loading' ? 'maybe-blocked' : s));
    }, LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pdfSrc]);

  const showBlockedFallback = loadState === 'maybe-blocked' && !peekAnyway;

  return (
    <div className={`relative bg-paper-muted/30 dark:bg-ink-muted/30 ${className ?? ''}`}>
      {!pdfSrc ? (
        textPreview ? <TextPreview text={textPreview} lang={lang} /> : <EmptyState lang={lang} />
      ) : (
        <>
          <iframe
            key={pdfSrc}
            src={pdfSrc}
            title={title}
            className="w-full h-full border-0"
            onLoad={() => setLoadState((s) => (s === 'loading' ? 'loaded' : s))}
          />
          {loadState === 'loading' && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span className="text-[12px] text-paper-faint dark:text-ink-faint">
                {lang === 'is' ? 'Sæki forskoðun…' : 'Loading preview…'}
              </span>
            </div>
          )}
          {showBlockedFallback && (
            <div className="absolute inset-0 bg-paper-surface dark:bg-ink-surface flex flex-col items-center justify-center gap-4 p-6 text-center overflow-y-auto">
              <p className="text-[13px] text-paper-soft dark:text-ink-soft max-w-sm">
                {lang === 'is'
                  ? 'Ekki tókst að birta PDF-ið hér — heimildin leyfir líklega ekki ívafningu (iframe).'
                  : "Couldn't display the PDF here — the source likely blocks embedding (iframe)."}
              </p>
              {textPreview && (
                <div className="w-full max-w-md text-left text-[12px] leading-relaxed text-paper-soft dark:text-ink-soft max-h-40 overflow-y-auto border border-paper-border dark:border-ink-border rounded-md p-3 whitespace-pre-wrap">
                  {textPreview}
                </div>
              )}
              <div className="flex items-center gap-2">
                <a
                  href={pdfSrc}
                  target="_blank"
                  rel="noreferrer"
                  className="h-9 px-4 rounded-lg bg-brick-500 hover:bg-brick-600 text-white text-sm font-medium flex items-center gap-2"
                >
                  ↗ {lang === 'is' ? 'Opna upprunalega PDF' : 'Open original PDF'}
                </a>
                <button
                  onClick={() => setPeekAnyway(true)}
                  className="h-9 px-3 rounded-lg text-[12px] text-paper-faint dark:text-ink-faint hover:text-brick-500 transition"
                >
                  {lang === 'is' ? 'Reyna samt' : 'Try anyway'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
