'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { t, type Lang } from '@/lib/i18n';
import { BrowsePanel, type Filters } from '@/components/BrowsePanel';
import { Spotlight } from '@/components/Spotlight';
import { deriveSearchTerms } from '@/lib/search/highlight';
import type { Document, Source, Category } from '@/types/database';

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
    access: new Set(),
    sources: new Set<string>(),
    category: null,
  });
  const [profile, setProfile] = useState<{
    username: string;
    full_name: string | null;
    role: string;
  } | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);

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
          setTheme((prof.theme as 'light' | 'dark' | 'system') || 'system');
        }
      }

      const [
        { data: srcs },
        { data: cats },
        { data: docCounts },
        { data: latest },
      ] = await Promise.all([
        supabase.from('sources').select('*').eq('is_active', true).order('name'),
        supabase.from('categories').select('*').order('sort_order'),
        supabase
          .from('documents')
          .select('source_id, updated_at')
          .eq('status', 'published'),
        supabase
          .from('documents')
          .select('updated_at')
          .eq('status', 'published')
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (srcs) setSources(srcs);
      if (cats) setCategories(cats);
      if (docCounts) {
        const counts: Record<string, number> = {};
        docCounts.forEach((d: any) => {
          if (d.source_id) counts[d.source_id] = (counts[d.source_id] || 0) + 1;
        });
        setSourceCounts(counts);
        setTotalDocs(docCounts.length);
      }
      if (latest?.updated_at) setLastSync(latest.updated_at);
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
      .limit(50);

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
      const tagDocIdsByTerm = await Promise.all(
        terms.map(async (term) => {
          const { data: tagRows } = await supabase
            .from('document_tags')
            .select('document_id, tags!inner(name)')
            .ilike('tags.name', `%${term}%`)
            .limit(500);
          return (tagRows ?? []).map((r: any) => r.document_id as string);
        }),
      );

      terms.forEach((term, i) => {
        const pattern = `%${term}%`;
        const clauses = [
          `title.ilike.${pattern}`,
          `title_en.ilike.${pattern}`,
          `description.ilike.${pattern}`,
          `description_en.ilike.${pattern}`,
          `reference_code.ilike.${pattern}`,
          `source_ref.ilike.${pattern}`,
        ];
        const tagDocIds = tagDocIdsByTerm[i];
        if (tagDocIds.length > 0) {
          clauses.push(`id.in.(${tagDocIds.join(',')})`);
        }
        q = q.or(clauses.join(','));
      });
    }
    if (filters.access.size > 0) {
      q = q.in('access_level', Array.from(filters.access));
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

  useEffect(() => {
    const timer = setTimeout(runSearch, 150);
    return () => clearTimeout(timer);
  }, [runSearch]);

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
      localStorage.setItem('rb-theme', theme);
    } catch {}
  }, [theme]);

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
  }

  const activeFilterCount =
    filters.access.size + filters.sources.size + (filters.category ? 1 : 0);

  const syncLabel = useMemo(
    () => relativeSync(lang, lastSync),
    [lang, lastSync],
  );

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
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
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
            <a
              href="/admin"
              className="text-paper-soft dark:text-ink-soft hover:text-brick-500 p-2 -m-1"
              title={t(lang, 'adminPanel')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </a>
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
      <div className="px-4 sm:px-6 pt-4 sm:pt-6 pb-16 flex flex-col sm:flex-row gap-4 sm:gap-6 items-stretch sm:items-start">
        {browseOpen && (
          <BrowsePanel
            lang={lang}
            sources={sources}
            sourceCounts={sourceCounts}
            categories={categories}
            filters={filters}
            onChange={setFilters}
            onClose={() => setBrowseOpen(false)}
          />
        )}

        <main className="flex-1 flex justify-center">
          <div className="w-full max-w-[720px] lg:w-[80%] lg:max-w-[80%]">
            <Spotlight
              lang={lang}
              inputRef={searchRef}
              query={query}
              onQueryChange={setQuery}
              results={results}
              sources={sources}
              categories={categories}
              activeCategory={filters.category}
              ready={ready}
              onOpen={(id) => router.push(`/document/${id}`)}
            />
          </div>
        </main>
      </div>
    </div>
  );
}
