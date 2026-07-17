import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { PdfViewer } from '@/components/PdfViewer';
import { resolvePdfSrc } from '@/lib/pdf-src';
import type { DocumentFile } from '@/types/database';

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

  // document_files is a separate query, deliberately not embedded in the
  // documents select above: an embed/foreignTable-order on a table that
  // doesn't exist yet fails the WHOLE query (this doc 404s), not just the
  // embedded part. Queried standalone, a missing-table error here just
  // means an empty downloads list — the rest of the page still renders.
  // TODO: once the document_files migration is confirmed applied, this can
  // be folded back into a single embedded query if desired.
  let files: DocumentFile[] = [];
  const { data: filesData, error: filesErr } = await supabase
    .from('document_files')
    .select('*')
    .eq('document_id', doc.id)
    .order('sort_order');
  if (!filesErr && filesData) files = filesData;

  // doc.source_url is simply absent (undefined) from a `select('*')` result
  // if the column doesn't exist yet — safe without any extra guard.
  // Canonical URL precedence (source_url over external_url) is the same
  // rule the HMS adapters themselves follow: source_url is the adapter's
  // guidanceUrl when supplied (hms-rb-blod-web's HTML source page),
  // external_url is always populated as the fetched-file URL — for
  // hms-rb-blod (the PDF archive, no distinct guidance page) they're the
  // same hms.is PDF link either way.
  const guidanceUrl = doc.source_url ?? doc.external_url;
  const attributionUrl = doc.source_url ?? source?.base_url ?? null;

  // "Skoða PDF": self-hosted docs (contributor uploads, and any legacy
  // rows that still have a Storage copy) open the internal download route;
  // everything else — including every HMS doc post-retrofit, which never
  // gets a file_path — opens the canonical source URL directly in a new
  // tab. Hidden only when neither exists. Same formula as the inline
  // preview below and the search-results preview modal — resolvePdfSrc is
  // the one place this priority is decided.
  const pdfHref = resolvePdfSrc(doc);
  const pdfOpensExternally = !doc.file_path && Boolean(guidanceUrl);
  // "Opna hjá heimild" only adds information when Skoða PDF points at our
  // own copy — if Skoða PDF already opens the source directly, a second
  // identical link is just noise.
  const showSourceLink = Boolean(doc.file_path) && Boolean(guidanceUrl);
  const textPreview = doc.extracted_text?.trim().slice(0, 4000) || null;

  return (
    // lg+: a fixed-viewport two-pane reader — the page itself never scrolls,
    // only each pane does (h-screen + overflow-hidden here, min-h-0 down the
    // tree so the panes' own overflow-y-auto can actually kick in). Below
    // lg there's no room for a side-by-side split, so it collapses to a
    // single column and the page scrolls normally, same as before.
    <div className="flex flex-col min-h-screen lg:h-screen lg:overflow-hidden bg-paper-bg dark:bg-ink-bg text-paper-text dark:text-ink-text">
      <header className="shrink-0 px-4 py-3 flex items-center gap-3 border-b border-paper-border dark:border-ink-border">
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

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        {/* LEFT: reference/title/body/metadata — scrolls on its own on lg+ */}
        <div className="lg:w-2/5 lg:h-full lg:overflow-y-auto lg:border-r border-paper-border dark:border-ink-border px-6 py-10">
          <div className="max-w-3xl mx-auto lg:max-w-none">
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
              {pdfHref && (
                <a
                  href={pdfHref}
                  target={pdfOpensExternally ? '_blank' : undefined}
                  rel={pdfOpensExternally ? 'noreferrer' : undefined}
                  className="h-9 px-4 rounded-lg bg-brick-500 hover:bg-brick-600 text-white text-sm font-medium flex items-center gap-2"
                >
                  ↓ Skoða PDF
                </a>
              )}
              {showSourceLink && (
                <a
                  href={guidanceUrl ?? undefined}
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
          </div>
        </div>

        {/* RIGHT: preview pane — same source-priority + fallback as the
            search results preview modal, filling the full pane height on
            lg+ and scrolling independently of the left column. On mobile
            it's a fixed-height block below the info, same as before. */}
        <div className="lg:w-3/5 lg:h-full flex flex-col px-6 pb-10 pt-2 lg:p-6 lg:pt-6">
          <h2 className="shrink-0 text-xs uppercase tracking-wide text-paper-faint dark:text-ink-faint mb-2">
            Forskoðun
          </h2>
          <div className="rounded-xl border border-paper-border dark:border-ink-border overflow-hidden h-[60vh] sm:h-[75vh] lg:h-auto lg:flex-1 lg:min-h-0">
            <PdfViewer
              pdfSrc={pdfHref}
              title={doc.title}
              textPreview={textPreview}
              lang="is"
              className="h-full"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
