import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { runScrape } from '@/lib/scrapers/runner';

/**
 * POST /api/admin/scrape/run
 * Body: { source_id: string }
 *
 * Admin-only. Runs the adapter for the given source synchronously and returns
 * the run summary. For long-running scrapes, this can take 30-60s per source
 * (bounded by the polite 1req/sec throttle + Anthropic API per-doc call).
 *
 * If your deployment enforces a shorter serverless timeout, either raise the
 * limit on this route or move heavy runs to a background queue (e.g. Supabase
 * Edge Function). MVP is synchronous.
 */
export const maxDuration = 300; // 5 min — Vercel Pro allows this on server routes

export async function POST(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { data: caller } = await supabase
    .from('profiles').select('role').eq('id', user.id).single();
  if (caller?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const sourceId = String(body.source_id || '');
  if (!sourceId) return NextResponse.json({ error: 'source_id required' }, { status: 400 });

  try {
    const summary = await runScrape({
      sourceId,
      trigger: 'manual',
      triggeredBy: user.id,
    });
    return NextResponse.json(summary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
