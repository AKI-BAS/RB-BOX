'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import type { Source } from '@/types/database';

// Small palette used to give each source a distinctive icon color when no
// logo is set. Hashed from the slug so it stays stable across renders.
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
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0];
  }
}

// A source's "kind" — used both to pick the card icon and the type badge.
// Scraper: fetched from an external URL periodically.
// Direct:  uploaded straight into RB-BOX (contributor or admin).
type Kind = 'scraper-book' | 'scraper-doc' | 'contributor' | 'internal';
function classify(s: Source): Kind {
  if (s.base_url) {
    // Very rough: guess book-ish vs sheet-ish from the slug
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
        return (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
          </svg>
        );
      case 'scraper-doc':
        return (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 3v4a1 1 0 0 0 1 1h4" />
            <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
            <path d="M9 13h6M9 17h4" />
          </svg>
        );
      case 'contributor':
        return (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        );
      case 'internal':
        return (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        );
    }
  })();

  return (
    <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${pal.bg} ${pal.fg}`}>
      {svg}
    </div>
  );
}

function typeBadge(source: Source): 'Scraper' | 'Direct' {
  const kind = classify(source);
  if (kind === 'scraper-book' || kind === 'scraper-doc') return 'Scraper';
  return 'Direct';
}

export default function AdminSourcesPage() {
  const [sources, setSources] = useState<Source[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    slug: '',
    name: '',
    name_en: '',
    description: '',
    base_url: '',
    trust_level: 3,
  });

  async function load() {
    const supabase = createClient();
    const [{ data: srcs }, { data: docs }] = await Promise.all([
      supabase.from('sources').select('*').order('name'),
      supabase.from('documents').select('source_id').eq('status', 'published'),
    ]);
    if (srcs) setSources(srcs);
    if (docs) {
      const c: Record<string, number> = {};
      docs.forEach((d: any) => {
        if (d.source_id) c[d.source_id] = (c[d.source_id] || 0) + 1;
      });
      setCounts(c);
    }
  }
  useEffect(() => { load(); }, []);

  async function addSource(e: React.FormEvent) {
    e.preventDefault();
    const supabase = createClient();
    await supabase.from('sources').insert(form);
    setForm({ slug: '', name: '', name_en: '', description: '', base_url: '', trust_level: 3 });
    setShowForm(false);
    load();
  }

  async function toggleActive(id: string, is_active: boolean) {
    const supabase = createClient();
    await supabase.from('sources').update({ is_active: !is_active }).eq('id', id);
    load();
  }

  return (
    <div className="space-y-6">
      {/* Section heading + subtitle + primary CTA */}
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
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            <span>Ný heimild</span>
          </button>
        </div>
      </div>

      {/* Inline "new source" form (collapsed by default) */}
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
          <input placeholder="Lýsing (t.d. „Húsnæðis- og mannvirkjastofnun · Vikuleg samstilling“)" value={form.description}
                 onChange={(e) => setForm({ ...form, description: e.target.value })}
                 className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm" />
          <input placeholder="base_url (skildu eftir tómt fyrir bein upphlöðun)" value={form.base_url}
                 onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                 className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm col-span-2" />
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
                  <div className="text-[14px] font-medium leading-tight">{s.name}</div>
                  <div className="text-[12px] text-paper-soft dark:text-ink-soft mt-0.5 truncate">
                    {s.description ?? (s.base_url ? safeHost(s.base_url) : 'Innihald frá notendum')}
                  </div>
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

                <button
                  onClick={() => toggleActive(s.id, s.is_active)}
                  title={s.is_active ? 'Gera óvirkt' : 'Gera virkt'}
                  className="w-7 h-7 rounded-md text-paper-faint dark:text-ink-faint hover:bg-paper-muted dark:hover:bg-ink-muted hover:text-brick-500 flex items-center justify-center transition"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="5" r="1.6" />
                    <circle cx="12" cy="12" r="1.6" />
                    <circle cx="12" cy="19" r="1.6" />
                  </svg>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
