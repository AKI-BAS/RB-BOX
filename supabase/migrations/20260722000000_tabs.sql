-- Sérsniðnir flipar: admin-curated tabs + personal saved documents
-- Adds two independent features that both render as "tabs" on the homepage:
--   1. tabs / tab_documents   -> admin-curated collections, gated by access_level
--   2. saved_documents        -> per-user bookmarks ("Mín uppáhaldsskjöl")

-- ── tabs ─────────────────────────────────────────────────────────────
create table if not exists tabs (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  name_en text,
  description text,
  description_en text,
  min_access_level access_level not null default 'open',
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table tabs is 'Admin-curated document collections shown at the bottom of the homepage for a given audience (gated by min_access_level).';

-- ── tab_documents ────────────────────────────────────────────────────
create table if not exists tab_documents (
  id uuid primary key default gen_random_uuid(),
  tab_id uuid not null references tabs(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (tab_id, document_id)
);

-- ── saved_documents ──────────────────────────────────────────────────
create table if not exists saved_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, document_id)
);

comment on table saved_documents is 'Personal bookmarks — documents a user saves to come back to. Surfaced on the homepage as an auto-generated "Mín uppáhaldsskjöl" tab.';

-- ── indexes ──────────────────────────────────────────────────────────
create index if not exists idx_tab_documents_tab_id on tab_documents(tab_id);
create index if not exists idx_tab_documents_document_id on tab_documents(document_id);
create index if not exists idx_saved_documents_user_id on saved_documents(user_id);
create index if not exists idx_saved_documents_document_id on saved_documents(document_id);
create index if not exists idx_tabs_active_sort on tabs(is_active, sort_order);

-- ── updated_at trigger for tabs ──────────────────────────────────────
create or replace function set_tabs_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_tabs_updated_at on tabs;
create trigger trg_tabs_updated_at
  before update on tabs
  for each row execute function set_tabs_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────
alter table tabs enable row level security;
alter table tab_documents enable row level security;
alter table saved_documents enable row level security;

-- tabs: anyone whose access_level clears the bar can read active tabs;
-- only admins can write.
drop policy if exists tabs_select on tabs;
create policy tabs_select on tabs
  for select
  using (
    is_active
    and (
      is_admin()
      or (
        case min_access_level
          when 'open' then true
          when 'internal' then my_access_level() in ('internal', 'restricted', 'paid')
          when 'restricted' then my_access_level() in ('restricted', 'paid')
          when 'paid' then my_access_level() = 'paid'
        end
      )
    )
  );

drop policy if exists tabs_admin_all on tabs;
create policy tabs_admin_all on tabs
  for all
  using (is_admin())
  with check (is_admin());

-- tab_documents: readable if the parent tab is readable; admin-only writes.
drop policy if exists tab_documents_select on tab_documents;
create policy tab_documents_select on tab_documents
  for select
  using (
    exists (
      select 1 from tabs t
      where t.id = tab_documents.tab_id
        and t.is_active
    )
  );

drop policy if exists tab_documents_admin_all on tab_documents;
create policy tab_documents_admin_all on tab_documents
  for all
  using (is_admin())
  with check (is_admin());

-- saved_documents: a user can only see/manage their own saves.
drop policy if exists saved_documents_owner on saved_documents;
create policy saved_documents_owner on saved_documents
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
