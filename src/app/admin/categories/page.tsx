'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Category } from '@/types/database';

export default function AdminCategoriesPage() {
  const [cats, setCats] = useState<Category[]>([]);
  const [form, setForm] = useState({ slug: '', name: '', name_en: '', parent_id: '' });

  async function load() {
    const supabase = createClient();
    const { data } = await supabase.from('categories').select('*').order('sort_order');
    if (data) setCats(data);
  }
  useEffect(() => { load(); }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const supabase = createClient();
    const parent = cats.find((c) => c.id === form.parent_id);
    // path = parent.path + '.' + slug   (or just slug for roots)
    const path = parent ? `${parent.path}.${form.slug}` : form.slug;
    await supabase.from('categories').insert({
      slug: parent ? `${parent.slug}.${form.slug}` : form.slug,
      path,
      name: form.name,
      name_en: form.name_en || null,
      parent_id: form.parent_id || null,
    });
    setForm({ slug: '', name: '', name_en: '', parent_id: '' });
    load();
  }

  const roots = cats.filter((c) => !c.parent_id);
  const kids = (id: string) => cats.filter((c) => c.parent_id === id);

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-medium">Flokkar</h1>

      <form onSubmit={add}
            className="rounded-xl border border-paper-border dark:border-ink-border bg-paper-surface dark:bg-ink-surface p-4 grid grid-cols-4 gap-3">
        <select value={form.parent_id}
                onChange={(e) => setForm({ ...form, parent_id: e.target.value })}
                className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm">
          <option value="">— rót —</option>
          {roots.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        <input placeholder="slug" required value={form.slug}
               onChange={(e) => setForm({ ...form, slug: e.target.value })}
               className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm" />
        <input placeholder="Nafn (IS)" required value={form.name}
               onChange={(e) => setForm({ ...form, name: e.target.value })}
               className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm" />
        <input placeholder="Name (EN)" value={form.name_en}
               onChange={(e) => setForm({ ...form, name_en: e.target.value })}
               className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm" />
        <button type="submit" className="col-span-4 h-8 rounded-md bg-brick-500 text-white text-xs font-medium hover:bg-brick-600">
          Bæta við
        </button>
      </form>

      <div className="rounded-xl border border-paper-border dark:border-ink-border bg-paper-surface dark:bg-ink-surface p-4">
        <ul className="space-y-2">
          {roots.map((r) => (
            <li key={r.id}>
              <div className="text-sm font-medium">{r.name}
                <span className="ml-2 text-[11px] font-mono text-paper-faint dark:text-ink-faint">{r.slug}</span>
              </div>
              {kids(r.id).length > 0 && (
                <ul className="pl-4 mt-1 space-y-1">
                  {kids(r.id).map((k) => (
                    <li key={k.id} className="text-xs text-paper-soft dark:text-ink-soft">
                      ↳ {k.name}
                      <span className="ml-2 font-mono text-paper-faint dark:text-ink-faint">{k.slug}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
