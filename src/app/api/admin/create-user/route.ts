import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { usernameToEmail, isValidUsername } from '@/lib/auth';

export async function POST(request: Request) {
  // 1. Verify the caller is an admin (RLS on profiles will not help here since we use admin client below)
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
  const { username, password, full_name, company, role, access_level } = body;

  if (!isValidUsername(username)) {
    return NextResponse.json(
      { error: 'Invalid username. Use 3–32 lowercase letters, numbers, dot, underscore, or dash.' },
      { status: 400 },
    );
  }
  if (!password || password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 });
  }

  // 3. Create the auth user via the admin API
  const admin = createAdminClient();
  const email = usernameToEmail(username);

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // synthetic domain — no actual mailbox exists
    user_metadata: { username, full_name, company },
  });
  if (createErr || !created.user) {
    return NextResponse.json({ error: createErr?.message || 'Auth create failed' }, { status: 400 });
  }

  // 4. Create the profile row (RLS uses admin path so this works)
  const { error: profileErr } = await admin.from('profiles').insert({
    id: created.user.id,
    username,
    full_name: full_name || null,
    company: company || null,
    role: role || 'viewer',
    access_level: access_level || 'open',
    must_change_password: true,
  });
  if (profileErr) {
    // Try to roll back the auth user so we don't leave dangling accounts
    await admin.auth.admin.deleteUser(created.user.id);
    return NextResponse.json({ error: profileErr.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, username });
}
