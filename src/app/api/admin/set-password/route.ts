import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(request: Request) {
  // 1. Verify the caller is an admin — same pattern as create-user: RLS
  // doesn't apply here since the actual update goes through the admin
  // (service-role) client below, so the admin check has to happen manually.
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

  // 2. Parse + validate input
  const body = await request.json();
  const { userId, password } = body;

  if (!userId || typeof userId !== 'string') {
    return NextResponse.json({ error: 'Missing userId' }, { status: 400 });
  }
  if (!password || password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 });
  }

  // 3. Set the new password via the admin API. There is no way to read back
  // an existing password (Supabase stores only a bcrypt hash) — this only
  // ever SETS a new one, it can never reveal the current one.
  const admin = createAdminClient();
  const { error: updateErr } = await admin.auth.admin.updateUserById(userId, { password });
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 400 });
  }

  // 4. Mirror create-user's convention: a password an admin sets on someone
  // else's behalf is a temporary one, so flag it for a forced change on next
  // login (same must_change_password flag new accounts get).
  await admin.from('profiles').update({ must_change_password: true }).eq('id', userId);

  return NextResponse.json({ ok: true });
}
