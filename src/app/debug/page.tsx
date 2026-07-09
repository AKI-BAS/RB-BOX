'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

interface TestResult {
  name: string;
  status: 'ok' | 'error' | 'missing' | 'empty' | 'pending';
  detail: string;
}

export default function DebugPage() {
  const [tests, setTests] = useState<TestResult[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    async function runTests() {
      const results: TestResult[] = [];
      const push = (r: TestResult) => {
        results.push(r);
        setTests([...results]);
      };

      // Test 1: env vars
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      const domain = process.env.NEXT_PUBLIC_SYNTHETIC_EMAIL_DOMAIN;

      push({
        name: 'env: NEXT_PUBLIC_SUPABASE_URL',
        status: url ? 'ok' : 'missing',
        detail: url || 'NOT SET — check .env.local and restart dev server',
      });
      push({
        name: 'env: NEXT_PUBLIC_SUPABASE_ANON_KEY',
        status: anon ? 'ok' : 'missing',
        detail: anon
          ? `length ${anon.length}, starts "${anon.slice(0, 15)}...", ends "...${anon.slice(-8)}"`
          : 'NOT SET',
      });
      push({
        name: 'env: NEXT_PUBLIC_SYNTHETIC_EMAIL_DOMAIN',
        status: domain ? 'ok' : 'missing',
        detail: domain || 'NOT SET',
      });

      if (!url || !anon) {
        push({
          name: 'stopping tests',
          status: 'error',
          detail: 'Env vars missing — fix .env.local and restart `npm run dev`',
        });
        setDone(true);
        return;
      }

      // Test 2: create client
      let supabase;
      try {
        supabase = createClient();
        push({ name: 'createClient()', status: 'ok', detail: 'client instantiated' });
      } catch (e: any) {
        push({ name: 'createClient()', status: 'error', detail: e.message });
        setDone(true);
        return;
      }

      // Test 3: auth session
      const { data: userData, error: authError } = await supabase.auth.getUser();
      if (authError) {
        push({ name: 'auth.getUser()', status: 'error', detail: authError.message });
      } else if (!userData.user) {
        push({
          name: 'auth.getUser()',
          status: 'empty',
          detail: 'no user signed in — go to /login first',
        });
      } else {
        push({
          name: 'auth.getUser()',
          status: 'ok',
          detail: `user id: ${userData.user.id} · email: ${userData.user.email}`,
        });
      }

      // Test 4: profile query
      if (userData.user) {
        const { data: profile, error: profErr } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', userData.user.id)
          .maybeSingle();
        if (profErr) {
          push({
            name: 'profiles query (self)',
            status: 'error',
            detail: `code=${profErr.code} msg=${profErr.message} hint=${profErr.hint || ''}`,
          });
        } else if (!profile) {
          push({
            name: 'profiles query (self)',
            status: 'empty',
            detail: 'no profile row for this user id',
          });
        } else {
          push({
            name: 'profiles query (self)',
            status: 'ok',
            detail: `username=${profile.username} role=${profile.role} access=${profile.access_level}`,
          });
        }
      }

      // Test 5: sources
      const { data: sources, error: srcErr } = await supabase.from('sources').select('*');
      if (srcErr) {
        push({
          name: 'sources query',
          status: 'error',
          detail: `code=${srcErr.code} msg=${srcErr.message} hint=${srcErr.hint || ''}`,
        });
      } else {
        push({
          name: 'sources query',
          status: (sources?.length ?? 0) > 0 ? 'ok' : 'empty',
          detail: sources && sources.length > 0
            ? `${sources.length} rows: ${sources.map((s: any) => s.slug).join(', ')}`
            : 'query returned 0 rows',
        });
      }

      // Test 6: categories
      const { data: cats, error: catErr } = await supabase.from('categories').select('*');
      if (catErr) {
        push({
          name: 'categories query',
          status: 'error',
          detail: `code=${catErr.code} msg=${catErr.message} hint=${catErr.hint || ''}`,
        });
      } else {
        push({
          name: 'categories query',
          status: (cats?.length ?? 0) > 0 ? 'ok' : 'empty',
          detail: cats && cats.length > 0
            ? `${cats.length} rows: ${cats.slice(0, 5).map((c: any) => c.slug).join(', ')}${cats.length > 5 ? '...' : ''}`
            : 'query returned 0 rows',
        });
      }

      // Test 7: documents
      const { data: docs, error: docErr } = await supabase.from('documents').select('id, title').limit(5);
      if (docErr) {
        push({
          name: 'documents query',
          status: 'error',
          detail: `code=${docErr.code} msg=${docErr.message} hint=${docErr.hint || ''}`,
        });
      } else {
        push({
          name: 'documents query',
          status: 'ok',
          detail: `${docs?.length ?? 0} rows returned (expected 0 since nothing uploaded yet)`,
        });
      }

      setDone(true);
    }

    runTests();
  }, []);

  return (
    <div style={{
      padding: 24,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      background: '#fff',
      color: '#111',
      minHeight: '100vh',
      fontSize: 13,
    }}>
      <h1 style={{ marginTop: 0, fontSize: 18 }}>RB-BOX debug</h1>
      <p style={{ color: '#666', fontSize: 12 }}>
        Live diagnostic — visit while signed in. Delete this page once the app works.
      </p>
      <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 16 }}>
        <thead>
          <tr style={{ background: '#f5f5f5' }}>
            <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid #ccc', width: '30%' }}>Test</th>
            <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid #ccc', width: '10%' }}>Status</th>
            <th style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid #ccc' }}>Detail</th>
          </tr>
        </thead>
        <tbody>
          {tests.map((t, i) => (
            <tr key={i}>
              <td style={{ padding: 10, borderBottom: '1px solid #eee', verticalAlign: 'top' }}>{t.name}</td>
              <td style={{
                padding: 10,
                borderBottom: '1px solid #eee',
                verticalAlign: 'top',
                color:
                  t.status === 'ok' ? '#0a7d2c'
                  : t.status === 'empty' ? '#b26a00'
                  : '#a32d2d',
                fontWeight: 600,
              }}>{t.status}</td>
              <td style={{ padding: 10, borderBottom: '1px solid #eee', wordBreak: 'break-all', verticalAlign: 'top' }}>{t.detail}</td>
            </tr>
          ))}
          {!done && (
            <tr><td colSpan={3} style={{ padding: 10, color: '#666' }}>Running…</td></tr>
          )}
        </tbody>
      </table>

      {done && (
        <div style={{ marginTop: 24, padding: 16, background: '#f5f5f5', borderRadius: 8, fontSize: 12 }}>
          <b>What the statuses mean:</b>
          <ul style={{ margin: '8px 0 0 20px' }}>
            <li><b style={{ color: '#0a7d2c' }}>ok</b> — working as expected</li>
            <li><b style={{ color: '#b26a00' }}>empty</b> — request succeeded but returned no data (usually an RLS or auth issue)</li>
            <li><b style={{ color: '#a32d2d' }}>error</b> — the request itself failed; see the detail column</li>
            <li><b style={{ color: '#a32d2d' }}>missing</b> — a required env var is not set</li>
          </ul>
        </div>
      )}
    </div>
  );
}
