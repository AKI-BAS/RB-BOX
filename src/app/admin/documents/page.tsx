'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { PdfPreviewModal } from '@/components/PdfPreviewModal';
import type { Category, Document, Json, Source } from '@/types/database';

type StatusFilter = 'all' | Document['status'];

const STATUS_LABEL: Record<Document['status'], string> = {
  draft: 'Drög',
  pending_review: 'Í bið',
  published: 'Útgefið',
  archived: 'Geymt',
};

const STATUS_BADGE: Record<Document['status'], string> = {
  draft: 'bg-paper-muted dark:bg-ink-muted text-paper-soft dark:text-ink-soft',
  pending_review: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  published: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  archived: 'bg-paper-muted dark:bg-ink-muted text-paper-faint dark:text-ink-faint',
};

// How many recently-created docs to load — good enough for an admin review
// queue without building full pagination. Raise if the backlog outgrows this.
const LOAD_LIMIT = 500;

function docTags(doc: Document): string[] {
  const meta = doc.metadata as { scraper?: { tags?: unknown } } | null;
  const tags = meta?.scraper?.tags;
  return Array.isArray(tags) ? (tags as string[]) : [];
}

/** Merge an admin_override lock into a doc's existing metadata, preserving
 * the scraper provenance block — a re-scrape of the same doc respects this
 * flag instead of recomputing status/categories out from under the admin. */
function withAdminOverride(doc: Document): Json {
  const meta = (doc.metadata as Record<string, Json> | null) ?? {};
  return {
    ...meta,
    admin_override: { locked: true, at: new Date().toISOString() },
  } as Json;
}

export default function AdminDocumentsPage() {
  const [docs, setDocs] = useState<Document[]>([]);
  const [sources, setSources] = useState<Record<string, Source>>({});
  const [categories, setCategories] = useState<Category[]>([]);
  const [docCategories, setDocCategories] = useState<Record<string, string[]>>({}); // document_id -> category_id[]
  const [loading, setLoading] = useState(true);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [onlyUnsorted, setOnlyUnsorted] = useState(false);

  const [assignFor, setAssignFor] = useState<string | null>(null);
  const [assignSelection, setAssignSelection] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkWorking, setBulkWorking] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [previewDoc, setPreviewDoc] = useState<Document | null>(null);

  async function load() {
    setLoading(true);
    const supabase = createClient();
    const [{ data: docsData }, { data: sourcesData }, { data: catsData }] = await Promise.all([
      supabase.from('documents').select('*').order('created_at', { ascending: false }).limit(LOAD_LIMIT),
      supabase.from('sources').select('*'),
      supabase.from('categories').select('*').order('sort_order'),
    ]);

    if (docsData) setDocs(docsData);
    if (sourcesData) setSources(Object.fromEntries(sourcesData.map((s) => [s.id, s])));
    if (catsData) setCategories(catsData);

    if (docsData && docsData.length > 0) {
      const { data: linksData } = await supabase
        .from('document_categories')
        .select('document_id, category_id')
        .in('document_id', docsData.map((d) => d.id));
      const map: Record<string, string[]> = {};
      for (const link of linksData || []) {
        (map[link.document_id] ??= []).push(link.category_id);
      }
      setDocCategories(map);
    } else {
      setDocCategories({});
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const catById = useMemo(() => Object.fromEntries(categories.map((c) => [c.id, c])), [categories]);

  const filtered = useMemo(() => {
    return docs.filter((d) => {
      if (statusFilter !== 'all' && d.status !== statusFilter) return false;
      const catCount = (docCategories[d.id] ?? []).length;
      if (onlyUnsorted && catCount > 0) return false;
      return true;
    });
  }, [docs, statusFilter, onlyUnsorted, docCategories]);

  const unsortedCount = useMemo(
    () => docs.filter((d) => (docCategories[d.id] ?? []).length === 0).length,
    [docs, docCategories],
  );

  const categorizedButHiddenIds = useMemo(
    () => docs.filter((d) => d.status !== 'published' && (docCategories[d.id] ?? []).length > 0).map((d) => d.id),
    [docs, docCategories],
  );

  function openAssign(doc: Document) {
    setAssignFor(doc.id);
    setAssignSelection(docCategories[doc.id] ?? []);
  }

  async function saveAssign(docId: string) {
    if (assignSelection.length === 0) return;
    setSaving(true);
    const supabase = createClient();
    try {
      const doc = docs.find((d) => d.id === docId);
      await supabase.from('document_categories').delete().eq('document_id', docId);
      await supabase.from('document_categories').insert(
        assignSelection.map((category_id, i) => ({ document_id: docId, category_id, is_primary: i === 0 })),
      );
      // Manual categorization is an explicit review decision — publish it,
      // and lock the override so a future re-scrape doesn't recompute status
      // or silently overwrite the categories just chosen here.
      await supabase.from('documents').update({
        status: 'published',
        metadata: doc ? withAdminOverride(doc) : { admin_override: { locked: true, at: new Date().toISOString() } },
      }).eq('id', docId);
      setFlash({ kind: 'ok', text: 'Flokkun vistuð og skjal birt.' });
      setAssignFor(null);
      load();
    } catch (err) {
      setFlash({ kind: 'err', text: err instanceof Error ? err.message : 'Villa við að vista' });
    } finally {
      setSaving(false);
    }
  }

  async function togglePublish(doc: Document) {
    const newStatus: 'published' | 'pending_review' = doc.status === 'published' ? 'pending_review' : 'published';
    // Unpublishing is always allowed; publishing requires at least one
    // category — an uncategorized doc can't be found by subject in the main
    // library, so it shouldn't be publicly visible (see runner.ts's
    // isUncategorized gate, which enforces the same rule on scraper writes).
    if (newStatus === 'published' && (docCategories[doc.id] ?? []).length === 0) {
      setFlash({ kind: 'err', text: 'Ekki hægt að birta óflokkað skjal — flokkaðu það fyrst (Flokka).' });
      return;
    }
    setBusyId(doc.id);
    const supabase = createClient();
    const { error } = await supabase
      .from('documents')
      .update({ status: newStatus, metadata: withAdminOverride(doc) })
      .eq('id', doc.id);
    if (error) {
      setFlash({ kind: 'err', text: error.message });
    } else {
      setFlash({ kind: 'ok', text: newStatus === 'published' ? 'Skjal birt.' : 'Skjal falið.' });
      await load();
    }
    setBusyId(null);
  }

  async function bulkPublish(ids: string[]) {
    if (ids.length === 0) return;
    // Same rule as togglePublish: never publish an uncategorized doc. Docs
    // that are already published are left alone either way (re-affirming
    // them is harmless, and this keeps a stray already-public doc from
    // silently blocking the rest of a bulk selection).
    const eligibleIds = ids.filter((id) => {
      const doc = docs.find((d) => d.id === id);
      return doc && (doc.status === 'published' || (docCategories[id] ?? []).length > 0);
    });
    const blockedCount = ids.length - eligibleIds.length;
    if (eligibleIds.length === 0) {
      setFlash({ kind: 'err', text: 'Öll valin skjöl eru óflokkuð — ekki hægt að birta. Flokkaðu þau fyrst.' });
      return;
    }

    setBulkWorking(true);
    setBulkProgress({ done: 0, total: eligibleIds.length });
    const supabase = createClient();
    const CONCURRENCY = 8;
    let idx = 0;
    let okCount = 0;
    let errCount = 0;

    async function worker() {
      while (idx < eligibleIds.length) {
        const i = idx++;
        const doc = docs.find((d) => d.id === eligibleIds[i]);
        if (!doc) continue;
        const { error } = await supabase
          .from('documents')
          .update({ status: 'published', metadata: withAdminOverride(doc) })
          .eq('id', doc.id);
        if (error) errCount++; else okCount++;
        setBulkProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, eligibleIds.length) }, worker));

    setFlash({
      kind: errCount > 0 ? 'err' : blockedCount > 0 ? 'err' : 'ok',
      text: `Birti ${okCount} skjöl${errCount > 0 ? `, ${errCount} mistókust` : ''}${blockedCount > 0 ? `, ${blockedCount} óflokkuð sleppt` : ''}.`,
    });
    setBulkWorking(false);
    setBulkProgress(null);
    setSelectedIds(new Set());
    await load();
  }

  function toggleSelected(id: string) {
    setSelectedIds((sel) => {
      const next = new Set(sel);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const allFilteredSelected = filtered.length > 0 && filtered.every((d) => selectedIds.has(d.id));

  function toggleSelectAllFiltered() {
    setSelectedIds((sel) => {
      if (allFilteredSelected) {
        const next = new Set(sel);
        for (const d of filtered) next.delete(d.id);
        return next;
      }
      const next = new Set(sel);
      for (const d of filtered) next.add(d.id);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[22px] font-semibold tracking-tight">Skjöl</h2>
          <p className="text-[13px] text-paper-soft dark:text-ink-soft mt-1">
            Öll skjöl, þ.m.t. óflokkuð og falin sem eru falin úr aðalsafni þar til þau eru flokkuð eða birt
          </p>
        </div>
        {unsortedCount > 0 && (
          <button
            onClick={() => { setStatusFilter('all'); setOnlyUnsorted(true); }}
            className="h-9 px-3 rounded-md text-[12px] font-medium flex items-center gap-1.5 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 transition"
          >
            {unsortedCount} óflokkuð
          </button>
        )}
      </div>

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

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-[13px]"
        >
          <option value="all">Allar stöður</option>
          <option value="published">Útgefið</option>
          <option value="pending_review">Í bið</option>
          <option value="draft">Drög</option>
          <option value="archived">Geymt</option>
        </select>
        <label className="text-[12px] flex items-center gap-2 cursor-pointer select-none">
          <input type="checkbox" checked={onlyUnsorted} onChange={(e) => setOnlyUnsorted(e.target.checked)} />
          <span>Aðeins óflokkað (Unsorted / hidden)</span>
        </label>
        <div className="flex-1" />
        <span className="text-[12px] text-paper-faint dark:text-ink-faint">
          {loading ? 'Sæki…' : `${filtered.length} af ${docs.length}`}
        </span>
      </div>

      {/* Bulk actions */}
      <div className="flex items-center gap-2 flex-wrap rounded-lg border border-paper-border dark:border-ink-border bg-paper-muted/40 dark:bg-ink-muted/40 px-3 py-2">
        <span className="text-[12px] text-paper-soft dark:text-ink-soft">
          {selectedIds.size > 0 ? `${selectedIds.size} valin` : 'Fjöldaaðgerðir:'}
        </span>
        <button
          disabled={selectedIds.size === 0 || bulkWorking}
          onClick={() => bulkPublish(Array.from(selectedIds))}
          className="h-7 px-2.5 rounded-md text-[11px] font-medium bg-brick-500 text-white hover:bg-brick-600 disabled:opacity-40 transition"
        >
          Birta valin
        </button>
        <button
          disabled={categorizedButHiddenIds.length === 0 || bulkWorking}
          onClick={() => bulkPublish(categorizedButHiddenIds)}
          className="h-7 px-2.5 rounded-md text-[11px] font-medium border border-paper-border dark:border-ink-border text-paper-soft dark:text-ink-soft hover:text-brick-500 hover:border-brick-500/40 disabled:opacity-40 transition"
          title="Birtir öll skjöl sem eiga a.m.k. einn flokk en eru ekki útgefin (t.d. föst vegna needs_review)"
        >
          Birta öll flokkuð sem eru falin ({categorizedButHiddenIds.length})
        </button>
        {bulkWorking && bulkProgress && (
          <span className="text-[11px] text-paper-faint dark:text-ink-faint">
            Birti {bulkProgress.done}/{bulkProgress.total}…
          </span>
        )}
      </div>

      {/* Table */}
      <div className="rounded-xl border border-paper-border dark:border-ink-border bg-paper-surface dark:bg-ink-surface overflow-hidden overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-paper-border dark:border-ink-border text-left text-[11px] uppercase tracking-wide text-paper-faint dark:text-ink-faint">
              <th className="px-3 py-2.5 font-medium">
                <input type="checkbox" checked={allFilteredSelected} onChange={toggleSelectAllFiltered} />
              </th>
              <th className="px-4 py-2.5 font-medium">Titill</th>
              <th className="px-4 py-2.5 font-medium">Heimild</th>
              <th className="px-4 py-2.5 font-medium">Staða</th>
              <th className="px-4 py-2.5 font-medium">Flokkar</th>
              <th className="px-4 py-2.5 font-medium">Merki</th>
              <th className="px-4 py-2.5 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((d) => {
              const catIds = docCategories[d.id] ?? [];
              const isUnsorted = catIds.length === 0;
              const tags = docTags(d);
              const rowBusy = busyId === d.id;
              return (
                <tr key={d.id} className="border-b border-paper-border dark:border-ink-border last:border-0 hover:bg-paper-muted/40 dark:hover:bg-ink-muted/40">
                  <td className="px-3 py-2.5 align-top">
                    <input type="checkbox" checked={selectedIds.has(d.id)} onChange={() => toggleSelected(d.id)} />
                  </td>
                  <td className="px-4 py-2.5 max-w-[280px] align-top">
                    {d.external_url ? (
                      <a href={d.external_url} target="_blank" rel="noreferrer" className="truncate block hover:text-brick-500 transition" title={d.title}>
                        {d.title}
                      </a>
                    ) : (
                      <span className="truncate block" title={d.title}>{d.title}</span>
                    )}
                    {d.source_ref && (
                      <span className="block text-[10px] font-mono text-paper-faint dark:text-ink-faint mt-0.5 truncate" title={d.source_ref}>
                        {d.source_ref}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-paper-soft dark:text-ink-soft whitespace-nowrap align-top">
                    {sources[d.source_id ?? '']?.name ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 align-top">
                    <span className={`h-6 px-2 rounded text-[10px] font-medium tracking-wide inline-flex items-center ${STATUS_BADGE[d.status]}`}>
                      {STATUS_LABEL[d.status]}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 align-top">
                    {isUnsorted ? (
                      <span className="h-6 px-2 rounded text-[10px] font-medium tracking-wide inline-flex items-center bg-amber-500/10 text-amber-700 dark:text-amber-300">
                        Óflokkað
                      </span>
                    ) : (
                      <div className="flex flex-wrap gap-1 max-w-[220px]">
                        {catIds.map((id) => (
                          <span key={id} className="h-5 px-1.5 rounded text-[10px] bg-paper-muted dark:bg-ink-muted text-paper-soft dark:text-ink-soft">
                            {catById[id]?.name ?? id.slice(0, 8)}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 align-top">
                    <div className="flex flex-wrap gap-1 max-w-[200px]">
                      {tags.length > 0
                        ? tags.map((tag) => (
                            <span key={tag} className="h-5 px-1.5 rounded text-[10px] bg-paper-muted/70 dark:bg-ink-muted/70 text-paper-faint dark:text-ink-faint">
                              {tag}
                            </span>
                          ))
                        : <span className="text-paper-faint dark:text-ink-faint">—</span>}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right align-top whitespace-nowrap">
                    <button
                      onClick={() => setPreviewDoc(d)}
                      title="Forskoða"
                      className="h-7 px-2.5 rounded-md text-[11px] font-medium border border-paper-border dark:border-ink-border text-paper-soft dark:text-ink-soft hover:text-brick-500 hover:border-brick-500/40 transition mr-1.5"
                    >
                      Forskoða
                    </button>
                    <button
                      onClick={() => openAssign(d)}
                      className="h-7 px-2.5 rounded-md text-[11px] font-medium border border-paper-border dark:border-ink-border text-paper-soft dark:text-ink-soft hover:text-brick-500 hover:border-brick-500/40 transition mr-1.5"
                    >
                      Flokka
                    </button>
                    <button
                      disabled={rowBusy}
                      onClick={() => togglePublish(d)}
                      className={`h-7 px-2.5 rounded-md text-[11px] font-medium transition disabled:opacity-50 ${
                        d.status === 'published'
                          ? 'border border-paper-border dark:border-ink-border text-paper-soft dark:text-ink-soft hover:text-brick-500 hover:border-brick-500/40'
                          : 'bg-brick-500 text-white hover:bg-brick-600'
                      }`}
                    >
                      {rowBusy ? '…' : d.status === 'published' ? 'Fela' : 'Birta'}
                    </button>
                  </td>
                </tr>
              );
            })}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-paper-faint dark:text-ink-faint">
                  Engin skjöl fundust með þessum síum.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Assign-categories modal */}
      {assignFor && (
        <div
          className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => !saving && setAssignFor(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-xl border border-paper-border dark:border-ink-border bg-paper-surface dark:bg-ink-surface p-5 shadow-xl"
          >
            <h3 className="text-[15px] font-semibold mb-1">Velja flokka</h3>
            <p className="text-[12px] text-paper-soft dark:text-ink-soft mb-4">
              {docs.find((d) => d.id === assignFor)?.title} — vistun birtir skjalið sjálfkrafa.
            </p>
            <div className="max-h-64 overflow-y-auto space-y-1 mb-4 border border-paper-border dark:border-ink-border rounded-md p-2">
              {categories.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-[13px] px-2 py-1 rounded hover:bg-paper-muted dark:hover:bg-ink-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={assignSelection.includes(c.id)}
                    onChange={(e) => {
                      setAssignSelection((sel) =>
                        e.target.checked ? [...sel, c.id] : sel.filter((id) => id !== c.id),
                      );
                    }}
                  />
                  <span>{c.name}</span>
                  <span className="text-[10px] font-mono text-paper-faint dark:text-ink-faint ml-auto">{c.slug}</span>
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setAssignFor(null)} disabled={saving}
                      className="h-8 px-3 rounded-md text-xs border border-paper-border dark:border-ink-border hover:border-brick-500/40 transition">
                Hætta við
              </button>
              <button
                type="button"
                disabled={saving || assignSelection.length === 0}
                onClick={() => assignFor && saveAssign(assignFor)}
                className="h-8 px-3 rounded-md bg-brick-500 text-white text-xs font-medium hover:bg-brick-600 disabled:opacity-50 transition"
              >
                {saving ? 'Vista…' : 'Vista og birta'}
              </button>
            </div>
          </div>
        </div>
      )}

      {previewDoc && (
        <PdfPreviewModal doc={previewDoc} lang="is" onClose={() => setPreviewDoc(null)} />
      )}
    </div>
  );
}
