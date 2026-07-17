'use client';

import { type RefObject, useMemo, useState } from 'react';
import { t, type Lang } from '@/lib/i18n';
import { Highlighted } from '@/components/search/Highlighted';
import { AgeBadge } from '@/components/AgeBadge';
import { deriveSearchTerms, expandCodeVariants, buildSnippet } from '@/lib/search/highlight';
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
  /** True when any Browse-panel filter (access/source/category) is applied —
   * distinguishes "your filters matched nothing" from "you haven't searched
   * yet", which look identical if this signal is missing (see onClearFilters). */
  hasActiveFilters: boolean;
  onClearFilters: () => void;
  /** Corrected query string to offer as "Áttir þú við: …?", or null when
   * there's nothing worth suggesting (see suggestCorrection in
   * lib/search/didyoumean.ts for when the parent computes this). */
  suggestion: string | null;
  onSuggestionClick: (term: string) => void;
  ready: boolean;
  onOpen: (id: string) => void;
  onPreview: (doc: Document) => void;
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

const BYGGINGARREGLUGERD_SLUG = 'byggingarreglugerd';
const GREIN_BODY_TRUNCATE_AT = 1500;
const GREIN_BODY_SHOW_CHARS = 1000;

interface GreinBreadcrumb {
  hluti: string;
  kafli: string;
  grein: string;
}

/**
 * byggingarreglugerð's Hluti/Kafli/Grein hierarchy lives under
 * metadata.scraper.adapter_meta (set by the adapter — see
 * src/lib/scrapers/adapters/byggingarreglugerd.ts), not a top-level
 * metadata.hluti/kafli. Falls back to parsing reference_code ("H.K.G") if
 * adapter_meta is ever missing/incomplete, so a doc with only a bare
 * reference_code still gets a breadcrumb instead of none showing at all.
 */
function getGreinBreadcrumb(doc: Document): GreinBreadcrumb | null {
  const meta = (doc.metadata as any)?.scraper?.adapter_meta as
    | { hluti?: string; kafli?: string; grein?: string }
    | undefined;
  if (meta?.hluti && meta?.kafli && meta?.grein) {
    return {
      hluti: meta.hluti,
      kafli: `${meta.hluti}.${meta.kafli}`,
      grein: `${meta.hluti}.${meta.kafli}.${meta.grein}`,
    };
  }
  const parts = doc.reference_code?.split('.').filter(Boolean);
  if (parts && parts.length === 3) {
    const [h, k, g] = parts;
    return { hluti: h, kafli: `${h}.${k}`, grein: `${h}.${k}.${g}` };
  }
  return null;
}

/** The stored title already carries its own number prefix ("1.1.1. Markmið")
 * — redundant once the breadcrumb right above it already reads "Grein 1.1.1". */
function cleanGreinTitle(title: string): string {
  const stripped = title.replace(/^\d+(?:\.\d+){1,3}\.\s*/, '').trim();
  return stripped || title;
}

/** Grein bodies are the full regulation text, not a snippet — long articles
 * (>1500 chars) get a show more/less toggle instead of being cut off cold.
 * A real subcomponent (not inline in .map()) so it can own its own expand
 * state per row without breaking the rules of hooks. */
function GreinBody({ text, terms, lang }: { text: string | null; terms: string[]; lang: Lang }) {
  const [expanded, setExpanded] = useState(false);

  if (!text?.trim()) {
    return (
      <p className="mt-2 text-[12.5px] italic text-paper-faint dark:text-ink-faint">
        {t(lang, 'contentUnavailable')}
      </p>
    );
  }

  const isLong = text.length > GREIN_BODY_TRUNCATE_AT;
  const shown = isLong && !expanded ? `${text.slice(0, GREIN_BODY_SHOW_CHARS)}…` : text;

  return (
    <div className="mt-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-paper-soft dark:text-ink-soft">
      <Highlighted text={shown} terms={terms} />
      {isLong && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="mt-1.5 block text-[11.5px] font-medium text-brick-500 hover:text-brick-600"
        >
          {expanded ? t(lang, 'showLess') : t(lang, 'showMore')}
        </button>
      )}
    </div>
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
  hasActiveFilters,
  onClearFilters,
  suggestion,
  onSuggestionClick,
  ready,
  onOpen,
  onPreview,
}: SpotlightProps) {
  const sourceById = useMemo(() => {
    const m: Record<string, Source> = {};
    sources.forEach((s) => (m[s.id] = s));
    return m;
  }, [sources]);

  // Looked up by slug (a stable, semantic identifier already used elsewhere
  // in this file, e.g. DOC_TYPE_LABEL) rather than a hardcoded source UUID.
  const byggingarreglugerdSourceId = useMemo(
    () => sources.find((s) => s.slug === BYGGINGARREGLUGERD_SLUG)?.id,
    [sources],
  );

  const activeCategoryName = useMemo(() => {
    if (!activeCategory) return null;
    const c = categories.find((x) => x.id === activeCategory);
    if (!c) return null;
    return lang === 'en' && c.name_en ? c.name_en : c.name;
  }, [activeCategory, categories, lang]);

  const matchTerms = tokenize(query);
  // Same derivation runSearch() uses to build the ilike query — highlighting
  // must match exactly what the DB matched on, not an independent tokenizer.
  // Also expanded through expandCodeVariants so a compact code query ("ei60")
  // highlights a spaced occurrence in the text ("EI 60") too, same as it's
  // matched in the query itself.
  const highlightTerms = useMemo(
    () => deriveSearchTerms(query).flatMap(expandCodeVariants),
    [query],
  );

  return (
    <div className="rounded-xl bg-paper-surface dark:bg-ink-surface border border-paper-border dark:border-ink-border shadow-sm shadow-black/[0.04] overflow-hidden flex flex-col sm:h-[calc(100vh-6rem)]">
      {/* Search row */}
      <div className="shrink-0 flex items-center gap-3 px-4 h-[52px] border-b border-paper-border dark:border-ink-border">
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
        <div className="shrink-0 px-4 py-2 text-[11.5px] text-paper-soft dark:text-ink-soft border-b border-paper-border dark:border-ink-border flex items-center gap-1.5 flex-wrap">
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

      {/* "Did you mean" — shown whenever the parent found a plausible
          correction for a scant-results query, independent of whether the
          empty-state or a thin results list renders below it. */}
      {ready && suggestion && (
        <div className="shrink-0 px-4 py-2 text-[11.5px] border-b border-paper-border dark:border-ink-border flex items-center gap-1.5 flex-wrap">
          <span className="text-paper-faint dark:text-ink-faint">
            {t(lang, 'didYouMean')}:
          </span>
          <button
            onClick={() => onSuggestionClick(suggestion)}
            className="text-brick-500 hover:text-brick-600 font-medium underline decoration-dotted"
          >
            {suggestion}
          </button>
        </div>
      )}

      {/* Results / empty state */}
      {!ready ? (
        <div className="p-8 text-center text-xs text-paper-faint dark:text-ink-faint sm:flex-1 sm:flex sm:items-center sm:justify-center">
          …
        </div>
      ) : results.length === 0 ? (
        <div className="p-8 text-center text-xs text-paper-faint dark:text-ink-faint sm:flex-1 sm:flex sm:flex-col sm:items-center sm:justify-center gap-3">
          {/* A query or an active filter that matches nothing is a genuine
              "no results" state, not "you haven't searched yet" — those look
              identical without checking hasActiveFilters too, which is
              exactly what made a stuck zero-matching filter look like a
              broken search (see commit fixing this). */}
          {query.trim() || hasActiveFilters ? (
            <>
              <span>{t(lang, 'noResults')}</span>
              {hasActiveFilters && (
                <button
                  onClick={onClearFilters}
                  className="h-7 px-3 rounded-md text-[11px] font-medium bg-brick-500 hover:bg-brick-600 text-white transition"
                >
                  {t(lang, 'clearAll')}
                </button>
              )}
            </>
          ) : (
            `${t(lang, 'startTyping')} [.`
          )}
        </div>
      ) : (
        <>
          <div className="shrink-0 px-4 py-2 text-[10px] uppercase tracking-[0.08em] text-paper-faint dark:text-ink-faint bg-paper-muted dark:bg-ink-muted flex items-center gap-1.5">
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
          <ul className="max-h-[60vh] sm:max-h-none sm:flex-1 sm:min-h-0 overflow-y-auto">
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
              ].filter(Boolean) as string[];
              const title = lang === 'en' && doc.title_en ? doc.title_en : doc.title;
              const snippet = buildSnippet(doc.extracted_text, highlightTerms);
              const isGrein =
                Boolean(byggingarreglugerdSourceId) && doc.source_id === byggingarreglugerdSourceId;
              const breadcrumb = isGrein ? getGreinBreadcrumb(doc) : null;

              return (
                <li key={doc.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpen(doc.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpen(doc.id);
                      }
                    }}
                    aria-label={title}
                    className={`group w-full flex items-start gap-3 pl-4 pr-3 py-3 text-left border-t border-paper-border dark:border-ink-border first:border-t-0 transition cursor-pointer ${
                      isTop
                        ? 'bg-brick-500/[0.06] border-l-2 border-l-brick-500 pl-[14px]'
                        : 'hover:bg-paper-muted dark:hover:bg-ink-muted'
                    }`}
                  >
                    <ResultIcon doc={doc} accent={isTop} />
                    {isGrein ? (
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#FCEBEB] text-[#A32D2D] dark:bg-[rgba(163,45,45,0.2)] dark:text-[#F09595]">
                            {sourceLabel ?? 'Byggingarreglugerð'}
                          </span>
                          {doc.published_date && (
                            <span className="text-[10.5px] text-paper-faint dark:text-ink-faint shrink-0">
                              {t(lang, 'lastAmended')}: {doc.published_date.slice(0, 10)}
                            </span>
                          )}
                        </div>
                        {breadcrumb && (
                          <div className="mt-1 text-[10.5px] font-mono text-paper-faint dark:text-ink-faint">
                            Hluti {breadcrumb.hluti} · Kafli {breadcrumb.kafli} · Grein {breadcrumb.grein}
                          </div>
                        )}
                        <div className={`mt-1 text-[13.5px] ${isTop ? 'font-medium' : ''}`}>
                          <Highlighted text={cleanGreinTitle(title)} terms={highlightTerms} />
                        </div>
                        <GreinBody text={doc.extracted_text} terms={highlightTerms} lang={lang} />
                        {doc.external_url && (
                          <a
                            href={doc.external_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md bg-brick-500 px-3 text-[11.5px] font-medium text-white transition hover:bg-brick-600"
                          >
                            ↗ {t(lang, 'viewOnSource')}
                          </a>
                        )}
                      </div>
                    ) : (
                      <div className="flex-1 min-w-0">
                        <div
                          className={`text-[13.5px] truncate ${
                            isTop ? 'font-medium' : ''
                          }`}
                        >
                          <Highlighted text={title} terms={highlightTerms} />
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <div className="text-[10.5px] font-mono text-paper-faint dark:text-ink-faint truncate tracking-tight min-w-0 flex-1">
                            {metaParts.join(' · ')}
                          </div>
                          <AgeBadge date={doc.published_date} locale={lang} />
                        </div>
                        {snippet && (
                          <p className="text-[11.5px] text-paper-soft dark:text-ink-soft opacity-70 line-clamp-2 mt-1">
                            <Highlighted text={snippet} terms={highlightTerms} />
                          </p>
                        )}
                      </div>
                    )}
                    {/* Distinct control from the row's own click-to-open — always
                        visible (not hover-only) so it's discoverable on touch. */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onPreview(doc);
                      }}
                      title={lang === 'is' ? 'Forskoðun' : 'Preview'}
                      aria-label={lang === 'is' ? 'Forskoðun' : 'Preview'}
                      className="mt-0.5 shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-paper-faint dark:text-ink-faint hover:text-brick-500 hover:bg-paper-muted dark:hover:bg-ink-muted transition"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    </button>
                    {isTop && (
                      <kbd className="mt-1 ml-1 shrink-0">↵</kbd>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
