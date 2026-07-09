import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export default async function DocumentPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createClient();
  const { data: doc } = await supabase
    .from('documents')
    .select('*, source:sources(*)')
    .eq('id', params.id)
    .single();

  if (!doc) notFound();

  const source = (doc as any).source as { name: string; base_url: string | null } | null;

  return (
    <div className="min-h-screen bg-paper-bg dark:bg-ink-bg text-paper-text dark:text-ink-text">
      <header className="px-4 py-3 flex items-center gap-3 border-b border-paper-border dark:border-ink-border">
        <Link
          href="/"
          className="h-7 px-2.5 rounded-md text-xs flex items-center gap-1.5 border border-paper-border dark:border-ink-border text-paper-soft dark:text-ink-soft hover:text-brick-500"
        >
          ← Til baka
        </Link>
        <div className="flex items-center gap-2">
          <div className="w-3.5 h-3.5 rounded bg-brick-500" />
          <span className="text-[11px] tracking-wider text-paper-faint dark:text-ink-faint">
            RB-BOX
          </span>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10">
        <div className="mb-6">
          <div className="text-[11px] font-mono text-paper-faint dark:text-ink-faint mb-2">
            {[
              doc.reference_code,
              source?.name,
              doc.published_date?.slice(0, 10),
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
          <h1 className="text-2xl font-medium">{doc.title}</h1>
          {doc.title_en && (
            <div className="mt-1 text-sm text-paper-soft dark:text-ink-soft">
              {doc.title_en}
            </div>
          )}
        </div>

        {doc.description && (
          <p className="text-sm leading-relaxed text-paper-soft dark:text-ink-soft mb-8">
            {doc.description}
          </p>
        )}

        <div className="flex flex-wrap gap-2 mb-8">
          {doc.file_path && (
            <a
              href={`/api/download/${doc.id}`}
              className="h-9 px-4 rounded-lg bg-brick-500 hover:bg-brick-600 text-white text-sm font-medium flex items-center gap-2"
            >
              ↓ Sækja
            </a>
          )}
          {doc.external_url && (
            <a
              href={doc.external_url}
              target="_blank"
              rel="noreferrer"
              className="h-9 px-4 rounded-lg border border-paper-border dark:border-ink-border hover:border-brick-500 text-sm flex items-center gap-2"
            >
              ↗ Opna hjá heimild
            </a>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <dt className="text-paper-faint dark:text-ink-faint">Tegund</dt>
          <dd>{doc.document_type}</dd>
          <dt className="text-paper-faint dark:text-ink-faint">Aðgangur</dt>
          <dd>{doc.access_level}</dd>
          <dt className="text-paper-faint dark:text-ink-faint">Tungumál</dt>
          <dd>{doc.language}</dd>
          {doc.version && (
            <>
              <dt className="text-paper-faint dark:text-ink-faint">Útgáfa</dt>
              <dd>{doc.version}</dd>
            </>
          )}
        </dl>
      </main>
    </div>
  );
}
