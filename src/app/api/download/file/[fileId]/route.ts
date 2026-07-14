import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const SIGNED_URL_TTL_SECONDS = 60;

/**
 * Signed download for a self-hosted document_files attachment (a "Downloads"
 * list entry, distinct from the document's own primary file). The inner
 * join on documents means this only returns a row if the parent document
 * also passes documents_read RLS — a file attached to a doc this user can't
 * see is not signable via this route either.
 */
export async function GET(
  _request: Request,
  { params }: { params: { fileId: string } },
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const { data: file, error } = await supabase
    .from('document_files')
    .select('id, file_path, kind, documents!inner(id)')
    .eq('id', params.fileId)
    .single();
  if (error || !file) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (file.kind !== 'self_hosted' || !file.file_path) {
    return NextResponse.json({ error: 'Not a self-hosted file' }, { status: 400 });
  }

  const { data: signed, error: signErr } = await supabase.storage
    .from('documents')
    .createSignedUrl(file.file_path, SIGNED_URL_TTL_SECONDS);
  if (signErr || !signed) {
    return NextResponse.json(
      { error: signErr?.message || 'Could not sign URL' },
      { status: 500 },
    );
  }

  return NextResponse.redirect(signed.signedUrl);
}
