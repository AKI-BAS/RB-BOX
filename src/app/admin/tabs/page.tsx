'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

// NOTE: run `npm run types:gen` after applying the 20260722000000_tabs.sql
// migration and swap these for the generated Database['public']['Tables']
// types. Defined locally for now so this page compiles before that regen.
type AccessLevel = 'open' | 'internal' | 'restricted' | 'paid';

interface Tab {
  id: string;
  slug: string;
  name: string;
  name_en: string | null;
  description: string | null;
  min_access_level: AccessLevel;
  is_active: boolean;
  sort_order: number;
  created_at: string;
}

interface TabDocument {
  id: string;
  tab_id: string;
  document_id: string;
  sort_order: number;
  documents: { id: string; title: string } | null;
}

interface DocumentOption {
  id: string;
  title: string;
}

const ACCESS_LEVELS: AccessLevel[] = ['open', 'internal', 'restricted', 'paid'];

const emptyForm = {
  slug: '',
  name: '',
  name_en: '',
  description: '',
  min_access_level: 'open' as AccessLevel,
  is_active: true,
  sort_order: 0,
};

export default function AdminTabsPage() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedTabId, setExpandedTabId] = useState<string | null>(null);
  const [tabDocuments, setTabDocuments] = useState<Record<string, TabDocument[]>>({});
  const [docSearch, setDocSearch] = useState('');
  const [docResults, setDocResults] = useState<DocumentOption[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadTabs();
  }, []);

  async function loadTabs() {
    setLoading(true);
    const supabase = createClient();
    const { data, error } = await supabase
      .from('tabs')
      .select('*')
      .order('sort_order');
    if (error) {
      setError(error.message);
    } else {
      setTabs((data as Tab[]) ?? []);
    }
    setLoading(false);
  }

  async function loadTabDocuments(tabId: string) {
    const supabase = createClient();
    const { data, error } = await supabase
      .from('tab_documents')
      .select('id, tab_id, document_id, sort_order, documents(id, title)')
      .eq('tab_id', tabId)
      .order('sort_order');
    if (!error) {
      setTabDocuments((prev) => ({ ...prev, [tabId]: (data as unknown as TabDocument[]) ?? [] }));
    }
  }

  function slugify(text: string) {
    return text
      .toLowerCase()
      .trim()
      .replace(/[þðæö]/g, (c) => ({ þ: 'th', ð: 'd', æ: 'ae', ö: 'o' }[c] ?? c))
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const supabase = createClient();
    const payload = {
      slug: form.slug || slugify(form.name),
      name: form.name,
      name_en: form.name_en || null,
      description: form.description || null,
      min_access_level: form.min_access_level,
      is_active: form.is_active,
      sort_order: form.sort_order,
    };

    const { error } = editingId
      ? await supabase.from('tabs').update(payload).eq('id', editingId)
      : await supabase.from('tabs').insert(payload);

    if (error) {
      setError(error.message);
      return;
    }
    setForm(emptyForm);
    setEditingId(null);
    loadTabs();
  }

  function startEdit(tab: Tab) {
    setEditingId(tab.id);
    setForm({
      slug: tab.slug,
      name: tab.name,
      name_en: tab.name_en ?? '',
      description: tab.description ?? '',
      min_access_level: tab.min_access_level,
      is_active: tab.is_active,
      sort_order: tab.sort_order,
    });
  }

  async function deleteTab(id: string) {
    if (!confirm('Eyða þessum flipa? Þetta fjarlægir líka tengd skjöl úr flipanum.')) return;
    const supabase = createClient();
    const { error } = await supabase.from('tabs').delete().eq('id', id);
    if (error) {
      setError(error.message);
      return;
    }
    loadTabs();
  }

  async function toggleExpand(tabId: string) {
    if (expandedTabId === tabId) {
      setExpandedTabId(null);
      return;
    }
    setExpandedTabId(tabId);
    if (!tabDocuments[tabId]) await loadTabDocuments(tabId);
  }

  async function searchDocuments(q: string) {
    setDocSearch(q);
    if (q.trim().length < 2) {
      setDocResults([]);
      return;
    }
    const supabase = createClient();
    const { data } = await supabase
      .from('documents')
      .select('id, title')
      .ilike('title', `%${q}%`)
      .limit(8);
    setDocResults((data as DocumentOption[]) ?? []);
  }

  async function addDocumentToTab(tabId: string, documentId: string) {
    const supabase = createClient();
    const currentCount = tabDocuments[tabId]?.length ?? 0;
    const { error } = await supabase
      .from('tab_documents')
      .insert({ tab_id: tabId, document_id: documentId, sort_order: currentCount });
    if (error) {
      setError(error.message);
      return;
    }
    setDocSearch('');
    setDocResults([]);
    loadTabDocuments(tabId);
  }

  async function removeDocumentFromTab(tabId: string, tabDocumentId: string) {
    const supabase = createClient();
    const { error } = await supabase.from('tab_documents').delete().eq('id', tabDocumentId);
    if (error) {
      setError(error.message);
      return;
    }
    loadTabDocuments(tabId);
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[22px] font-semibold tracking-tight">Flipar</h2>
        <p className="text-[13px] text-paper-soft dark:text-ink-soft mt-1">
          Sérsniðnir flipar sem birtast neðst á forsíðunni fyrir tiltekna notendahópa
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/30 dark:border-red-800 px-4 py-2 text-[13px] text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Create / edit form */}
      <form
        onSubmit={handleSubmit}
        className="rounded-xl border border-paper-border dark:border-ink-border p-5 space-y-4"
      >
        <h3 className="text-[15px] font-medium">
          {editingId ? 'Breyta flipa' : 'Nýr flipi'}
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-[12px] text-paper-soft dark:text-ink-soft block mb-1">
              Heiti (íslenska)
            </label>
            <input
              required
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="t.d. Fyrir smíðaverkstjóra"
              className="w-full rounded-lg border border-paper-border dark:border-ink-border bg-transparent px-3 py-2 text-[13px]"
            />
          </div>
          <div>
            <label className="text-[12px] text-paper-soft dark:text-ink-soft block mb-1">
              Heiti (enska)
            </label>
            <input
              value={form.name_en}
              onChange={(e) => setForm((f) => ({ ...f, name_en: e.target.value }))}
              placeholder="e.g. For site supervisors"
              className="w-full rounded-lg border border-paper-border dark:border-ink-border bg-transparent px-3 py-2 text-[13px]"
            />
          </div>
        </div>

        <div>
          <label className="text-[12px] text-paper-soft dark:text-ink-soft block mb-1">
            Slóð (slug)
          </label>
          <input
            value={form.slug}
            onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
            placeholder={form.name ? slugify(form.name) : 'sjalfgefid-ur-heiti'}
            className="w-full rounded-lg border border-paper-border dark:border-ink-border bg-transparent px-3 py-2 text-[13px]"
          />
        </div>

        <div>
          <label className="text-[12px] text-paper-soft dark:text-ink-soft block mb-1">
            Lýsing
          </label>
          <textarea
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            rows={2}
            className="w-full rounded-lg border border-paper-border dark:border-ink-border bg-transparent px-3 py-2 text-[13px]"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="text-[12px] text-paper-soft dark:text-ink-soft block mb-1">
              Lágmarks aðgangsstig
            </label>
            <select
              value={form.min_access_level}
              onChange={(e) =>
                setForm((f) => ({ ...f, min_access_level: e.target.value as AccessLevel }))
              }
              className="w-full rounded-lg border border-paper-border dark:border-ink-border bg-transparent px-3 py-2 text-[13px]"
            >
              {ACCESS_LEVELS.map((lvl) => (
                <option key={lvl} value={lvl}>
                  {lvl}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[12px] text-paper-soft dark:text-ink-soft block mb-1">
              Röðun
            </label>
            <input
              type="number"
              value={form.sort_order}
              onChange={(e) =>
                setForm((f) => ({ ...f, sort_order: Number(e.target.value) }))
              }
              className="w-full rounded-lg border border-paper-border dark:border-ink-border bg-transparent px-3 py-2 text-[13px]"
            />
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
              />
              Virkur
            </label>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            type="submit"
            className="rounded-lg bg-ink-DEFAULT text-paper-DEFAULT dark:bg-paper-DEFAULT dark:text-ink-DEFAULT px-4 py-2 text-[13px] font-medium"
          >
            {editingId ? 'Vista breytingar' : 'Búa til flipa'}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={() => {
                setEditingId(null);
                setForm(emptyForm);
              }}
              className="rounded-lg border border-paper-border dark:border-ink-border px-4 py-2 text-[13px]"
            >
              Hætta við
            </button>
          )}
        </div>
      </form>

      {/* Tabs list */}
      {loading ? (
        <p className="text-[13px] text-paper-faint dark:text-ink-faint">Hleð...</p>
      ) : tabs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-paper-border dark:border-ink-border p-10 text-center text-sm text-paper-faint dark:text-ink-faint">
          Engir flipar ennþá. Búðu til fyrsta flipann hér að ofan.
        </div>
      ) : (
        <div className="space-y-3">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className="rounded-xl border border-paper-border dark:border-ink-border p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="text-[14px] font-medium">{tab.name}</h4>
                    {!tab.is_active && (
                      <span className="text-[11px] rounded-full bg-paper-border dark:bg-ink-border px-2 py-0.5">
                        óvirkur
                      </span>
                    )}
                    <span className="text-[11px] text-paper-faint dark:text-ink-faint">
                      {tab.min_access_level}
                    </span>
                  </div>
                  {tab.description && (
                    <p className="text-[12.5px] text-paper-soft dark:text-ink-soft mt-1">
                      {tab.description}
                    </p>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => toggleExpand(tab.id)}
                    className="text-[12px] rounded-lg border border-paper-border dark:border-ink-border px-3 py-1.5"
                  >
                    {expandedTabId === tab.id ? 'Loka' : 'Skjöl'}
                  </button>
                  <button
                    onClick={() => startEdit(tab)}
                    className="text-[12px] rounded-lg border border-paper-border dark:border-ink-border px-3 py-1.5"
                  >
                    Breyta
                  </button>
                  <button
                    onClick={() => deleteTab(tab.id)}
                    className="text-[12px] rounded-lg border border-red-300 text-red-600 dark:border-red-800 dark:text-red-400 px-3 py-1.5"
                  >
                    Eyða
                  </button>
                </div>
              </div>

              {expandedTabId === tab.id && (
                <div className="mt-4 pt-4 border-t border-paper-border dark:border-ink-border space-y-3">
                  <div className="relative">
                    <input
                      value={docSearch}
                      onChange={(e) => searchDocuments(e.target.value)}
                      placeholder="Leita að skjali til að bæta við..."
                      className="w-full rounded-lg border border-paper-border dark:border-ink-border bg-transparent px-3 py-2 text-[13px]"
                    />
                    {docResults.length > 0 && (
                      <div className="absolute z-20 mt-1 w-full rounded-lg border border-paper-border dark:border-ink-border bg-paper-surface dark:bg-ink-surface shadow-lg"> 
{docResults.map((doc) => (
                          <button
                            key={doc.id}
                            onClick={() => addDocumentToTab(tab.id, doc.id)}
                            className="block w-full text-left px-3 py-2 text-[13px] hover:bg-paper-border dark:hover:bg-ink-border"
                          >
                            {doc.title}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <ul className="space-y-1.5">
                    {(tabDocuments[tab.id] ?? []).map((td) => (
                      <li
                        key={td.id}
                        className="flex items-center justify-between text-[13px] rounded-lg bg-paper-border/40 dark:bg-ink-border/40 px-3 py-1.5"
                      >
                        <span>{td.documents?.title ?? '(skjal fannst ekki)'}</span>
                        <button
                          onClick={() => removeDocumentFromTab(tab.id, td.id)}
                          className="text-[12px] text-red-600 dark:text-red-400"
                        >
                          Fjarlægja
                        </button>
                      </li>
                    ))}
                    {(tabDocuments[tab.id] ?? []).length === 0 && (
                      <li className="text-[12.5px] text-paper-faint dark:text-ink-faint">
                        Engin skjöl í þessum flipa ennþá.
                      </li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
