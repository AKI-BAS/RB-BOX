'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Source, Category } from '@/types/database';

export default function AdminUploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [form, setForm] = useState({
    title: '',
    title_en: '',
    description: '',
    reference_code: '',
    source_id: '',
    document_type: 'annad' as 'rb_blad' | 'leidbeining' | 'rannsokn' | 'handbok' | 'annad',
    language: 'is',
    access_level: 'open' as 'open' | 'internal' | 'restricted' | 'paid',
    category_ids: [] as string[],
    external_url: '',
  });
  const [aiSuggesting, setAiSuggesting] = useState(false);
  const [aiSuggested, setAiSuggested] = useState<{
    categories: string[];
    tags: string[];
    summary: string;
    confidence: number;
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.from('sources').select('*').eq('is_active', true).then(({ data }) => data && setSources(data));
    supabase.from('categories').select('*').order('sort_order').then(({ data }) => data && setCategories(data));
  }, []);

  async function suggestFromFile() {
    if (!file) return;
    setAiSuggesting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/admin/categorize', { method: 'POST', body: fd });
      const j = await res.json();
      if (res.ok) {
        setAiSuggested(j);
        // Pre-fill form with suggestions the admin can override
        setForm((f) => ({
          ...f,
          title: j.title || f.title,
          description: j.summary || f.description,
          category_ids: j.category_ids || f.category_ids,
        }));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setAiSuggesting(false);
    }
  }

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!file && !form.external_url) {
      setMessage('Skjal eða ytri hlekkur er nauðsynlegur.');
      return;
    }
    setUploading(true);
    setMessage(null);

    const supabase = createClient();
    let file_path: string | null = null;

    if (file) {
      const path = `${Date.now()}-${file.name.replace(/[^\w.-]/g, '_')}`;
      const { error: upErr } = await supabase.storage
        .from('documents')
        .upload(path, file);
      if (upErr) {
        setMessage(`Villa við upphleðslu: ${upErr.message}`);
        setUploading(false);
        return;
      }
      file_path = path;
    }

    const { data: doc, error: docErr } = await supabase
      .from('documents')
      .insert({
        title: form.title,
        title_en: form.title_en || null,
        description: form.description || null,
        reference_code: form.reference_code || null,
        source_id: form.source_id || null,
        document_type: form.document_type,
        language: form.language,
        access_level: form.access_level,
        status: 'published',
        file_path,
        external_url: form.external_url || null,
      })
      .select()
      .single();

    if (docErr || !doc) {
      setMessage(`Villa: ${docErr?.message}`);
      setUploading(false);
      return;
    }

    if (form.category_ids.length > 0) {
      await supabase.from('document_categories').insert(
        form.category_ids.map((cid, i) => ({
          document_id: doc.id,
          category_id: cid,
          is_primary: i === 0,
        })),
      );
    }

    setMessage(`Vistað: ${doc.title}`);
    setFile(null);
    setForm({
      title: '', title_en: '', description: '', reference_code: '',
      source_id: '', document_type: 'annad', language: 'is',
      access_level: 'open', category_ids: [], external_url: '',
    });
    setAiSuggested(null);
    setUploading(false);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-medium">Hlaða upp handbók</h1>

      {/* File drop */}
      <div className="rounded-xl border border-dashed border-paper-border dark:border-ink-border p-8 text-center bg-paper-surface dark:bg-ink-surface">
        <input
          type="file"
          id="file-input"
          accept=".pdf,.doc,.docx"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          className="hidden"
        />
        <label htmlFor="file-input" className="cursor-pointer">
          <div className="text-3xl mb-2">↑</div>
          <div className="text-sm">
            {file ? file.name : 'Smelltu til að velja PDF eða slepptu skjali hér'}
          </div>
        </label>
        {file && (
          <button
            type="button"
            onClick={suggestFromFile}
            disabled={aiSuggesting}
            className="mt-4 h-8 px-3 rounded-md bg-brick-500 text-white text-xs font-medium hover:bg-brick-600 disabled:opacity-60"
          >
            {aiSuggesting ? 'Les skjalið…' : '✨ Láta RB-BOX lesa og stinga upp á flokkun'}
          </button>
        )}
      </div>

      {aiSuggested && (
        <div className="rounded-xl border border-brick-500/30 bg-brick-50 dark:bg-brick-900/20 p-4 text-sm">
          <div className="text-[10px] uppercase tracking-wider text-brick-800 dark:text-brick-300 mb-2">
            Uppástunga · {Math.round(aiSuggested.confidence * 100)}% vissa
          </div>
          <div className="text-paper-text dark:text-ink-text">
            <div className="mb-1"><b>Yfirlit:</b> {aiSuggested.summary}</div>
            <div className="mb-1"><b>Flokkar:</b> {aiSuggested.categories.join(', ')}</div>
            <div><b>Merki:</b> {aiSuggested.tags.join(', ')}</div>
          </div>
        </div>
      )}

      {/* Manual form */}
      <form onSubmit={upload} className="grid grid-cols-2 gap-3 rounded-xl border border-paper-border dark:border-ink-border bg-paper-surface dark:bg-ink-surface p-4">
        <input placeholder="Titill (IS)" required value={form.title}
               onChange={(e) => setForm({ ...form, title: e.target.value })}
               className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm col-span-2" />
        <input placeholder="Title (EN)" value={form.title_en}
               onChange={(e) => setForm({ ...form, title_en: e.target.value })}
               className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm col-span-2" />
        <input placeholder="RB kóði (t.d. RB.31.101.03)" value={form.reference_code}
               onChange={(e) => setForm({ ...form, reference_code: e.target.value })}
               className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm" />
        <select value={form.source_id}
                onChange={(e) => setForm({ ...form, source_id: e.target.value })}
                className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm">
          <option value="">— heimild —</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <select value={form.document_type}
                onChange={(e) => setForm({ ...form, document_type: e.target.value as any })}
                className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm">
          <option value="rb_blad">RB-blað</option>
          <option value="leidbeining">Leiðbeining</option>
          <option value="rannsokn">Rannsókn</option>
          <option value="handbok">Handbók</option>
          <option value="annad">Annað</option>
        </select>
        <select value={form.access_level}
                onChange={(e) => setForm({ ...form, access_level: e.target.value as any })}
                className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm">
          <option value="open">Opið</option>
          <option value="internal">Innra</option>
          <option value="restricted">Takmarkað</option>
          <option value="paid">Áskrift</option>
        </select>
        <textarea placeholder="Lýsing" value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="col-span-2 min-h-[80px] px-3 py-2 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm" />
        <input placeholder="Ytri hlekkur (ef við á, t.d. hms.is/…)" value={form.external_url}
               onChange={(e) => setForm({ ...form, external_url: e.target.value })}
               className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm col-span-2" />

        <fieldset className="col-span-2">
          <legend className="text-[10px] uppercase tracking-wider text-paper-faint dark:text-ink-faint mb-2">
            Flokkar (fyrsti verður aðal)
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {categories.map((c) => {
              const selected = form.category_ids.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() =>
                    setForm({
                      ...form,
                      category_ids: selected
                        ? form.category_ids.filter((id) => id !== c.id)
                        : [...form.category_ids, c.id],
                    })
                  }
                  className={`h-7 px-2.5 rounded-md text-xs border ${
                    selected
                      ? 'bg-brick-500 text-white border-brick-500'
                      : 'border-paper-border dark:border-ink-border text-paper-soft dark:text-ink-soft hover:border-brick-500'
                  }`}
                >
                  {c.name}
                </button>
              );
            })}
          </div>
        </fieldset>

        <button type="submit" disabled={uploading}
                className="col-span-2 h-9 rounded-md bg-brick-500 text-white text-sm font-medium hover:bg-brick-600 disabled:opacity-60">
          {uploading ? 'Hleð upp…' : 'Vista og birta'}
        </button>
        {message && (
          <div className="col-span-2 text-xs text-paper-soft dark:text-ink-soft">{message}</div>
        )}
      </form>
    </div>
  );
}
