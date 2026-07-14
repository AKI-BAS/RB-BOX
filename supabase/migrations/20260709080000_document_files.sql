-- ═══════════════════════════════════════════════════════════════════════
-- documents.source_url + document_files — multi-attachment document model
-- ═══════════════════════════════════════════════════════════════════════
--
-- Some HMS content bundles multiple things: an HTML guidance page that
-- links out to several downloadable PDFs (some self-hosted, some external
-- e.g. althingi.is regulation text), or a PDF whose canonical source is a
-- guidance page. documents.source_url records that canonical guidance/
-- source page (distinct from external_url, which is the URL the primary
-- file's bytes were fetched from, and distinct from sources.base_url, which
-- is the source's general listing page, not a per-document page).
--
-- document_files holds the "downloads" list for a document — mirrors the
-- document_categories join-table pattern (one row per attachment) rather
-- than a metadata jsonb array, so it's easy to insert/delete/reorder the
-- same way categories already are.

alter table public.documents
  add column if not exists source_url text;

comment on column public.documents.source_url is
  'Canonical guidance/source page for this doc (e.g. the hms.is content page), distinct from external_url (the fetched file URL) and from sources.base_url (the source''s general listing page).';

create table if not exists public.document_files (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references public.documents(id) on delete cascade,
  kind          text not null check (kind in ('self_hosted', 'external')),
  file_path     text,          -- Storage path, set when kind = 'self_hosted'
  url           text not null, -- external URL when kind = 'external'; informational/original URL when self_hosted
  label         text,          -- display text, e.g. "Lög um mannvirki nr. 160/2010"
  sort_order    int not null default 0,
  created_at    timestamptz not null default now()
);

comment on table public.document_files is
  'Additional downloadable files attached to a document (the "Downloads" list) — self-hosted PDFs in Storage or external links, distinct from the document''s own primary file_path.';

create index if not exists document_files_document_idx on public.document_files (document_id, sort_order);

alter table public.document_files enable row level security;

create policy document_files_read  on public.document_files for select using (auth.role() = 'authenticated');
create policy document_files_admin on public.document_files for all    using (is_admin()) with check (is_admin());

-- ── Seed the new source: web-native RB-blöð reports + LCA guidance pages ──
-- scrape_mode = manual_import (not crawler): only 8 known docs today, no
-- need for hourly polling — run on demand from /admin/sources.
insert into public.sources
  (slug, name, name_en, description, base_url, is_active,
   scrape_mode, scrape_config, scrape_interval_hours, auto_publish, trust_level)
values
  ('hms-rb-blod-web',
   'HMS · RB-blöð (vefur) og lífsferilsgreining',
   'HMS · RB Guidance Reports (web) & LCA',
   'Nýrri RB-blöð sem birt eru sem vefsíður frekar en PDF, og lífsferilsgreiningarleiðbeiningar (sótt beint úr Prismic API)',
   'https://hms.is/lifsferilsgreining',
   true, 'manual_import',
   jsonb_build_object(
     'prismic_repo', 'hms-web',
     'lang',         '*',
     'page_size',    100
   ),
   null, true, 5)
on conflict (slug) do update set
  scrape_mode = excluded.scrape_mode,
  scrape_config = excluded.scrape_config,
  scrape_interval_hours = excluded.scrape_interval_hours,
  auto_publish = excluded.auto_publish,
  is_active = excluded.is_active,
  description = coalesce(public.sources.description, excluded.description),
  base_url = coalesce(public.sources.base_url, excluded.base_url);
