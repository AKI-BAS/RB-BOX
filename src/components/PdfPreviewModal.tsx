'use client';

import { useEffect } from 'react';
import { PdfViewer } from '@/components/PdfViewer';
import { resolvePdfSrc, type PreviewableDoc } from '@/lib/pdf-src';

export type { PreviewableDoc };

interface PdfPreviewModalProps {
  doc: PreviewableDoc;
  lang: 'is' | 'en';
  onClose: () => void;
}

export function PdfPreviewModal({ doc, lang, onClose }: PdfPreviewModalProps) {
  const pdfSrc = resolvePdfSrc(doc);
  const textPreview = doc.extracted_text?.trim().slice(0, 4000) || null;
  const title = lang === 'en' && doc.title_en ? doc.title_en : doc.title;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full h-[92vh] sm:w-[90vw] sm:max-w-3xl sm:h-[85vh] bg-paper-surface dark:bg-ink-surface rounded-t-2xl sm:rounded-2xl border border-paper-border dark:border-ink-border shadow-xl flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="shrink-0 h-12 px-4 flex items-center gap-2 border-b border-paper-border dark:border-ink-border">
          <span className="text-[13px] font-medium truncate flex-1" title={title}>
            {title}
          </span>
          {pdfSrc && (
            <a
              href={pdfSrc}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 h-8 px-2.5 rounded-md text-[12px] font-medium flex items-center gap-1.5 border border-paper-border dark:border-ink-border text-paper-soft dark:text-ink-soft hover:text-brick-500 hover:border-brick-500/40 transition"
            >
              ↗ {lang === 'is' ? 'Opna í nýjum glugga' : 'Open in new tab'}
            </a>
          )}
          <button
            onClick={onClose}
            aria-label={lang === 'is' ? 'Loka' : 'Close'}
            className="shrink-0 w-8 h-8 rounded-md flex items-center justify-center text-paper-faint dark:text-ink-faint hover:text-brick-500 hover:bg-paper-muted dark:hover:bg-ink-muted transition"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <PdfViewer pdfSrc={pdfSrc} title={title} textPreview={textPreview} lang={lang} className="flex-1 min-h-0" />
      </div>
    </div>
  );
}
