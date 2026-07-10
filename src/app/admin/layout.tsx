import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { AdminTabs } from '@/components/admin/AdminTabs';

// Server component — fetches tab counts once per admin nav render.
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('username, role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') redirect('/');

  const [{ count: srcCount }, { count: catCount }, { count: userCount }, { count: docCount }] =
    await Promise.all([
      supabase.from('sources').select('*', { count: 'exact', head: true }),
      supabase.from('categories').select('*', { count: 'exact', head: true }),
      supabase.from('profiles').select('*', { count: 'exact', head: true }),
      supabase.from('documents').select('*', { count: 'exact', head: true }),
    ]);

  const tabs = [
    { href: '/admin/sources',    label: 'Heimildir', count: srcCount ?? 0 },
    { href: '/admin/documents',  label: 'Skjöl',      count: docCount ?? 0 },
    { href: '/admin/categories', label: 'Flokkar',   count: catCount ?? 0 },
    { href: '/admin/users',      label: 'Notendur',  count: userCount ?? 0 },
    { href: '/admin/tabs',       label: 'Flipar',    count: 0 },
  ];

  const initials =
    (profile?.username?.[0] ?? '·').toUpperCase() +
    (profile?.username?.[1] ?? '').toUpperCase();

  return (
    <div className="min-h-screen bg-paper-bg dark:bg-ink-bg text-paper-text dark:text-ink-text">
      <div className="max-w-5xl mx-auto px-6 pt-6 pb-16">
        {/* Header row */}
        <div className="flex items-center gap-3 mb-6">
          <Link
            href="/"
            className="h-8 pl-2 pr-3 rounded-md text-xs flex items-center gap-1.5 border border-paper-border dark:border-ink-border text-paper-soft dark:text-ink-soft hover:text-brick-500 hover:border-brick-500/40 transition"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12"/>
              <polyline points="12 19 5 12 12 5"/>
            </svg>
            <span>Til baka</span>
          </Link>

          <h1 className="text-[15px] font-semibold tracking-tight">Stjórnborð</h1>

          <span className="h-6 pl-1.5 pr-2 rounded-md text-[10px] flex items-center gap-1 bg-brick-50 text-brick-800 dark:bg-brick-900/40 dark:text-brick-300 font-medium tracking-wide uppercase">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            <span>Admin</span>
          </span>

          <div className="flex-1" />

          <span
            className="w-8 h-8 rounded-full bg-brick-50 dark:bg-brick-900/40 text-brick-700 dark:text-brick-300 flex items-center justify-center text-[10.5px] font-semibold"
            title={profile?.username}
          >
            {initials || '··'}
          </span>
        </div>

        <AdminTabs tabs={tabs} />

        {children}
      </div>
    </div>
  );
}
