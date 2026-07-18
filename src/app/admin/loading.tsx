// Shown instantly by Next.js while admin/layout.tsx's server-side work is
// in flight — an auth check + a profile lookup + four tab-count queries,
// none of which had ANY loading feedback before this file existed. Every
// admin nav (via AdminTabs' <Link>s) was a blank/frozen beat until that
// chain resolved; this fills the gap with an immediate skeleton shaped
// like the real layout so the swap-in doesn't jump around.
export default function AdminLoading() {
  return (
    <div className="min-h-screen bg-paper-bg dark:bg-ink-bg text-paper-text dark:text-ink-text">
      <div className="max-w-screen-2xl mx-auto px-6 pt-6 pb-16 animate-pulse">
        <div className="flex items-center gap-3 mb-6">
          <div className="h-8 w-20 rounded-md bg-paper-muted dark:bg-ink-muted" />
          <div className="h-5 w-24 rounded bg-paper-muted dark:bg-ink-muted" />
          <div className="h-6 w-16 rounded-md bg-paper-muted dark:bg-ink-muted" />
          <div className="flex-1" />
          <div className="w-8 h-8 rounded-full bg-paper-muted dark:bg-ink-muted" />
        </div>

        <div className="flex gap-4 border-b border-paper-border dark:border-ink-border mb-8 pb-2.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-4 w-20 rounded bg-paper-muted dark:bg-ink-muted" />
          ))}
        </div>

        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-12 rounded-lg bg-paper-muted/60 dark:bg-ink-muted/60" />
          ))}
        </div>
      </div>
    </div>
  );
}
