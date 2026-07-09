-- ═══════════════════════════════════════════════════════════════════════
-- documents.source_ref — stable per-source identifier for dedup/upsert
-- ═══════════════════════════════════════════════════════════════════════
--
-- Structured adapters (e.g. hms-rb-blod, backed by Prismic) can identify a
-- document by a stable reference (e.g. "RB(31).101") independent of its
-- current file URL. Without this, a CDN URL rotation would cause the runner
-- to re-insert the same logical document as a duplicate.
--
-- source_ref is only meaningful scoped to a source (two sources could both
-- use "31.101"-shaped refs), so the uniqueness constraint is on the pair.
-- NULL source_ref (crawler adapters that don't have a stable ref) is exempt
-- via the partial index.

alter table public.documents
  add column if not exists source_ref text;

comment on column public.documents.source_ref is
  'Stable per-source identifier used for dedup/upsert (e.g. "RB(31).101"). NULL for sources without a stable reference scheme.';

create unique index if not exists documents_source_id_source_ref_idx
  on public.documents (source_id, source_ref)
  where source_ref is not null;
