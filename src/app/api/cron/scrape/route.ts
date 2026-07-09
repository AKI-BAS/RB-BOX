import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { runScrape } from '@/lib/scrapers/runner';

/**
 * GET /api/cron/scrape
 *
 * Nightly Vercel Cron entrypoint. Auth via `Authorization: Bearer <CRON_SECRET>`.
 * Vercel Cron sends this header automatically when the route is declared in
 * vercel.json's `crons` array — but we still verify so this endpoint can't be
 * hit externally.
 *
 * Iterates every source where scrape_mode is 'crawler' or 'both' and enough
 * time has elapsed since last_scraped_at (per source.scrape_interval_hours).
 *
 * Runs are sequential to keep politeness rails intact — parallel runs to
 * different hosts would be fine in theory but the DB writes get messy and the
 * MVP doesn't need the speed. If you want parallel, add a Promise.allSettled
 * around the loop with a small concurrency cap.
 */
export const maxDuration = 800; // needs to fit multiple sequential runs

export async function GET(request: Request) {
  // Auth
  const auth = request.headers.get('authorization') || '';
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();

  // Fetch sources due for a scrape via the SQL helper we created in the migration
  const { data: due, error } = await supabase.rpc('sources_due_for_scrape');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const summaries: unknown[] = [];
  for (const source of due ?? []) {
    try {
      const summary = await runScrape({
        sourceId: (source as { id: string }).id,
        trigger: 'cron',
      });
      summaries.push(summary);
    } catch (err) {
      summaries.push({
        sourceId: (source as { id: string }).id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ ran: summaries.length, summaries });
}
