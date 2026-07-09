'use client';

import { Suspense, useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { usernameToEmail } from '@/lib/auth';
import { t, type Lang } from '@/lib/i18n';

function useNextParam(): string {
  const params = useSearchParams();
  return params.get('next') || '/';
}

function LoginPageInner() {
  const router = useRouter();
  const next = useNextParam();

  const [lang, setLang] = useState<Lang>('is');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [libraryStats, setLibraryStats] = useState<{
    docs: number;
    lastSync: string | null;
  }>({ docs: 0, lastSync: null });

  useEffect(() => {
    // Load a small trust cue: how many docs are in the library right now.
    const supabase = createClient();
    supabase
      .from('documents')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'published')
      .then(({ count }) => {
        if (count != null) setLibraryStats((s) => ({ ...s, docs: count }));
      });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: usernameToEmail(username),
      password,
    });

    if (authError) {
      setError(
        lang === 'is'
          ? 'Rangt notandanafn eða lykilorð.'
          : 'Incorrect username or password.',
      );
      setLoading(false);
      return;
    }

    // Hard navigation — a soft router.push() races the cookie write and
    // the middleware bounces you back to /login. Full page load fixes it.
    window.location.href = next;
  }

  return (
    <div className="min-h-screen bg-paper-bg dark:bg-ink-bg text-paper-text dark:text-ink-text flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <div className="w-3.5 h-3.5 rounded bg-brick-500" />
          <span className="text-[11px] tracking-wider text-paper-faint dark:text-ink-faint">
            RB-BOX
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <button
            onClick={() => setLang('is')}
            className={
              lang === 'is'
                ? 'text-brick-500 font-medium'
                : 'text-paper-faint dark:text-ink-faint hover:text-paper-text dark:hover:text-ink-text'
            }
          >
            IS
          </button>
          <span className="text-paper-faint dark:text-ink-faint">·</span>
          <button
            onClick={() => setLang('en')}
            className={
              lang === 'en'
                ? 'text-brick-500 font-medium'
                : 'text-paper-faint dark:text-ink-faint hover:text-paper-text dark:hover:text-ink-text'
            }
          >
            EN
          </button>
        </div>
      </div>

      {/* Center card */}
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="w-full max-w-xs">
          <div className="mb-8 text-center">
            <div className="mx-auto w-9 h-9 rounded-lg bg-brick-500 mb-4" />
            <h1 className="text-lg font-medium">{t(lang, 'signIn')}</h1>
            <p className="mt-1 text-xs text-paper-faint dark:text-ink-faint">
              {t(lang, 'inviteOnly')}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-paper-soft dark:text-ink-soft mb-1.5">
                {t(lang, 'username')}
              </label>
              <input
                type="text"
                autoComplete="username"
                autoFocus
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full h-10 px-3 rounded-lg bg-paper-surface dark:bg-ink-surface border border-paper-border dark:border-ink-border focus:border-brick-500 focus:outline-none text-sm"
              />
            </div>

            <div>
              <label className="block text-[11px] uppercase tracking-wider text-paper-soft dark:text-ink-soft mb-1.5">
                {t(lang, 'password')}
              </label>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full h-10 px-3 rounded-lg bg-paper-surface dark:bg-ink-surface border border-paper-border dark:border-ink-border focus:border-brick-500 focus:outline-none text-sm"
              />
            </div>

            {error && (
              <div className="text-xs text-brick-500 pt-1">{error}</div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full h-10 rounded-lg bg-brick-500 hover:bg-brick-600 text-white text-sm font-medium transition disabled:opacity-60"
            >
              {loading ? '…' : t(lang, 'signInButton')}
            </button>
          </form>

          <div className="mt-6 flex items-center justify-between text-[11px]">
            <a
              href="mailto:hello@rb-box.is"
              className="text-paper-faint dark:text-ink-faint hover:text-brick-500"
            >
              {t(lang, 'requestAccess')}
            </a>
            <a
              href="mailto:hello@rb-box.is"
              className="text-paper-faint dark:text-ink-faint hover:text-brick-500"
            >
              {t(lang, 'forgot')}
            </a>
          </div>

          {/* Trust cue */}
          <div className="mt-10 text-center text-[10px] text-paper-faint dark:text-ink-faint">
            {libraryStats.docs.toLocaleString('is-IS')}{' '}
            {lang === 'is' ? 'skjöl í safninu' : 'documents in the library'}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}
