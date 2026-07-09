-- ═══════════════════════════════════════════════════════════════════════
-- Scraper subsystem
-- ═══════════════════════════════════════════════════════════════════════
--
-- Adds:
--   • Extra columns on `sources` (scrape_mode, scrape_config, interval, etc.)
--   • `scrape_runs` — one row per run attempt (cron or manual)
--   • `scrape_queue` — one row per discovered document URL, dedup by (source, url)
--   • Seeds the 5 initial trusted sources
--
-- Trust semantics:
--   auto_publish=true  → scraped docs land as status='published'
--   auto_publish=false → scraped docs land as status='pending_review'
--
-- Adapter selection: source.slug maps to a code adapter (e.g. slug='hms' → adapters/hms.ts).
-- ═══════════════════════════════════════════════════════════════════════

-- ── sources: extra columns ───────────────────────────────────────────────
alter table public.sources
  add column if not exists scrape_mode text not null default 'none'
    check (scrape_mode in ('none', 'crawler', 'manual_import', 'both')),
  add column if not exists scrape_config jsonb not null default '{}'::jsonb,
  add column if not exists scrape_interval_hours int,
  add column if not exists last_scraped_at timestamptz,
  add column if not exists auto_publish boolean not null default false;

comment on column public.sources.scrape_mode is
  'How this source ingests docs: none=direct only, crawler=periodic discovery, manual_import=one-off URL import, both=either';
comment on column public.sources.scrape_config is
  'Adapter-specific config: seed URLs, allow/deny patterns, per-run caps';
comment on column public.sources.scrape_interval_hours is
  'How often the cron should trigger a run. NULL disables automatic runs but manual runs still work.';
comment on column public.sources.auto_publish is
  'When true, scraped docs are published immediately. When false, they land in pending_review.';

-- ── scrape_runs: one row per run ─────────────────────────────────────────
create table if not exists public.scrape_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.sources(id) on delete cascade,
  trigger text not null check (trigger in ('cron', 'manual', 'import')),
  status text not null default 'running'
    check (status in ('running', 'ok', 'error', 'partial', 'cancelled')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  discovered int not null default 0,
  added int not null default 0,
  updated int not null default 0,
  skipped int not null default 0,
  errors int not null default 0,
  error_log jsonb not null default '[]'::jsonb,
  triggered_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists scrape_runs_source_idx
  on public.scrape_runs (source_id, started_at desc);
create index if not exists scrape_runs_status_idx
  on public.scrape_runs (status) where status = 'running';

-- ── scrape_queue: one row per discovered URL ─────────────────────────────
create table if not exists public.scrape_queue (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.sources(id) on delete cascade,
  run_id uuid references public.scrape_runs(id) on delete set null,
  url text not null,
  url_hash text generated always as (encode(sha256(url::bytea), 'hex')) stored,
  content_hash text,
  title_hint text,
  status text not null default 'pending'
    check (status in ('pending', 'fetching', 'analyzing', 'imported', 'skipped', 'error')),
  document_id uuid references public.documents(id) on delete set null,
  error text,
  discovered_at timestamptz not null default now(),
  fetched_at timestamptz,
  imported_at timestamptz,
  unique (source_id, url_hash)
);

create index if not exists scrape_queue_run_idx
  on public.scrape_queue (run_id);
create index if not exists scrape_queue_status_idx
  on public.scrape_queue (source_id, status);
create index if not exists scrape_queue_content_hash_idx
  on public.scrape_queue (content_hash) where content_hash is not null;

-- ── RLS ──────────────────────────────────────────────────────────────────
alter table public.scrape_runs enable row level security;
alter table public.scrape_queue enable row level security;

-- Only admins can read/write scrape logs (they're internal ops data)
create policy scrape_runs_admin_all on public.scrape_runs
  for all
  using (public.is_admin())
  with check (public.is_admin());

create policy scrape_queue_admin_all on public.scrape_queue
  for all
  using (public.is_admin())
  with check (public.is_admin());

-- ── Seed the 5 initial trusted sources ───────────────────────────────────
-- Uses on-conflict-do-update so re-running is safe. Existing rows just get
-- the scraper fields backfilled without losing their other data.
insert into public.sources
  (slug, name, name_en, description, base_url, is_active,
   scrape_mode, scrape_config, scrape_interval_hours, auto_publish, trust_level)
values
  ('hms',
   'Húsnæðis- og mannvirkjastofnun',
   'Icelandic Housing & Construction Authority',
   'HMS · Leiðbeiningar, brunavarnir, algild hönnun',
   'https://hms.is',
   true, 'crawler',
   jsonb_build_object(
     'seed_urls', jsonb_build_array(
       'https://hms.is/leiðbeiningar-við-byggingarreglugerð',
       'https://hms.is/brunavarnir/leiðbeiningar/leiðbeiningar-við-byggingarreglugerðar',
       'https://hms.is/fraedsla/mannvirkjamal---fraedsla/algild-honnun-og-adgengi/leidbeiningar-log-og-reglur'
     ),
     'allow_hosts', jsonb_build_array('hms.is', 'www.hms.is'),
     'max_docs_per_run', 50
   ),
   168, true, 5),

  ('byggingarreglugerd',
   'Byggingarreglugerð',
   'Building Regulations Portal',
   'Leiðbeiningagátt — miðlægur listi yfir allar leiðbeiningar við byggingarreglugerð 112/2012',
   'https://www.byggingarreglugerd.is',
   true, 'crawler',
   jsonb_build_object(
     'seed_urls', jsonb_build_array(
       'https://www.byggingarreglugerd.is/leidbeiningagatt'
     ),
     'allow_hosts', jsonb_build_array('byggingarreglugerd.is', 'www.byggingarreglugerd.is'),
     'max_docs_per_run', 50
   ),
   168, true, 5),

  ('taktak',
   'Taktak',
   'Taktak',
   'Íslenskur þekkingargrunnur mannvirkjagerðar',
   'https://taktak.is',
   true, 'crawler',
   jsonb_build_object(
     'seed_urls', jsonb_build_array('https://taktak.is'),
     'allow_hosts', jsonb_build_array('taktak.is', 'www.taktak.is'),
     'max_docs_per_run', 30
   ),
   168, true, 4),

  ('svanurinn',
   'Svanurinn',
   'Nordic Swan Ecolabel',
   'Norrænt umhverfismerki · Vörukröfur og leiðbeiningar',
   'https://svanurinn.is',
   true, 'crawler',
   jsonb_build_object(
     'seed_urls', jsonb_build_array('https://svanurinn.is'),
     'allow_hosts', jsonb_build_array('svanurinn.is', 'www.svanurinn.is'),
     'max_docs_per_run', 30
   ),
   168, true, 4),

  ('byggjum-graenni',
   'Byggjum grænni framtíð',
   'Building a Greener Future',
   'Sjálfbær mannvirkjagerð · Leiðbeiningar og verklag',
   'https://byggjumgraenniframtid.is',
   true, 'both',
   jsonb_build_object(
     'seed_urls', jsonb_build_array('https://byggjumgraenniframtid.is'),
     'allow_hosts', jsonb_build_array('byggjumgraenniframtid.is', 'www.byggjumgraenniframtid.is'),
     'max_docs_per_run', 30
   ),
   168, true, 4)

on conflict (slug) do update set
  scrape_mode = excluded.scrape_mode,
  scrape_config = excluded.scrape_config,
  scrape_interval_hours = excluded.scrape_interval_hours,
  auto_publish = excluded.auto_publish,
  -- Don't clobber human-edited descriptions/names on re-run
  description = coalesce(public.sources.description, excluded.description),
  base_url = coalesce(public.sources.base_url, excluded.base_url);

-- ── Helper: sources due for a cron run ───────────────────────────────────
create or replace function public.sources_due_for_scrape()
returns setof public.sources
language sql
security definer
set search_path = public
as $$
  select *
  from public.sources
  where is_active
    and scrape_mode in ('crawler', 'both')
    and scrape_interval_hours is not null
    and (
      last_scraped_at is null
      or last_scraped_at < now() - (scrape_interval_hours || ' hours')::interval
    )
  order by coalesce(last_scraped_at, 'epoch'::timestamptz) asc;
$$;

revoke all on function public.sources_due_for_scrape() from public, anon, authenticated;
grant execute on function public.sources_due_for_scrape() to service_role;
