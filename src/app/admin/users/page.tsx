'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Profile } from '@/types/database';

export default function AdminUsersPage() {
  const [users, setUsers] = useState<Profile[]>([]);
  const [form, setForm] = useState({
    username: '',
    password: '',
    full_name: '',
    company: '',
    role: 'viewer' as 'viewer' | 'contributor' | 'admin',
    access_level: 'open' as 'open' | 'internal' | 'restricted' | 'paid',
  });
  const [message, setMessage] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    const supabase = createClient();
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });
    if (data) setUsers(data);
  }
  useEffect(() => { load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/create-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Failed');
      setMessage(`Notandi ${form.username} búinn til.`);
      setForm({
        username: '', password: '', full_name: '', company: '',
        role: 'viewer', access_level: 'open',
      });
      load();
    } catch (err: any) {
      setMessage(`Villa: ${err.message}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-medium">Notendur</h1>

      <form onSubmit={create}
            className="rounded-xl border border-paper-border dark:border-ink-border bg-paper-surface dark:bg-ink-surface p-4 grid grid-cols-2 gap-3">
        <input placeholder="notandanafn" required minLength={3} value={form.username}
               onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })}
               className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm" />
        <input placeholder="bráðabirgða lykilorð" required type="text" value={form.password}
               onChange={(e) => setForm({ ...form, password: e.target.value })}
               className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm" />
        <input placeholder="fullt nafn" value={form.full_name}
               onChange={(e) => setForm({ ...form, full_name: e.target.value })}
               className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm" />
        <input placeholder="fyrirtæki" value={form.company}
               onChange={(e) => setForm({ ...form, company: e.target.value })}
               className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm" />
        <select value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value as any })}
                className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm">
          <option value="viewer">viewer</option>
          <option value="contributor">contributor</option>
          <option value="admin">admin</option>
        </select>
        <select value={form.access_level}
                onChange={(e) => setForm({ ...form, access_level: e.target.value as any })}
                className="h-9 px-3 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm">
          <option value="open">open</option>
          <option value="internal">internal</option>
          <option value="restricted">restricted</option>
          <option value="paid">paid</option>
        </select>
        <button type="submit" disabled={creating}
                className="col-span-2 h-8 rounded-md bg-brick-500 text-white text-xs font-medium hover:bg-brick-600 disabled:opacity-60">
          {creating ? '…' : 'Búa til notanda'}
        </button>
        {message && (
          <div className="col-span-2 text-xs text-paper-soft dark:text-ink-soft">{message}</div>
        )}
      </form>

      <div className="rounded-xl border border-paper-border dark:border-ink-border bg-paper-surface dark:bg-ink-surface overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-[10px] uppercase tracking-wider text-paper-faint dark:text-ink-faint bg-paper-muted dark:bg-ink-muted">
            <tr>
              <th className="text-left px-4 py-2">Notandanafn</th>
              <th className="text-left px-4 py-2">Nafn</th>
              <th className="text-left px-4 py-2">Fyrirtæki</th>
              <th className="text-left px-4 py-2">Hlutverk</th>
              <th className="text-left px-4 py-2">Aðgangur</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-paper-border dark:border-ink-border">
                <td className="px-4 py-2 font-mono text-xs">{u.username}</td>
                <td className="px-4 py-2">{u.full_name}</td>
                <td className="px-4 py-2 text-paper-faint dark:text-ink-faint">{u.company}</td>
                <td className="px-4 py-2">
                  <span className={u.role === 'admin' ? 'text-brick-500 font-medium' : ''}>{u.role}</span>
                </td>
                <td className="px-4 py-2 text-xs text-paper-faint dark:text-ink-faint uppercase">{u.access_level}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
