import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { importSingleUrl } from '@/lib/scrapers/runner';

/**
 * POST /api/admin/scrape/import-url
 * Body: { source_id: string, url: string }
 *
 * For sources where automated crawling isn't a fit (single-page guides,
 * one-off finds), the admin can paste a URL and this route runs the same
 * fetch → analyze → store pipeline for exactly that one URL, tagging the
 * resulting document with the chosen source.
 *
 * Trust is inherited from the source (auto_publish decides whether the doc
 * is published immediately or lands in the review queue).
 */
export const maxDuration = 120;

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
  const url = String(body.url || '').trim();
  if (!sourceId || !url) {
    return NextResponse.json({ error: 'source_id and url required' }, { status: 400 });
  }
  try {
    // Cheap sanity check — a real URL parses
    new URL(url);
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  const result = await importSingleUrl({
    sourceId,
    url,
    triggeredBy: user.id,
  });

  if (result.error) {
    return NextResponse.json({ error: result.error, run_id: result.runId }, { status: 500 });
  }
  return NextResponse.json(result);
}
