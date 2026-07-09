'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import type { Source, ScrapeRun } from '@/types/database';

// ── palette + helpers (unchanged from prior version) ─────────────────────
const PALETTE: Array<{ bg: string; fg: string }> = [
  { bg: 'bg-brick-500/15 dark:bg-brick-500/25',      fg: 'text-brick-700 dark:text-brick-300' },
  { bg: 'bg-emerald-500/15 dark:bg-emerald-500/25',  fg: 'text-emerald-700 dark:text-emerald-300' },
  { bg: 'bg-sky-500/15 dark:bg-sky-500/25',          fg: 'text-sky-700 dark:text-sky-300' },
  { bg: 'bg-amber-500/15 dark:bg-amber-500/25',      fg: 'text-amber-700 dark:text-amber-300' },
  { bg: 'bg-violet-500/15 dark:bg-violet-500/25',    fg: 'text-violet-700 dark:text-violet-300' },
  { bg: 'bg-slate-500/15 dark:bg-slate-500/30',      fg: 'text-slate-700 dark:text-slate-300' },
];

function hashSlug(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function safeHost(url: string): string {
  try { return new URL(url).host; }
  catch { return url.replace(/^https?:\/\//, '').split('/')[0]; }
}

function relTime(iso: string | null): string {
  if (!iso) return 'Aldrei';
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return 'rétt í þessu';
  if (mins < 60) return `${mins} mín`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} klst.`;
  const days = Math.round(hours / 24);
  return `${days} d.`;
}

type Kind = 'scraper-book' | 'scraper-doc' | 'contributor' | 'internal';
function classify(s: Source): Kind {
  if (s.scrape_mode !== 'none') {
    if (/rb|blad|sheet/i.test(s.slug)) return 'scraper-doc';
    return 'scraper-book';
  }
  if (/intern|priv|closed|verkfer/i.test(s.slug)) return 'internal';
  return 'contributor';
}

function SourceIcon({ source }: { source: Source }) {
  const kind = classify(source);
  const pal = PALETTE[hashSlug(source.slug) % PALETTE.length];
  const svg = (() => {
    switch (kind) {
      case 'scraper-book':
        return (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" /></svg>);
      case 'scraper-doc':
        return (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" /><path d="M9 13h6M9 17h4" /></svg>);
      case 'contributor':
        return (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>);
      case 'internal':
        return (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>);
    }
  })();
  return (
    <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${pal.bg} ${pal.fg}`}>
      {svg}
    </div>
  );
}

function typeBadge(source: Source): 'Scraper' | 'Direct' {
  return source.scrape_mode !== 'none' ? 'Scraper' : 'Direct';
}

// ── main page ────────────────────────────────────────────────────────────
export default function AdminSourcesPage() {
  const [sources, setSources] = useState<Source[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [lastRuns, setLastRuns] = useState<Record<string, ScrapeRun>>({});
  const [runningFor, setRunningFor] = useState<Set<string>>(new Set());
  const [importFor, setImportFor] = useState<string | null>(null);
  const [importUrl, setImportUrl] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    slug: '', name: '', name_en: '', description: '', base_url: '',
    scrape_mode: 'none' as Source['scrape_mode'],
    auto_publish: false,
  });

  async function load() {
    const supabase = createClient();
    const [{ data: srcs }, { data: docs }, runsRes] = await Promise.all([
      supabase.from('sources').select('*').order('name'),
      supabase.from('documents').select('source_id').eq('status', 'published'),
      fetch('/api/admin/scrape/runs?limit=100').then((r) => r.json()).catch(() => ({ runs: [] })),
    ]);

    if (srcs) setSources(srcs);
    if (docs) {
      const c: Record<string, number> = {};
      docs.forEach((d: any) => { if (d.source_id) c[d.source_id] = (c[d.source_id] || 0) + 1; });
      setCounts(c);
    }
    // Latest run per source (runs come back sorted desc)
    const latest: Record<string, ScrapeRun> = {};
    for (const r of (runsRes.runs || []) as ScrapeRun[]) {
      if (!latest[r.source_id]) latest[r.source_id] = r;
    }
    setLastRuns(latest);
  }

  useEffect(() => { load(); }, []);

  // Auto-refresh while any scrape is running (so tallies update live)
  useEffect(() => {
    if (runningFor.size === 0) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [runningFor]);

  async function addSource(e: React.FormEvent) {
    e.preventDefault();
    const supabase = createClient();
    await supabase.from('sources').insert(form);
    setForm({ slug: '', name: '', name_en: '', description: '', base_url: '', scrape_mode: 'none', auto_publish: false });
    setShowForm(false);
    load();
  }

  async function toggleActive(id: string, is_active: boolean) {
    const supabase = createClient();
    await supabase.from('sources').update({ is_active: !is_active }).eq('id', id);
    load();
  }

  async function toggleAutoPublish(id: string, auto_publish: boolean) {
    const supabase = createClient();
    await supabase.from('sources').update({ auto_publish: !auto_publish }).eq('id', id);
    load();
  }

  async function runNow(source: Source) {
    if (runningFor.has(source.id)) return;
    setRunningFor((s) => new Set(s).add(source.id));
    try {
      const res = await fetch('/api/admin/scrape/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_id: source.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFlash({ kind: 'err', text: `${source.name}: ${data.error || 'villa'}` });
      } else {
        setFlash({
          kind: 'ok',
          text: `${source.name}: +${data.added} ný · ${data.skipped} sleppt · ${data.errors} villur`,
        });
      }
    } catch (err) {
      setFlash({ kind: 'err', text: `${source.name}: ${err instanceof Error ? err.message : 'villa'}` });
    } finally {
      setRunningFor((s) => { const n = new Set(s); n.delete(source.id); return n; });
      load();
    }
  }

  async function submitImportUrl(e: React.FormEvent) {
    e.preventDefault();
    if (!importFor || !importUrl.trim()) return;
    setImportBusy(true);
    try {
      const res = await fetch('/api/admin/scrape/import-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_id: importFor, url: importUrl.trim() }),
      });
      const data = await res.json();
      const src = sources.find((s) => s.id === importFor);
      if (!res.ok) {
        setFlash({ kind: 'err', text: `${src?.name}: ${data.error || 'villa'}` });
      } else if (data.documentId) {
        setFlash({ kind: 'ok', text: `${src?.name}: sótt með góðum árangri` });
        setImportUrl('');
        setImportFor(null);
      } else {
        setFlash({ kind: 'ok', text: `${src?.name}: engin ný skjöl (sleppt eða til)` });
        setImportFor(null);
      }
    } finally {
      setImportBusy(false);
      load();
    }
  }

  return (
    <div className="space-y-6">
      {/* Section heading */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[22px] font-semibold tracking-tight">Heimildir</h2>
          <p className="text-[13px] text-paper-soft dark:text-ink-soft mt-1">
            Stjórna hvaðan handbækur og leiðbeiningar koma
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/upload"
            className="h-9 pl-2.5 pr-3.5 rounded-md text-[13px] font-medium flex items-center gap-1.5 border border-paper-border dark:border-ink-border text-paper-soft dark:text-ink-soft hover:text-brick-500 hover:border-brick-500/40 transition"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span>Nýtt skjal</span>
          </Link>
          <button
            onClick={() => setShowForm((v) => !v)}
            className="h-9 pl-2.5 pr-3.5 rounded-md bg-brick-500 hover:bg-brick-600 text-white text-[13px] font-medium flex items-center gap-1.5 transition shadow-sm shadow-brick-900/20"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>Ný heimild</span>
          </button>
        </div>
      </div>

      {/* Flash */}
      {flash && (
        <div
          className={`rounded-lg px-3 py-2 text-[13px] flex items-center justify-between ${
            flash.kind === 'ok'
              ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
              : 'bg-brick-500/10 text-brick-700 dark:text-brick-300'
          }`}
        >
          <span>{flash.text}</span>
          <button onClick={() => setFlash(null)} className="opacity-60 hover:opacity-100">✕</button>
        </div>
      )}

      {/* New-source form (collapsed by default) */}
      {showForm && (
        <form
          onSubmit={addSource}
          className="rounded-xl border border-paper-border dark:border-ink-border bg-paper-surface dark:bg-ink-surface p-4 grid grid-cols-2 gap-3"
        >
          <input placeholder="slug" required value={form.slug}
                 onChange={(e) => setForm({ ...form, slug: e.target.value })}
                 className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm" />
          <input placeholder="Nafn (IS)" required value={form.name}
                 onChange={(e) => setForm({ ...form, name: e.target.value })}
                 className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm" />
          <input placeholder="Name (EN)" value={form.name_en}
                 onChange={(e) => setForm({ ...form, name_en: e.target.value })}
                 className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm" />
          <input placeholder="Lýsing" value={form.description}
                 onChange={(e) => setForm({ ...form, description: e.target.value })}
                 className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm" />
          <input placeholder="base_url" value={form.base_url}
                 onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                 className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm col-span-2" />
          <div className="col-span-2 flex items-center gap-6 pl-1">
            <label className="text-[12px] flex items-center gap-2">
              <span className="text-paper-soft dark:text-ink-soft">Mode</span>
              <select value={form.scrape_mode}
                      onChange={(e) => setForm({ ...form, scrape_mode: e.target.value as Source['scrape_mode'] })}
                      className="h-8 px-2 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-[12px]">
                <option value="none">none</option>
                <option value="crawler">crawler</option>
                <option value="manual_import">manual_import</option>
                <option value="both">both</option>
              </select>
            </label>
            <label className="text-[12px] flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.auto_publish}
                     onChange={(e) => setForm({ ...form, auto_publish: e.target.checked })} />
              <span>Sjálfvirk birting (traustur)</span>
            </label>
          </div>
          <div className="col-span-2 flex justify-end gap-2">
            <button type="button" onClick={() => setShowForm(false)}
                    className="h-8 px-3 rounded-md text-xs border border-paper-border dark:border-ink-border hover:border-brick-500/40 transition">
              Hætta við
            </button>
            <button type="submit"
                    className="h-8 px-3 rounded-md bg-brick-500 text-white text-xs font-medium hover:bg-brick-600 transition">
              Vista
            </button>
          </div>
        </form>
      )}

      {/* Source cards */}
      <div className="space-y-2">
        {sources.length === 0 && (
          <div className="rounded-xl border border-dashed border-paper-border dark:border-ink-border p-8 text-center text-sm text-paper-faint dark:text-ink-faint">
            Engar heimildir enn. Ýttu á <span className="text-brick-500 font-medium">Ný heimild</span> til að bæta þeirri fyrstu við.
          </div>
        )}

        {sources.map((s) => {
          const badge = typeBadge(s);
          const count = counts[s.id] ?? 0;
          const lastRun = lastRuns[s.id];
          const isScraper = s.scrape_mode === 'crawler' || s.scrape_mode === 'both';
          const canImport = s.scrape_mode === 'manual_import' || s.scrape_mode === 'both';
          const isRunning = runningFor.has(s.id) || lastRun?.status === 'running';

          return (
            <div
              key={s.id}
              className={`group rounded-xl border bg-paper-surface dark:bg-ink-surface transition ${
                s.is_active
                  ? 'border-paper-border dark:border-ink-border hover:border-brick-500/40'
                  : 'border-paper-border dark:border-ink-border opacity-60'
              }`}
            >
              <div className="flex items-center gap-4 px-4 py-3.5">
                <SourceIcon source={s} />

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="text-[14px] font-medium leading-tight truncate">{s.name}</div>
                    {s.auto_publish && (
                      <span
                        className="h-[18px] px-1.5 rounded-sm text-[9px] font-medium tracking-wide bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 flex items-center gap-1"
                        title="Traustur — skjöl birtast sjálfkrafa"
                      >
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                        TRAUST
                      </span>
                    )}
                  </div>
                  <div className="text-[12px] text-paper-soft dark:text-ink-soft mt-0.5 truncate">
                    {s.description ?? (s.base_url ? safeHost(s.base_url) : 'Innihald frá notendum')}
                  </div>
                  {isScraper && (
                    <div className="text-[11px] text-paper-faint dark:text-ink-faint mt-1 flex items-center gap-2">
                      <span>Síðast: {relTime(s.last_scraped_at)}</span>
                      {lastRun && lastRun.status !== 'running' && (
                        <span className={`
                          ${lastRun.status === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : ''}
                          ${lastRun.status === 'partial' ? 'text-amber-600 dark:text-amber-400' : ''}
                          ${lastRun.status === 'error' ? 'text-brick-600 dark:text-brick-400' : ''}
                        `}>
                          · +{lastRun.added} ný · {lastRun.skipped} sleppt · {lastRun.errors} villur
                        </span>
                      )}
                      {isRunning && (
                        <span className="text-brick-500 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-brick-500 animate-pulse" />
                          Í gangi…
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <span
                  className={`h-6 px-2 rounded text-[10px] font-medium tracking-wide flex items-center ${
                    badge === 'Scraper'
                      ? 'bg-paper-muted dark:bg-ink-muted text-paper-soft dark:text-ink-soft'
                      : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  }`}
                >
                  {badge}
                </span>

                <div className="text-right shrink-0 min-w-[54px]">
                  <div className="text-[15px] font-mono tabular-nums leading-none">{count}</div>
                  <div className="text-[10px] uppercase tracking-wider text-paper-faint dark:text-ink-faint mt-1">
                    skjöl
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-1 shrink-0">
                  {isScraper && (
                    <button
                      onClick={() => runNow(s)}
                      disabled={isRunning || !s.is_active}
                      title={s.is_active ? 'Keyra scraper núna' : 'Óvirk heimild'}
                      className="h-8 px-2.5 rounded-md text-[12px] font-medium flex items-center gap-1.5 border border-paper-border dark:border-ink-border text-paper-soft dark:text-ink-soft hover:text-brick-500 hover:border-brick-500/40 disabled:opacity-40 disabled:cursor-not-allowed transition"
                    >
                      {isRunning ? (
                        <>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="animate-spin">
                            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                          </svg>
                          Í gangi
                        </>
                      ) : (
                        <>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                            <polygon points="5,3 19,12 5,21" />
                          </svg>
                          Keyra
                        </>
                      )}
                    </button>
                  )}
                  {canImport && (
                    <button
                      onClick={() => { setImportFor(s.id); setImportUrl(''); }}
                      title="Sækja stakt skjal frá slóð"
                      className="h-8 px-2.5 rounded-md text-[12px] font-medium flex items-center gap-1.5 border border-paper-border dark:border-ink-border text-paper-soft dark:text-ink-soft hover:text-brick-500 hover:border-brick-500/40 transition"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                      </svg>
                      Slóð
                    </button>
                  )}
                  <button
                    onClick={() => toggleAutoPublish(s.id, s.auto_publish)}
                    title={s.auto_publish ? 'Slökkva á sjálfvirkri birtingu' : 'Kveikja á sjálfvirkri birtingu'}
                    className={`h-8 w-8 rounded-md flex items-center justify-center transition border ${
                      s.auto_publish
                        ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/20'
                        : 'text-paper-faint dark:text-ink-faint border-paper-border dark:border-ink-border hover:text-brick-500 hover:border-brick-500/40'
                    }`}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      {s.auto_publish ? (
                        <>
                          <path d="M9 12l2 2 4-4" />
                          <circle cx="12" cy="12" r="10" />
                        </>
                      ) : (
                        <>
                          <circle cx="12" cy="12" r="10" />
                          <path d="M12 8v4M12 16h.01" />
                        </>
                      )}
                    </svg>
                  </button>
                  <button
                    onClick={() => toggleActive(s.id, s.is_active)}
                    title={s.is_active ? 'Gera óvirkt' : 'Gera virkt'}
                    className="w-8 h-8 rounded-md text-paper-faint dark:text-ink-faint hover:bg-paper-muted dark:hover:bg-ink-muted hover:text-brick-500 flex items-center justify-center transition"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="12" cy="5" r="1.6" />
                      <circle cx="12" cy="12" r="1.6" />
                      <circle cx="12" cy="19" r="1.6" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Import URL modal */}
      {importFor && (
        <div
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => !importBusy && setImportFor(null)}
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={submitImportUrl}
            className="w-full max-w-lg rounded-xl border border-paper-border dark:border-ink-border bg-paper-surface dark:bg-ink-surface p-5 shadow-xl"
          >
            <h3 className="text-[15px] font-semibold mb-1">Sækja slóð</h3>
            <p className="text-[12px] text-paper-soft dark:text-ink-soft mb-4">
              {sources.find((s) => s.id === importFor)?.name} · Skjalið verður greint með gervigreind og bætt við.
            </p>
            <input
              autoFocus
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              placeholder="https://…"
              disabled={importBusy}
              className="w-full h-10 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm mb-4"
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setImportFor(null)} disabled={importBusy}
                      className="h-8 px-3 rounded-md text-xs border border-paper-border dark:border-ink-border hover:border-brick-500/40 transition">
                Hætta við
              </button>
              <button type="submit" disabled={importBusy || !importUrl.trim()}
                      className="h-8 px-3 rounded-md bg-brick-500 text-white text-xs font-medium hover:bg-brick-600 disabled:opacity-50 transition">
                {importBusy ? 'Sæki…' : 'Sækja'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
