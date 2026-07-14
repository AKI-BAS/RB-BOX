import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const SIGNED_URL_TTL_SECONDS = 60;

/**
 * Signed download for a document's primary file. Uses the user's own
 * session (not the admin client) so the `documents_read` RLS policy
 * (status + access_level tiering) gates which docs can be fetched at all —
 * if the row isn't visible to this user, there's nothing to sign.
 */
export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const { data: doc, error } = await supabase
    .from('documents')
    .select('id, file_path')
    .eq('id', params.id)
    .single();
  if (error || !doc) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (!doc.file_path) {
    return NextResponse.json({ error: 'No file for this document' }, { status: 404 });
  }

  const { data: signed, error: signErr } = await supabase.storage
    .from('documents')
    .createSignedUrl(doc.file_path, SIGNED_URL_TTL_SECONDS);
  if (signErr || !signed) {
    return NextResponse.json(
      { error: signErr?.message || 'Could not sign URL' },
      { status: 500 },
    );
  }

  return NextResponse.redirect(signed.signedUrl);
}
