import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import type { DocumentFile } from '@/types/database';

export default async function DocumentPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createClient();
  const { data: doc } = await supabase
    .from('documents')
    .select('*, source:sources(*), document_files(*)')
    .eq('id', params.id)
    .order('sort_order', { foreignTable: 'document_files' })
    .single();

  if (!doc) notFound();

  const source = (doc as any).source as { name: string; base_url: string | null } | null;
  const files = ((doc as any).document_files ?? []) as DocumentFile[];
  const guidanceUrl = doc.source_url ?? doc.external_url;
  const attributionUrl = doc.source_url ?? source?.base_url ?? null;

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
          {source && (
            <div className="mt-2 text-xs text-paper-faint dark:text-ink-faint">
              Heimild:{' '}
              {attributionUrl ? (
                <a
                  href={attributionUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-dotted hover:text-brick-500"
                >
                  {source.name}
                </a>
              ) : (
                source.name
              )}
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
              ↓ Skoða PDF
            </a>
          )}
          {guidanceUrl && (
            <a
              href={guidanceUrl}
              target="_blank"
              rel="noreferrer"
              className="h-9 px-4 rounded-lg border border-paper-border dark:border-ink-border hover:border-brick-500 text-sm flex items-center gap-2"
            >
              ↗ Opna hjá heimild
            </a>
          )}
        </div>

        {files.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xs uppercase tracking-wide text-paper-faint dark:text-ink-faint mb-2">
              Fylgigögn
            </h2>
            <ul className="space-y-1.5">
              {files.map((f) => (
                <li key={f.id}>
                  <a
                    href={f.kind === 'self_hosted' ? `/api/download/file/${f.id}` : f.url}
                    target={f.kind === 'external' ? '_blank' : undefined}
                    rel={f.kind === 'external' ? 'noreferrer' : undefined}
                    className="text-sm flex items-center gap-2 text-paper-text dark:text-ink-text hover:text-brick-500 transition"
                  >
                    <span className="text-paper-faint dark:text-ink-faint">
                      {f.kind === 'self_hosted' ? '↓' : '↗'}
                    </span>
                    <span className="truncate">{f.label || f.url}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}

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
