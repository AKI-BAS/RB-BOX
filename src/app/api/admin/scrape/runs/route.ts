import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * GET /api/admin/scrape/runs?source_id=…&limit=20
 *
 * Returns recent scrape_runs rows. If `source_id` is omitted, returns runs
 * across all sources — used by the run-history sidebar.
 */
export async function GET(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { data: caller } = await supabase
    .from('profiles').select('role').eq('id', user.id).single();
  if (caller?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const url = new URL(request.url);
  const sourceId = url.searchParams.get('source_id');
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 100);

  let query = supabase
    .from('scrape_runs')
    .select('id, source_id, trigger, status, started_at, finished_at, discovered, added, updated, skipped, errors')
    .order('started_at', { ascending: false })
    .limit(limit);

  if (sourceId) query = query.eq('source_id', sourceId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ runs: data ?? [] });
}
