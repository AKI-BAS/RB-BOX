'use client';

import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { t, type Lang } from '@/lib/i18n';
import { BrowsePanel, type Filters, type Tab } from '@/components/BrowsePanel';
import { Spotlight } from '@/components/Spotlight';
import { PdfPreviewModal } from '@/components/PdfPreviewModal';
import { deriveSearchTerms, expandCodeVariants } from '@/lib/search/highlight';
import { buildVocabulary, suggestCorrection } from '@/lib/search/didyoumean';
import type { Document, Source, Category } from '@/types/database';

// Comfortably above the current library size (~170 published docs) so an
// unfiltered or source-filtered browse shows everything, not just a recent
// slice, without needing real pagination yet.
const RESULTS_LIMIT = 500;

// "Did you mean" only makes sense once results are scant enough that a typo
// is the likely explanation — anything above this still looks like a normal
// (if narrow) result set, not a search that silently found nothing useful.
const FEW_RESULTS_THRESHOLD = 2;

const THEME_KEY = 'rb-theme';
const FILTERS_KEY = 'rb-filters';

function readStoredTheme(): 'light' | 'dark' | 'system' | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : null;
  } catch {
    return null;
  }
}

function readStoredFilters(): Filters | null {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      sources: new Set(parsed.sources ?? []),
      category: parsed.category ?? null,
    };
  } catch {
    return null;
  }
}

// Format "Uppfært fyrir 2 klst." from a Date. Approximate; only shown when
// meaningful (i.e. we have a real latest-update timestamp).
function relativeSync(lang: Lang, lastUpdated: string | null): string | null {
  if (!lastUpdated) return null;
  const then = new Date(lastUpdated).getTime();
  const now = Date.now();
  const diffMin = Math.round((now - then) / 60_000);
  if (Number.isNaN(diffMin) || diffMin < 0) return null;

  if (lang === 'is') {
    if (diffMin < 1) return 'Uppfært núna';
    if (diffMin < 60) return `Uppfært fyrir ${diffMin} mín.`;
    const h = Math.round(diffMin / 60);
    if (h < 24) return `Uppfært fyrir ${h} klst.`;
    const d = Math.round(h / 24);
    return `Uppfært fyrir ${d} d.`;
  } else {
    if (diffMin < 1) return 'Synced just now';
    if (diffMin < 60) return `Synced ${diffMin}m ago`;
    const h = Math.round(diffMin / 60);
    if (h < 24) return `Synced ${h}h ago`;
    const d = Math.round(h / 24);
    return `Synced ${d}d ago`;
  }
}

export default function HomePage() {
  const router = useRouter();
  const [lang, setLang] = useState<Lang>('is');
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');
  const [browseOpen, setBrowseOpen] = useState(true);
  const [ready, setReady] = useState(false);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Document[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [sourceCounts, setSourceCounts] = useState<Record<string, number>>({});
  const [categories, setCategories] = useState<Category[]>([]);
  const [totalDocs, setTotalDocs] = useState<number>(0);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({
    sources: new Set<string>(),
    category: null,
  });
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [profile, setProfile] = useState<{
    username: string;
    full_name: string | null;
    role: string;
  } | null>(null);
  const [previewDoc, setPreviewDoc] = useState<Document | null>(null);
  // Vocabulary of known-good words for "did you mean" — built once from
  // category/tag names + document titles (see initial-load effect below).
  const [vocabulary, setVocabulary] = useState<Set<string>>(new Set());

  const searchRef = useRef<HTMLInputElement>(null);

  // Restore this browser's theme + filters before anything else paints or
  // fetches — a remount (e.g. back-navigation from /document/[id]) must not
  // silently drop what the user picked, and must win over whatever's in the
  // DB profile row (which may just be the untouched 'system' default).
  useLayoutEffect(() => {
    const storedTheme = readStoredTheme();
    if (storedTheme) setTheme(storedTheme);
    const storedFilters = readStoredFilters();
    if (storedFilters) setFilters(storedFilters);
  }, []);

  // Initial load
  useEffect(() => {
    const supabase = createClient();

    async function load() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user) {
        const { data: prof } = await supabase
          .from('profiles')
          .select('username, full_name, role, language, theme')
          .eq('id', user.id)
          .single();
        if (prof) {
          setProfile({
            username: prof.username,
            full_name: prof.full_name,
            role: prof.role,
          });
          setLang((prof.language as Lang) || 'is');
          // Only fall back to the DB's theme when this browser has never
          // stored one of its own — otherwise this clobbers a manual toggle
          // every time the page remounts.
          if (!readStoredTheme()) {
            setTheme((prof.theme as 'light' | 'dark' | 'system') || 'system');
          }
        }
      }

      const [
        { data: srcs },
        { data: cats },
        { data: docCounts },
        { data: latest },
        { data: tagRows },
        { data: tabRows },
      ] = await Promise.all([
        supabase.from('sources').select('*').eq('is_active', true).order('name'),
        supabase.from('categories').select('*').order('sort_order'),
        supabase
          .from('documents')
          .select('source_id, updated_at, title, title_en')
          .eq('status', 'published'),
        supabase
          .from('documents')
          .select('updated_at')
          .eq('status', 'published')
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        // Best-effort: only feeds the "did you mean" vocabulary below, so a
        // missing/renamed table here shouldn't break the rest of the page.
        supabase.from('tags').select('name'),
        supabase.from('tabs').select('*').eq('is_active', true).order('sort_order'),
      ]);

      if (srcs) setSources(srcs);
      if (cats) setCategories(cats);
      if (tabRows) setTabs(tabRows as Tab[]);
      if (docCounts) {
        const counts: Record<string, number> = {};
        docCounts.forEach((d: any) => {
          if (d.source_id) counts[d.source_id] = (counts[d.source_id] || 0) + 1;
        });
        setSourceCounts(counts);
        setTotalDocs(docCounts.length);
      }
      if (latest?.updated_at) setLastSync(latest.updated_at);

      const vocabTexts: Array<string | null | undefined> = [];
      (cats ?? []).forEach((c) => {
        vocabTexts.push(c.name, c.name_en);
      });
      (tagRows ?? []).forEach((tg: any) => vocabTexts.push(tg.name));
      (docCounts ?? []).forEach((d: any) => {
        vocabTexts.push(d.title, d.title_en);
      });
      setVocabulary(buildVocabulary(vocabTexts));

      setReady(true);
    }

    load();
  }, []);

  const runSearch = useCallback(async () => {
    const supabase = createClient();
    // Category lives in the many-to-many document_categories table, not a
    // column on documents — filtering by it requires an inner-joined embed
    // so PostgREST restricts the parent rows, not just a plain select.
    const selectCols = filters.category
      ? '*, document_categories!inner(category_id)'
      : '*';
    let q = supabase
      .from('documents')
      .select(selectCols)
      .eq('status', 'published')
      .limit(RESULTS_LIMIT);

    if (query.trim()) {
      // Plain ilike substring search rather than FTS: websearch_to_tsquery
      // only matches whole lexemes (no prefix/substring), so "vot" never
      // matched "votrými" and multi-word queries needed the config used to
      // build search_vector to line up exactly with the query's config.
      // Each term is required (ANDed via repeated .or() calls — PostgREST
      // ANDs distinct filter params, including repeated `or` groups) and
      // matches if it's a substring of ANY of the columns below (ORed
      // within one .or() call). \p{L} keeps Icelandic letters (á, í, ý,
      // ð, þ, ö) intact and only strips characters that could break the
      // PostgREST filter-string syntax (commas, parens, wildcards).
      const terms = deriveSearchTerms(query);

      // Tags live in a many-to-many join (document_tags -> tags), so a term
      // matching a tag can't be expressed as a plain column ilike in the
      // same .or() group as title/description. Resolve it in a separate
      // step per term: find the document ids tagged with a matching tag,
      // then fold those ids into that term's .or() group via id.in(...).
      // A term typed compact ("ei60") is expanded to also try a spaced
      // variant ("ei 60") so it matches stored text like "EI 60" — see
      // expandCodeVariants' doc comment. Plain words are returned as a
      // single-element array, so this is a no-op for the common case.
      const termVariants = terms.map(expandCodeVariants);

      const tagDocIdsByTerm = await Promise.all(
        termVariants.map(async (variants) => {
          const orClause = variants.map((v) => `tags.name.ilike.%${v}%`).join(',');
          const { data: tagRows } = await supabase
            .from('document_tags')
            .select('document_id, tags!inner(name)')
            .or(orClause)
            .limit(500);
          return (tagRows ?? []).map((r: any) => r.document_id as string);
        }),
      );

      termVariants.forEach((variants, i) => {
        const clauses: string[] = [];
        variants.forEach((v) => {
          const pattern = `%${v}%`;
          clauses.push(
            `title.ilike.${pattern}`,
            `title_en.ilike.${pattern}`,
            `description.ilike.${pattern}`,
            `description_en.ilike.${pattern}`,
            `reference_code.ilike.${pattern}`,
            `source_ref.ilike.${pattern}`,
            `extracted_text.ilike.${pattern}`,
          );
        });
        const tagDocIds = tagDocIdsByTerm[i];
        if (tagDocIds.length > 0) {
          clauses.push(`id.in.(${tagDocIds.join(',')})`);
        }
        q = q.or(clauses.join(','));
      });
    }
    if (filters.sources.size > 0) {
      q = q.in('source_id', Array.from(filters.sources));
    }
    if (filters.category) {
      q = q.eq('document_categories.category_id', filters.category);
    }
    q = q.order('published_date', { ascending: false, nullsFirst: false });

    const { data } = await q;
    if (data) setResults(data as unknown as Document[]);
  }, [query, filters]);

  // A tab replaces the normal document list rather than filtering it —
  // pulled straight from tab_documents in its own sort order, bypassing
  // runSearch/query/filters entirely while active.
  const loadTabResults = useCallback(async (tabId: string) => {
    const supabase = createClient();
    const { data } = await supabase
      .from('tab_documents')
      .select('sort_order, documents(*)')
      .eq('tab_id', tabId)
      .order('sort_order');
    const docs = (data ?? [])
      .map((row: any) => row.documents)
      .filter(Boolean) as Document[];
    setResults(docs);
  }, []);

  useEffect(() => {
    if (activeTabId) {
      loadTabResults(activeTabId);
      return;
    }
    const timer = setTimeout(runSearch, 150);
    return () => clearTimeout(timer);
  }, [runSearch, activeTabId, loadTabResults]);

  // Selecting a tab is mutually exclusive with search/filters — clear those
  // so re-opening a normal view later doesn't inherit stale state.
  function handleTabSelect(id: string | null) {
    setActiveTabId(id);
    if (id) {
      setQuery('');
      setFilters({ sources: new Set(), category: null });
    }
  }

  function handleQueryChange(q: string) {
    if (activeTabId) setActiveTabId(null);
    setQuery(q);
  }

  function handleFiltersChange(f: Filters) {
    if (activeTabId) setActiveTabId(null);
    setFilters(f);
  }

  // ⌘K + [
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (
        e.key === '[' &&
        document.activeElement?.tagName !== 'INPUT' &&
        document.activeElement?.tagName !== 'TEXTAREA'
      ) {
        setBrowseOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Theme sync
  useEffect(() => {
    const html = document.documentElement;
    const isDark =
      theme === 'dark' ||
      (theme === 'system' &&
        matchMedia('(prefers-color-scheme: dark)').matches);
    html.classList.toggle('dark', isDark);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {}
  }, [theme]);

  // Persist filters for this browser so they survive a remount (e.g.
  // navigating to a document and back), same reasoning as theme above.
  // access_level is deliberately excluded: it's the one filter that can
  // silently zero out every result (e.g. "Áskrift"/paid, of which there are
  // currently no published docs) — surviving across sessions, that's a trap
  // that makes search look completely broken with no visible cause. Source
  // and category are safe to persist; a stale choice there still narrows
  // sensibly rather than hiding everything.
  useEffect(() => {
    try {
      localStorage.setItem(
        FILTERS_KEY,
        JSON.stringify({
          sources: Array.from(filters.sources),
          category: filters.category,
        }),
      );
    } catch {}
  }, [filters]);

  async function handleThemeToggle() {
    // Bug: this used to branch on the literal string theme === 'dark',
    // ignoring that theme can be 'system' while VISUALLY resolving to dark
    // (matching the OS preference — the default for anyone who's never
    // manually toggled, including via the DB profile's default 'system'
    // value). For those users the first click set theme from 'system' to
    // the explicit string 'dark' — which is the SAME rendered appearance,
    // so nothing visibly changed — and only the second click (now genuinely
    // 'dark' -> 'light') produced a visible flip. Deriving "is it currently
    // dark" the same way the theme-sync effect does (below) and flipping
    // THAT means a single click always changes what's rendered, regardless
    // of whether the prior state was 'system', 'light', or 'dark'.
    const isDarkNow =
      theme === 'dark' ||
      (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    const next: 'light' | 'dark' = isDarkNow ? 'light' : 'dark';
    setTheme(next);
    // Best-effort sync to the profile row too, so the choice follows the
    // user across devices/browsers, not just this one via localStorage.
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) await supabase.from('profiles').update({ theme: next }).eq('id', user.id);
    } catch {}
  }

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
  }

  const activeFilterCount =
    filters.sources.size + (filters.category ? 1 : 0) + (activeTabId ? 1 : 0);

  const syncLabel = useMemo(
    () => relativeSync(lang, lastSync),
    [lang, lastSync],
  );

  // "Did you mean" — only worth computing once results have actually loaded
  // for this query and are scant enough that a typo is a plausible cause;
  // suggestCorrection itself also returns null when nothing changed (query
  // words are already in the vocabulary, or no close-enough match exists).
  const suggestion = useMemo(() => {
    if (!ready || !query.trim() || results.length > FEW_RESULTS_THRESHOLD) return null;
    return suggestCorrection(query, vocabulary);
  }, [ready, query, results.length, vocabulary]);

  return (
    <div className="min-h-screen bg-paper-bg dark:bg-ink-bg text-paper-text dark:text-ink-text">
      {/* Header */}
      <header className="h-12 px-4 flex items-center gap-2 border-b border-paper-border dark:border-ink-border">
        {/* Browse chip — leads the header so its state (open + count) is glanceable */}
        <button
          onClick={() => setBrowseOpen((v) => !v)}
          className={`h-7 pl-2 pr-2.5 rounded-md text-xs flex items-center gap-1.5 border transition ${
            browseOpen
              ? 'border-brick-500/40 bg-brick-50 dark:bg-brick-900/25 text-brick-700 dark:text-brick-200'
              : 'border-paper-border dark:border-ink-border text-paper-soft dark:text-ink-soft hover:border-brick-500/40 hover:text-brick-700 dark:hover:text-brick-200'
          }`}
          title={`${t(lang, 'browse')}   [`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <line x1="9" y1="3" x2="9" y2="21"/>
          </svg>
          <span>{t(lang, 'browse')}</span>
          {activeFilterCount > 0 && (
            <span className="ml-0.5 text-[10px] font-semibold text-brick-500 dark:text-brick-300 tabular-nums">
              {activeFilterCount}
            </span>
          )}
        </button>

        {/* Product mark */}
        <div className="h-7 pl-1.5 pr-2.5 rounded-md text-xs flex items-center gap-1.5 border border-paper-border dark:border-ink-border">
          <div className="w-4 h-4 rounded-[3px] bg-brick-500 flex items-center justify-center">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7l9-4 9 4v10l-9 4-9-4V7z" />
              <path d="M3 7l9 4 9-4M12 11v10" />
            </svg>
          </div>
          <span className="font-medium tracking-tight">RB-BOX</span>
        </div>

        <div className="flex-1" />

        {/* Right side — trust cues live before controls, quiet by design */}
        <div className="hidden sm:flex items-center gap-2 text-[11.5px] text-paper-faint dark:text-ink-faint">
          {ready && (
            <>
              <span className="tabular-nums">
                {totalDocs} {t(lang, 'manuals')}
              </span>
              {syncLabel && (
                <>
                  <span className="w-1 h-1 rounded-full bg-paper-faint/60 dark:bg-ink-faint/60" />
                  <span>{syncLabel}</span>
                </>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 pl-3 ml-1 border-l border-paper-border dark:border-ink-border">
          <button
            onClick={() => setLang(lang === 'is' ? 'en' : 'is')}
            className="text-[11px] text-paper-soft dark:text-ink-soft hover:text-brick-500 font-medium tracking-wider px-1 py-2 -my-1"
          >
            {lang.toUpperCase()}
          </button>
          <button
            onClick={handleThemeToggle}
            className="text-paper-soft dark:text-ink-soft hover:text-brick-500 p-2 -m-1"
            title={t(lang, 'theme')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {theme === 'dark' ? (
                <>
                  <circle cx="12" cy="12" r="4"/>
                  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
                </>
              ) : (
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
              )}
            </svg>
          </button>
          {profile?.role === 'admin' && (
            // Was a plain <a> — every click did a full hard page reload
            // (re-downloading and re-parsing the whole JS bundle) instead of
            // a fast client-side transition. This is the "settings gear
            // feels slow" complaint: <Link> gives it normal SPA navigation
            // + automatic prefetching, same as every other in-app nav.
            <Link
              href="/admin"
              className="text-paper-soft dark:text-ink-soft hover:text-brick-500 p-2 -m-1"
              title={t(lang, 'adminPanel')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </Link>
          )}
          <button
            onClick={signOut}
            className="ml-0.5 p-1.5 -m-1.5 hover:opacity-80 transition"
            title={t(lang, 'signOut')}
          >
            <span className="w-6 h-6 rounded-full bg-brick-50 dark:bg-brick-900/40 text-brick-700 dark:text-brick-300 flex items-center justify-center text-[10px] font-semibold">
              {(profile?.username?.[0] ?? '·').toUpperCase()}
            </span>
          </button>
        </div>
      </header>

      {/* Body — browse panel + main column both live inside a padded canvas so
          the browse card floats rather than sticking to the edge. */}
      <div className="px-4 sm:px-6 pt-4 sm:pt-6 pb-16 sm:pb-6 flex flex-col sm:flex-row gap-4 sm:gap-6 items-stretch sm:items-start">
        {browseOpen && (
          <BrowsePanel
            lang={lang}
            sources={sources}
            sourceCounts={sourceCounts}
            categories={categories}
            tabs={tabs}
            activeTabId={activeTabId}
            onTabSelect={handleTabSelect}
            filters={filters}
            onChange={handleFiltersChange}
            onClose={() => setBrowseOpen(false)}
          />
        )}

        <main className="flex-1 flex justify-center">
          <div className="w-full max-w-[720px] lg:w-[80%] lg:max-w-[80%]">
            <Spotlight
              lang={lang}
              inputRef={searchRef}
              query={query}
              onQueryChange={handleQueryChange}
              results={results}
              sources={sources}
              categories={categories}
              activeCategory={filters.category}
              hasActiveFilters={activeFilterCount > 0}
              onClearFilters={() => {
                setFilters({ sources: new Set(), category: null });
                setActiveTabId(null);
              }}
              suggestion={suggestion}
              onSuggestionClick={setQuery}
              ready={ready}
              onOpen={(id) => router.push(`/document/${id}`)}
              onPreview={setPreviewDoc}
            />
          </div>
        </main>
      </div>

      {previewDoc && (
        <PdfPreviewModal doc={previewDoc} lang={lang} onClose={() => setPreviewDoc(null)} />
      )}
    </div>
  );
}
