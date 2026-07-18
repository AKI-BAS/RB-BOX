import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(request: Request) {
  // 1. Verify the caller is an admin — same pattern as create-user /
  // set-password: the actual delete goes through the service-role client
  // below, so this check has to happen manually first.
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { data: caller } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (caller?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await request.json();
  const { userId } = body;
  if (!userId || typeof userId !== 'string') {
    return NextResponse.json({ error: 'Missing userId' }, { status: 400 });
  }

  // Guard against self-lockout — an admin can't delete their own account
  // this way (whether by mistake or by design, losing the only signed-in
  // admin session with no undo isn't a state this route should allow).
  if (userId === user.id) {
    return NextResponse.json({ error: 'Ekki hægt að eyða eigin notanda.' }, { status: 400 });
  }

  // Deleting the auth user is sufficient — profiles.id references
  // auth.users(id) ON DELETE CASCADE, so the profile row goes with it.
  // Everything else that references profiles(id) is already either
  // ON DELETE CASCADE (bookmarks, search_history — per-user personal data,
  // fine to remove with the account) or ON DELETE SET NULL
  // (documents.uploaded_by, download_log, contributions, scrape_runs —
  // content and history stay, just with a null user reference). No
  // additional manual cleanup needed; verified against every migration
  // that references profiles(id).
  const admin = createAdminClient();
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
