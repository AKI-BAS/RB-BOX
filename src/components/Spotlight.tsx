'use client';

import { type RefObject, useMemo } from 'react';
import { t, type Lang } from '@/lib/i18n';
import type { Document, Source, Category } from '@/types/database';

interface SpotlightProps {
  lang: Lang;
  inputRef: RefObject<HTMLInputElement>;
  query: string;
  onQueryChange: (q: string) => void;
  results: Document[];
  sources: Source[];
  categories: Category[];
  activeCategory: string | null;
  ready: boolean;
  onOpen: (id: string) => void;
}

const DOC_TYPE_LABEL: Record<string, string> = {
  rb_blad: 'RB-blað',
  leidbeining: 'Leiðbeining',
  rannsokn: 'Rannsókn',
  handbok: 'Handbók',
  annad: 'Annað',
};

// Icon by "how the user opens it" — PDF for stored files, external-arrow for
// linked resources, lock for internal-only. Distinguishes at a glance the
// four kinds of thing a result row can be.
function ResultIcon({
  doc,
  accent,
}: {
  doc: Document;
  accent: boolean;
}) {
  const cls = `mt-0.5 shrink-0 ${
    accent ? 'text-brick-500' : 'text-paper-faint dark:text-ink-faint'
  }`;

  if (doc.access_level === 'internal' || doc.access_level === 'restricted') {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={cls}>
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    );
  }
  if (doc.external_url && !doc.file_path) {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={cls}>
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </svg>
    );
  }
  // Default: document icon (PDF-ish)
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={cls}>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M9 13h6M9 17h4" />
    </svg>
  );
}

// Tokenize the user's query into unique lowercased words we can display
// as "Matched on" chips. This is a display approximation — accurate to what
// the user typed, which is the mental model that matters here.
function tokenize(q: string): string[] {
  const cleaned = q.trim().toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const parts = cleaned.split(/\s+/).filter((p) => p.length >= 2);
  return Array.from(new Set(parts));
}

export function Spotlight({
  lang,
  inputRef,
  query,
  onQueryChange,
  results,
  sources,
  categories,
  activeCategory,
  ready,
  onOpen,
}: SpotlightProps) {
  const sourceById = useMemo(() => {
    const m: Record<string, Source> = {};
    sources.forEach((s) => (m[s.id] = s));
    return m;
  }, [sources]);

  const activeCategoryName = useMemo(() => {
    if (!activeCategory) return null;
    const c = categories.find((x) => x.id === activeCategory);
    if (!c) return null;
    return lang === 'en' && c.name_en ? c.name_en : c.name;
  }, [activeCategory, categories, lang]);

  const matchTerms = tokenize(query);

  return (
    <div className="rounded-xl bg-paper-surface dark:bg-ink-surface border border-paper-border dark:border-ink-border shadow-sm shadow-black/[0.04] overflow-hidden">
      {/* Search row */}
      <div className="flex items-center gap-3 px-4 h-[52px] border-b border-paper-border dark:border-ink-border">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-paper-faint dark:text-ink-faint shrink-0"
        >
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={t(lang, 'searchPlaceholder')}
          className="flex-1 bg-transparent outline-none text-[14px] placeholder:text-paper-faint dark:placeholder:text-ink-faint"
        />
        <kbd className="shrink-0">⌘K</kbd>
      </div>

      {/* Matched-on chips — only when there's a query AND we have results */}
      {ready && query.trim() && results.length > 0 && matchTerms.length > 0 && (
        <div className="px-4 py-2 text-[11.5px] text-paper-soft dark:text-ink-soft border-b border-paper-border dark:border-ink-border flex items-center gap-1.5 flex-wrap">
          <span className="text-paper-faint dark:text-ink-faint">
            {t(lang, 'matchedOn')}:
          </span>
          {matchTerms.map((term, i) => (
            <span key={term}>
              <span className="match-term">{term}</span>
              {i < matchTerms.length - 1 && (
                <span className="text-paper-faint dark:text-ink-faint mx-1">·</span>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Results / empty state */}
      {!ready ? (
        <div className="p-8 text-center text-xs text-paper-faint dark:text-ink-faint">
          …
        </div>
      ) : results.length === 0 ? (
        <div className="p-8 text-center text-xs text-paper-faint dark:text-ink-faint">
          {query.trim()
            ? t(lang, 'noResults')
            : `${t(lang, 'startTyping')} [.`}
        </div>
      ) : (
        <>
          <div className="px-4 py-2 text-[10px] uppercase tracking-[0.08em] text-paper-faint dark:text-ink-faint bg-paper-muted dark:bg-ink-muted flex items-center gap-1.5">
            <span>{results.length}</span>
            <span>
              {results.length === 1 ? t(lang, 'result') : t(lang, 'results')}
            </span>
            {activeCategoryName && (
              <>
                <span className="text-paper-border dark:text-ink-border">·</span>
                <span>
                  {lang === 'is' ? 'í' : 'in'}
                </span>
                <span className="text-brick-500 font-medium">
                  {activeCategoryName}
                </span>
              </>
            )}
          </div>
          <ul className="max-h-[60vh] overflow-y-auto">
            {results.map((doc, i) => {
              const isTop = i === 0;
              const source = doc.source_id
                ? sourceById[doc.source_id]
                : undefined;
              const sourceLabel = source
                ? (lang === 'en' && source.name_en ? source.name_en : source.name)
                : undefined;
              const metaParts = [
                doc.reference_code,
                sourceLabel,
                doc.published_date?.slice(0, 7),
              ].filter(Boolean) as string[];

              return (
                <li key={doc.id}>
                  <button
                    onClick={() => onOpen(doc.id)}
                    className={`w-full flex items-start gap-3 pl-4 pr-3 py-3 text-left border-t border-paper-border dark:border-ink-border first:border-t-0 transition ${
                      isTop
                        ? 'bg-brick-500/[0.06] border-l-2 border-l-brick-500 pl-[14px]'
                        : 'hover:bg-paper-muted dark:hover:bg-ink-muted'
                    }`}
                  >
                    <ResultIcon doc={doc} accent={isTop} />
                    <div className="flex-1 min-w-0">
                      <div
                        className={`text-[13.5px] truncate ${
                          isTop ? 'font-medium' : ''
                        }`}
                      >
                        {lang === 'en' && doc.title_en
                          ? doc.title_en
                          : doc.title}
                      </div>
                      <div className="text-[10.5px] font-mono text-paper-faint dark:text-ink-faint mt-0.5 truncate tracking-tight">
                        {metaParts.join(' · ')}
                      </div>
                    </div>
                    {isTop && (
                      <kbd className="mt-1 ml-1 shrink-0">↵</kbd>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
