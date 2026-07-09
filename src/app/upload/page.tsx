'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import type { Source, Category } from '@/types/database';

// Fields Claude fills; used to gate the small "AI" badge next to each label.
type AIField = 'title' | 'description' | 'category_ids' | 'language' | 'tags';

// Small chip next to a label: shows which fields the model touched, so the
// admin knows what to double-check before publishing.
function AiBadge() {
  return (
    <span className="ai-badge">
      <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2L14.5 9.5 22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z" />
      </svg>
      AI
    </span>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function relativeUpload(seconds: number): string {
  if (seconds < 5)  return 'upphlaðið núna';
  if (seconds < 60) return `upphlaðið fyrir ${seconds} sek`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `upphlaðið fyrir ${m} mín`;
  return 'upphlaðið';
}

export default function AdminUploadPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileAcceptedAt, setFileAcceptedAt] = useState<number | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);

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
    tags: [] as string[],
    external_url: '',
  });

  const [aiFields, setAiFields] = useState<Set<AIField>>(new Set());
  const [aiSuggesting, setAiSuggesting] = useState(false);
  const [aiConfidence, setAiConfidence] = useState<number | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Tick the "upphlaðið fyrir X sek" line while the file card is visible
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  // Gate the page client-side. The middleware/RLS also enforce this on writes,
  // so this is just for UX (don't render the form to signed-out or viewer users).
  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.push('/login?next=/upload'); return; }
      const { data: prof } = await supabase
        .from('profiles').select('role').eq('id', user.id).single();
      if (!prof || (prof.role !== 'admin' && prof.role !== 'contributor')) {
        router.push('/');
        return;
      }
      setAuthChecked(true);
    })();
  }, [router]);

  useEffect(() => {
    if (!authChecked) return;
    const supabase = createClient();
    supabase.from('sources').select('*').eq('is_active', true).order('name')
      .then(({ data }) => data && setSources(data));
    supabase.from('categories').select('*').order('sort_order')
      .then(({ data }) => data && setCategories(data));
  }, [authChecked]);

  // Path from parent through child, e.g. "Einangrun › Þök"
  const categoryPath = useMemo(() => {
    return (id: string): string => {
      const c = categories.find((x) => x.id === id);
      if (!c) return '';
      if (!c.parent_id) return c.name;
      const parent = categories.find((x) => x.id === c.parent_id);
      return parent ? `${parent.name} › ${c.name}` : c.name;
    };
  }, [categories]);

  function acceptFile(f: File) {
    setFile(f);
    setFileAcceptedAt(Date.now());
    // Reset previous AI state — a new file needs a fresh reading
    setAiFields(new Set());
    setAiConfidence(null);
  }

  function clearAiOn(field: AIField) {
    setAiFields((s) => {
      if (!s.has(field)) return s;
      const next = new Set(s);
      next.delete(field);
      return next;
    });
  }

  async function analyze() {
    if (!file) return;
    setAiSuggesting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/admin/categorize', { method: 'POST', body: fd });
      const j = await res.json();
      if (res.ok) {
        // Only fill fields the model actually returned something for — that
        // way we don't wipe manual edits with empty strings.
        const filled = new Set<AIField>();
        setForm((f) => {
          const next = { ...f };
          if (j.title) { next.title = j.title; filled.add('title'); }
          if (j.summary) { next.description = j.summary; filled.add('description'); }
          if (j.language) { next.language = j.language; filled.add('language'); }
          if (Array.isArray(j.category_ids) && j.category_ids.length) {
            next.category_ids = j.category_ids;
            filled.add('category_ids');
          }
          if (Array.isArray(j.tags) && j.tags.length) {
            next.tags = j.tags;
            filled.add('tags');
          }
          return next;
        });
        setAiFields(filled);
        if (typeof j.confidence === 'number') setAiConfidence(j.confidence);
        if (typeof j.page_count === 'number') setPageCount(j.page_count);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setAiSuggesting(false);
    }
  }

  async function submit(status: 'draft' | 'published') {
    if (!file && !form.external_url) {
      setMessage('Skjal eða ytri hlekkur er nauðsynlegur.');
      return;
    }
    if (!form.title.trim()) {
      setMessage('Titill er nauðsynlegur.');
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
        status: status === 'draft' ? 'draft' : 'published',
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

    setUploading(false);
    router.push(status === 'draft' ? '/admin/sources' : `/document/${doc.id}`);
  }

  const secondsSinceAccept = fileAcceptedAt
    ? Math.round((now - fileAcceptedAt) / 1000)
    : 0;

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-paper-bg dark:bg-ink-bg" />
    );
  }

  return (
    <div className="min-h-screen bg-paper-bg dark:bg-ink-bg text-paper-text dark:text-ink-text">
      <div className="max-w-2xl mx-auto px-6 pt-6 pb-24">
        {/* Focused-flow header — one action per side */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => router.back()}
            className="h-8 pl-2 pr-3 rounded-md text-xs flex items-center gap-1.5 border border-paper-border dark:border-ink-border text-paper-soft dark:text-ink-soft hover:text-brick-500 hover:border-brick-500/40 transition"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12"/>
              <polyline points="12 19 5 12 12 5"/>
            </svg>
            <span>Til baka</span>
          </button>
          <h1 className="text-[15px] font-semibold tracking-tight">Nýtt skjal</h1>
          <div className="flex-1" />
          <button
            onClick={() => router.push('/admin/sources')}
            className="w-8 h-8 rounded-md text-paper-faint dark:text-ink-faint hover:bg-paper-muted dark:hover:bg-ink-muted hover:text-brick-500 flex items-center justify-center transition"
            title="Loka"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* File card or drop zone */}
        {file ? (
          <div className="rounded-xl border border-paper-border dark:border-ink-border bg-paper-surface dark:bg-ink-surface p-4 flex items-center gap-3 mb-3">
            <div className="w-10 h-12 rounded-md bg-brick-500/10 dark:bg-brick-500/20 text-brick-600 dark:text-brick-300 flex items-center justify-center shrink-0">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 3v4a1 1 0 0 0 1 1h4" />
                <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-medium truncate">{file.name}</div>
              <div className="text-[11.5px] font-mono text-paper-faint dark:text-ink-faint mt-0.5 truncate">
                {formatSize(file.size)}
                {pageCount != null && ` · ${pageCount} síður`}
                {fileAcceptedAt != null && ` · ${relativeUpload(secondsSinceAccept)}`}
              </div>
            </div>
            <label
              htmlFor="file-input"
              className="h-8 px-3 rounded-md text-xs border border-paper-border dark:border-ink-border text-paper-soft dark:text-ink-soft hover:text-brick-500 hover:border-brick-500/40 cursor-pointer transition"
            >
              Skipta út
            </label>
            <input
              type="file"
              id="file-input"
              accept=".pdf,.doc,.docx"
              onChange={(e) => e.target.files?.[0] && acceptFile(e.target.files[0])}
              className="hidden"
            />
          </div>
        ) : (
          <label
            htmlFor="file-input"
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) acceptFile(f);
            }}
            className={`block rounded-xl border-2 border-dashed p-10 text-center cursor-pointer transition mb-3 ${
              dragOver
                ? 'border-brick-500 bg-brick-500/[0.04]'
                : 'border-paper-border dark:border-ink-border hover:border-brick-500/40 bg-paper-surface dark:bg-ink-surface'
            }`}
          >
            <input
              type="file"
              id="file-input"
              accept=".pdf,.doc,.docx"
              onChange={(e) => e.target.files?.[0] && acceptFile(e.target.files[0])}
              className="hidden"
            />
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mx-auto text-paper-faint dark:text-ink-faint mb-2"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <div className="text-[13.5px]">Smelltu eða slepptu PDF hér</div>
            <div className="text-[11px] text-paper-faint dark:text-ink-faint mt-1">
              Að hámarki 30 MB · .pdf, .doc, .docx
            </div>
          </label>
        )}

        {/* AI notice — only after a file has been analyzed */}
        {file && aiFields.size > 0 && (
          <div className="rounded-xl border border-brick-500/25 bg-brick-50/60 dark:bg-brick-900/15 p-3.5 flex items-start gap-3 mb-6">
            <span className="mt-0.5 shrink-0 w-5 h-5 rounded flex items-center justify-center bg-brick-500/15 text-brick-600 dark:text-brick-300">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2L14.5 9.5 22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z" />
              </svg>
            </span>
            <div className="flex-1 text-[12.5px] text-paper-text dark:text-ink-text leading-snug">
              Claude hefur lesið skjalið og fyllt út reitina hér að neðan. Skoðaðu og breyttu áður en þú birtir.
              {aiConfidence != null && (
                <span className="text-paper-faint dark:text-ink-faint ml-1">
                  · {Math.round(aiConfidence * 100)}% vissa
                </span>
              )}
            </div>
            <button
              onClick={analyze}
              disabled={aiSuggesting}
              className="h-7 px-2.5 rounded-md text-[11.5px] border border-brick-500/30 text-brick-700 dark:text-brick-300 hover:bg-brick-500/10 flex items-center gap-1.5 disabled:opacity-60 transition shrink-0"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={aiSuggesting ? 'animate-spin' : ''}>
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
              <span>{aiSuggesting ? 'Les…' : 'Endurgreina'}</span>
            </button>
          </div>
        )}

        {/* When file is present but not yet analyzed */}
        {file && aiFields.size === 0 && (
          <button
            type="button"
            onClick={analyze}
            disabled={aiSuggesting}
            className="w-full mb-6 h-10 rounded-xl border border-brick-500/30 bg-brick-500/[0.04] text-brick-700 dark:text-brick-300 text-[13px] font-medium hover:bg-brick-500/[0.08] flex items-center justify-center gap-2 disabled:opacity-60 transition"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" className={aiSuggesting ? 'animate-pulse' : ''}>
              <path d="M12 2L14.5 9.5 22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z" />
            </svg>
            <span>{aiSuggesting ? 'Les skjalið…' : 'Láta Claude lesa og stinga upp á'}</span>
          </button>
        )}

        {/* Fields */}
        <div className="space-y-5">
          {/* Title */}
          <Field label="TITILL" required ai={aiFields.has('title')}>
            <input
              type="text"
              value={form.title}
              onChange={(e) => { setForm({ ...form, title: e.target.value }); clearAiOn('title'); }}
              className="w-full h-10 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-[13.5px] focus:border-brick-500 outline-none transition"
            />
          </Field>

          {/* Description */}
          <Field label="LÝSING" ai={aiFields.has('description')}>
            <textarea
              value={form.description}
              onChange={(e) => { setForm({ ...form, description: e.target.value }); clearAiOn('description'); }}
              rows={3}
              className="w-full min-h-[80px] px-3 py-2 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-[13.5px] focus:border-brick-500 outline-none transition resize-y"
            />
          </Field>

          {/* Category + Language — two columns */}
          <div className="grid grid-cols-2 gap-4">
            <Field label="FLOKKUR" required ai={aiFields.has('category_ids')}>
              <select
                value={form.category_ids[0] ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  setForm({ ...form, category_ids: v ? [v, ...form.category_ids.slice(1)] : [] });
                  clearAiOn('category_ids');
                }}
                className="w-full h-10 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-[13.5px] focus:border-brick-500 outline-none transition appearance-none pr-8"
                style={{ backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%238A8985' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center' }}
              >
                <option value="">— velja —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{categoryPath(c.id)}</option>
                ))}
              </select>
            </Field>
            <Field label="TUNGUMÁL" ai={aiFields.has('language')}>
              <select
                value={form.language}
                onChange={(e) => { setForm({ ...form, language: e.target.value }); clearAiOn('language'); }}
                className="w-full h-10 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-[13.5px] focus:border-brick-500 outline-none transition appearance-none pr-8"
                style={{ backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%238A8985' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center' }}
              >
                <option value="is">IS  Íslenska</option>
                <option value="en">EN  English</option>
                <option value="da">DA  Dansk</option>
              </select>
            </Field>
          </div>

          {/* Tags */}
          <Field label="MERKI" ai={aiFields.has('tags')}>
            <div className="min-h-[40px] flex flex-wrap items-center gap-1.5 px-2 py-1.5 rounded-md border border-paper-border dark:border-ink-border focus-within:border-brick-500 transition">
              {form.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-md bg-brick-500/10 dark:bg-brick-500/20 text-brick-700 dark:text-brick-200 text-[11.5px]"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => { setForm({ ...form, tags: form.tags.filter((t) => t !== tag) }); clearAiOn('tags'); }}
                    className="w-4 h-4 rounded hover:bg-brick-500/20 flex items-center justify-center"
                  >
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"/>
                      <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ',') && tagDraft.trim()) {
                    e.preventDefault();
                    const t = tagDraft.trim().toLowerCase();
                    if (!form.tags.includes(t)) {
                      setForm({ ...form, tags: [...form.tags, t] });
                    }
                    setTagDraft('');
                  } else if (e.key === 'Backspace' && !tagDraft && form.tags.length) {
                    setForm({ ...form, tags: form.tags.slice(0, -1) });
                  }
                }}
                placeholder="Bæta við merki…"
                className="flex-1 min-w-[120px] h-7 bg-transparent outline-none text-[13px] placeholder:text-paper-faint dark:placeholder:text-ink-faint"
              />
            </div>
          </Field>

          {/* Source + Document type — two columns */}
          <div className="grid grid-cols-2 gap-4">
            <Field label="HEIMILD">
              <select
                value={form.source_id}
                onChange={(e) => setForm({ ...form, source_id: e.target.value })}
                className="w-full h-10 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-[13.5px] focus:border-brick-500 outline-none transition appearance-none pr-8"
                style={{ backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%238A8985' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center' }}
              >
                <option value="">— velja —</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </Field>
            <Field label="SKJALATEGUND">
              <select
                value={form.document_type}
                onChange={(e) => setForm({ ...form, document_type: e.target.value as any })}
                className="w-full h-10 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-[13.5px] focus:border-brick-500 outline-none transition appearance-none pr-8"
                style={{ backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%238A8985' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center' }}
              >
                <option value="rb_blad">RB-blað</option>
                <option value="leidbeining">Leiðbeining</option>
                <option value="rannsokn">Rannsókn</option>
                <option value="handbok">Handbók</option>
                <option value="annad">Annað</option>
              </select>
            </Field>
          </div>

          {/* Access level — radio buttons */}
          <div>
            <label className="section-label block mb-2">AÐGANGSSTIG</label>
            <div className="grid grid-cols-4 gap-2">
              {([
                { key: 'open',       label: 'Opið' },
                { key: 'internal',   label: 'Innri' },
                { key: 'restricted', label: 'Takmarkað' },
                { key: 'paid',       label: 'Áskrift' },
              ] as const).map(({ key, label }) => {
                const active = form.access_level === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setForm({ ...form, access_level: key })}
                    className={`h-11 px-3 rounded-md border text-[13px] flex items-center gap-2 transition ${
                      active
                        ? 'border-brick-500 bg-brick-500/[0.06] text-brick-700 dark:text-brick-200'
                        : 'border-paper-border dark:border-ink-border text-paper-soft dark:text-ink-soft hover:border-brick-500/40'
                    }`}
                  >
                    <span
                      className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center shrink-0 transition ${
                        active
                          ? 'border-brick-500'
                          : 'border-paper-border dark:border-ink-border'
                      }`}
                    >
                      {active && <span className="w-1.5 h-1.5 rounded-full bg-brick-500" />}
                    </span>
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Message */}
        {message && (
          <div className="mt-6 text-[12.5px] text-brick-700 dark:text-brick-300">
            {message}
          </div>
        )}

        {/* Actions */}
        <div className="mt-8 flex items-center gap-3">
          <button
            type="button"
            disabled={uploading}
            onClick={() => submit('draft')}
            className="h-10 px-4 rounded-md text-[13px] border border-paper-border dark:border-ink-border text-paper-soft dark:text-ink-soft hover:border-brick-500/40 hover:text-brick-500 disabled:opacity-60 transition"
          >
            Vista sem uppkast
          </button>
          <div className="flex-1" />
          <button
            type="button"
            disabled={uploading}
            onClick={() => submit('published')}
            className="h-10 pl-4 pr-3.5 rounded-md bg-brick-500 hover:bg-brick-600 text-white text-[13px] font-medium flex items-center gap-1.5 shadow-sm shadow-brick-900/20 disabled:opacity-60 transition"
          >
            <span>{uploading ? 'Birtir…' : 'Birta núna'}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12"/>
              <polyline points="12 5 19 12 12 19"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// Field wrapper: label row (uppercase + optional * + optional AI badge), children below.
function Field({
  label,
  required,
  ai,
  children,
}: {
  label: string;
  required?: boolean;
  ai?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="section-label">{label}</span>
        {required && <span className="text-brick-500 text-[10px] leading-none">*</span>}
        {ai && <AiBadge />}
      </div>
      {children}
    </div>
  );
}
