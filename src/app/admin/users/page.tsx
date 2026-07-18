'use client';

import { Fragment, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Profile } from '@/types/database';

// Not a security-sensitive secret store — just avoids visually-confusable
// characters (l/1/I, O/0) so an admin reading this off-screen to someone
// doesn't mistype it, and mixes in enough character classes to be a
// reasonable temporary password.
function generatePassword(length = 16): string {
  const charset = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*';
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => charset[b % charset.length]).join('');
}

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

  // Password-change panel state — one row open at a time.
  const [pwUserId, setPwUserId] = useState<string | null>(null);
  const [pwValue, setPwValue] = useState('');
  const [pwVisible, setPwVisible] = useState(false);
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMessage, setPwMessage] = useState<string | null>(null);

  function openPasswordPanel(userId: string) {
    setPwUserId(userId);
    setPwValue('');
    setPwVisible(false);
    setPwMessage(null);
  }

  function closePasswordPanel() {
    setPwUserId(null);
    setPwValue('');
    setPwVisible(false);
    setPwMessage(null);
  }

  async function savePassword(userId: string) {
    if (pwValue.length < 8) {
      setPwMessage('Lykilorð verður að vera minnst 8 stafir.');
      return;
    }
    setPwSaving(true);
    setPwMessage(null);
    try {
      const res = await fetch('/api/admin/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, password: pwValue }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Failed');
      setPwMessage('Nýtt lykilorð vistað.');
      setPwValue('');
    } catch (err: any) {
      setPwMessage(`Villa: ${err.message}`);
    } finally {
      setPwSaving(false);
    }
  }

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

      <div className="rounded-xl border border-paper-border dark:border-ink-border bg-paper-surface dark:bg-ink-surface overflow-hidden overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-[10px] uppercase tracking-wider text-paper-faint dark:text-ink-faint bg-paper-muted dark:bg-ink-muted">
            <tr>
              <th className="text-left px-4 py-2">Notandanafn</th>
              <th className="text-left px-4 py-2">Nafn</th>
              <th className="text-left px-4 py-2">Fyrirtæki</th>
              <th className="text-left px-4 py-2">Hlutverk</th>
              <th className="text-left px-4 py-2">Aðgangur</th>
              <th className="text-left px-4 py-2">Aðgerðir</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <Fragment key={u.id}>
                <tr className="border-t border-paper-border dark:border-ink-border">
                  <td className="px-4 py-2 font-mono text-xs">{u.username}</td>
                  <td className="px-4 py-2">{u.full_name}</td>
                  <td className="px-4 py-2 text-paper-faint dark:text-ink-faint">{u.company}</td>
                  <td className="px-4 py-2">
                    <span className={u.role === 'admin' ? 'text-brick-500 font-medium' : ''}>{u.role}</span>
                  </td>
                  <td className="px-4 py-2 text-xs text-paper-faint dark:text-ink-faint uppercase">{u.access_level}</td>
                  <td className="px-4 py-2">
                    {pwUserId === u.id ? (
                      <button
                        onClick={closePasswordPanel}
                        className="h-7 px-2.5 rounded-md text-xs border border-paper-border dark:border-ink-border text-paper-soft dark:text-ink-soft hover:text-brick-500"
                      >
                        Hætta við
                      </button>
                    ) : (
                      <button
                        onClick={() => openPasswordPanel(u.id)}
                        className="h-7 px-2.5 rounded-md text-xs border border-paper-border dark:border-ink-border text-paper-soft dark:text-ink-soft hover:text-brick-500"
                      >
                        Breyta lykilorði
                      </button>
                    )}
                  </td>
                </tr>
                {pwUserId === u.id && (
                  <tr key={`${u.id}-pw`} className="border-t border-paper-border dark:border-ink-border bg-paper-muted dark:bg-ink-muted">
                    <td colSpan={6} className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-paper-faint dark:text-ink-faint">
                          Nýtt lykilorð fyrir <span className="font-mono">{u.username}</span>:
                        </span>
                        <div className="relative">
                          <input
                            type={pwVisible ? 'text' : 'password'}
                            value={pwValue}
                            onChange={(e) => setPwValue(e.target.value)}
                            placeholder="nýtt lykilorð"
                            minLength={8}
                            className="h-8 pl-3 pr-9 rounded-md bg-transparent border border-paper-border dark:border-ink-border text-sm w-52"
                          />
                          <button
                            type="button"
                            onClick={() => setPwVisible((v) => !v)}
                            title={pwVisible ? 'Fela' : 'Sýna'}
                            aria-label={pwVisible ? 'Fela lykilorð' : 'Sýna lykilorð'}
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-paper-faint dark:text-ink-faint hover:text-brick-500"
                          >
                            {pwVisible ? (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.6 18.6 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                                <line x1="1" y1="1" x2="23" y2="23" />
                              </svg>
                            ) : (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
                                <circle cx="12" cy="12" r="3" />
                              </svg>
                            )}
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setPwValue(generatePassword());
                            setPwVisible(true);
                          }}
                          className="h-8 px-2.5 rounded-md text-xs border border-paper-border dark:border-ink-border text-paper-soft dark:text-ink-soft hover:text-brick-500"
                        >
                          Búa til lykilorð
                        </button>
                        <button
                          type="button"
                          disabled={pwSaving || pwValue.length < 8}
                          onClick={() => savePassword(u.id)}
                          className="h-8 px-3 rounded-md bg-brick-500 text-white text-xs font-medium hover:bg-brick-600 disabled:opacity-60"
                        >
                          {pwSaving ? '…' : 'Vista'}
                        </button>
                        {pwMessage && (
                          <span className="text-xs text-paper-soft dark:text-ink-soft">{pwMessage}</span>
                        )}
                      </div>
                      <p className="mt-1.5 text-[11px] text-paper-faint dark:text-ink-faint">
                        Þetta stillir NÝTT lykilorð — núverandi lykilorð er dulkóðað og er ekki hægt að birta.
                        Notandinn verður beðinn um að breyta lykilorðinu við næstu innskráningu.
                      </p>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
