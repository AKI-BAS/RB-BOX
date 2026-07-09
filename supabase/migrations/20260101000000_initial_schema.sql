-- =====================================================================
-- RB-BOX  —  Initial schema
-- ---------------------------------------------------------------------
-- Tables, RLS, indexes, seed data.
-- Run with: supabase db reset  (local)  or  supabase db push  (remote)
-- =====================================================================

-- Extensions
create extension if not exists "uuid-ossp";
create extension if not exists "pg_trgm";      -- fuzzy / trigram search
create extension if not exists "ltree";        -- hierarchical categories
-- create extension if not exists "vector";    -- enable when you add semantic search

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type user_role as enum ('viewer', 'contributor', 'admin');
create type access_level as enum ('open', 'internal', 'restricted', 'paid');
create type document_type as enum ('rb_blad', 'leidbeining', 'rannsokn', 'handbok', 'annad');
create type doc_status as enum ('draft', 'pending_review', 'published', 'archived');

-- ---------------------------------------------------------------------
-- profiles  — extends auth.users
-- ---------------------------------------------------------------------
create table profiles (
  id             uuid primary key references auth.users on delete cascade,
  username       text unique not null,
  full_name      text,
  company        text,
  role           user_role not null default 'viewer',
  access_level   access_level not null default 'open',
  must_change_password boolean not null default true,
  language       text not null default 'is',   -- 'is' or 'en'
  theme          text not null default 'system', -- 'light' | 'dark' | 'system'
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz
);

create index on profiles (username);
create index on profiles (role);

-- ---------------------------------------------------------------------
-- sources  — HMS, RB, contributor, external, etc.
-- ---------------------------------------------------------------------
create table sources (
  id           uuid primary key default uuid_generate_v4(),
  slug         text unique not null,             -- 'hms', 'rb', 'contributed'
  name         text not null,
  name_en      text,
  description  text,
  base_url     text,
  logo_url     text,
  trust_level  int not null default 3,           -- 1..5
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- categories  — hierarchical via ltree
-- ---------------------------------------------------------------------
create table categories (
  id           uuid primary key default uuid_generate_v4(),
  slug         text unique not null,             -- 'steypa.styrktarhonnun'
  path         ltree unique not null,
  name         text not null,                    -- Icelandic name
  name_en      text,
  description  text,
  parent_id    uuid references categories(id) on delete set null,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now()
);

create index on categories using gist (path);
create index on categories (parent_id);

-- ---------------------------------------------------------------------
-- documents  — the heart of it
-- ---------------------------------------------------------------------
create table documents (
  id               uuid primary key default uuid_generate_v4(),
  title            text not null,
  title_en         text,
  description      text,
  description_en   text,
  source_id        uuid references sources(id) on delete set null,
  document_type    document_type not null default 'annad',
  language         text not null default 'is',   -- primary language of the doc
  reference_code   text,                         -- e.g. 'RB.31.101.03'
  version          text,
  published_date   date,
  access_level     access_level not null default 'open',
  status           doc_status not null default 'published',
  file_path        text,                         -- Supabase Storage path
  external_url     text,                         -- link to HMS pdf, etc.
  page_count       int,
  extracted_text   text,                         -- for full-text search
  metadata         jsonb not null default '{}'::jsonb,
  search_vector    tsvector,                     -- computed via trigger below
  uploaded_by      uuid references profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index documents_source_idx        on documents (source_id);
create index documents_type_idx          on documents (document_type);
create index documents_access_idx        on documents (access_level);
create index documents_status_idx        on documents (status);
create index documents_search_idx        on documents using gin (search_vector);
create index documents_title_trgm_idx    on documents using gin (title gin_trgm_ops);
create index documents_metadata_idx      on documents using gin (metadata);

-- Search vector trigger — combines title (both langs), description, extracted_text
create function documents_search_vector_update() returns trigger as $$
begin
  new.search_vector :=
    setweight(to_tsvector('simple', coalesce(new.title, '')),          'A') ||
    setweight(to_tsvector('simple', coalesce(new.title_en, '')),       'A') ||
    setweight(to_tsvector('simple', coalesce(new.reference_code, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(new.description, '')),    'B') ||
    setweight(to_tsvector('simple', coalesce(new.description_en, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(new.extracted_text, '')), 'C');
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

create trigger documents_search_vector_trigger
  before insert or update on documents
  for each row execute function documents_search_vector_update();

-- ---------------------------------------------------------------------
-- document_categories  — many-to-many
-- ---------------------------------------------------------------------
create table document_categories (
  document_id  uuid references documents(id) on delete cascade,
  category_id  uuid references categories(id) on delete cascade,
  is_primary   boolean not null default false,
  primary key (document_id, category_id)
);

-- ---------------------------------------------------------------------
-- tags — flat, community-driven keywords
-- ---------------------------------------------------------------------
create table tags (
  id       uuid primary key default uuid_generate_v4(),
  slug     text unique not null,
  name     text not null,
  usage_count int not null default 0
);

create table document_tags (
  document_id uuid references documents(id) on delete cascade,
  tag_id      uuid references tags(id) on delete cascade,
  primary key (document_id, tag_id)
);

-- ---------------------------------------------------------------------
-- synonyms  — "redirect of wordings" — expanded at query time
-- ---------------------------------------------------------------------
create table synonyms (
  id       uuid primary key default uuid_generate_v4(),
  term     text not null,
  aliases  text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index on synonyms using gin (aliases);
create index on synonyms (term);

-- ---------------------------------------------------------------------
-- User-side data
-- ---------------------------------------------------------------------
create table bookmarks (
  user_id     uuid references profiles(id) on delete cascade,
  document_id uuid references documents(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, document_id)
);

create table search_history (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid references profiles(id) on delete cascade,
  query      text not null,
  result_count int,
  created_at timestamptz not null default now()
);

create index on search_history (user_id, created_at desc);

create table download_log (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid references profiles(id) on delete set null,
  document_id  uuid references documents(id) on delete cascade,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Contribution / review queue
-- ---------------------------------------------------------------------
create table contributions (
  id             uuid primary key default uuid_generate_v4(),
  document_id    uuid references documents(id) on delete cascade,
  submitted_by   uuid references profiles(id) on delete set null,
  status         doc_status not null default 'pending_review',
  reviewer_id    uuid references profiles(id) on delete set null,
  review_notes   text,
  ai_suggested_categories jsonb,     -- {"categories": [...], "confidence": 0.87}
  ai_suggested_tags       jsonb,
  created_at     timestamptz not null default now(),
  reviewed_at    timestamptz
);

-- =====================================================================
-- Row Level Security
-- =====================================================================
alter table profiles              enable row level security;
alter table sources               enable row level security;
alter table categories            enable row level security;
alter table documents             enable row level security;
alter table document_categories   enable row level security;
alter table tags                  enable row level security;
alter table document_tags         enable row level security;
alter table synonyms              enable row level security;
alter table bookmarks             enable row level security;
alter table search_history        enable row level security;
alter table download_log          enable row level security;
alter table contributions         enable row level security;

-- Helper: check if the current user is admin
create or replace function is_admin() returns boolean
language sql security definer stable as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- Helper: current user's access_level
create or replace function my_access_level() returns access_level
language sql security definer stable as $$
  select coalesce((select access_level from profiles where id = auth.uid()), 'open'::access_level);
$$;

-- profiles: user can read/update their own; admin can everything
create policy profiles_self_read   on profiles for select using (id = auth.uid() or is_admin());
create policy profiles_self_update on profiles for update using (id = auth.uid());
create policy profiles_admin_all   on profiles for all    using (is_admin()) with check (is_admin());

-- sources / categories / synonyms / tags: readable by any signed-in user, writable by admin
create policy sources_read  on sources    for select using (auth.role() = 'authenticated');
create policy sources_admin on sources    for all    using (is_admin()) with check (is_admin());

create policy categories_read  on categories for select using (auth.role() = 'authenticated');
create policy categories_admin on categories for all    using (is_admin()) with check (is_admin());

create policy tags_read  on tags for select using (auth.role() = 'authenticated');
create policy tags_admin on tags for all    using (is_admin()) with check (is_admin());
create policy dtags_read on document_tags for select using (auth.role() = 'authenticated');
create policy dtags_admin on document_tags for all   using (is_admin()) with check (is_admin());

create policy synonyms_read  on synonyms for select using (auth.role() = 'authenticated');
create policy synonyms_admin on synonyms for all    using (is_admin()) with check (is_admin());

-- documents: readable if the doc's access_level is <= the user's tier and it's published
--   open       → everyone signed in
--   internal   → user's access_level in ('internal','restricted','paid')
--   restricted → user's access_level in ('restricted','paid')
--   paid       → user's access_level = 'paid'
create policy documents_read on documents for select using (
  auth.role() = 'authenticated'
  and status = 'published'
  and (
    access_level = 'open'
    or (access_level = 'internal'   and my_access_level() in ('internal','restricted','paid'))
    or (access_level = 'restricted' and my_access_level() in ('restricted','paid'))
    or (access_level = 'paid'       and my_access_level() = 'paid')
    or is_admin()
  )
);
create policy documents_admin on documents for all using (is_admin()) with check (is_admin());

create policy dcat_read  on document_categories for select using (auth.role() = 'authenticated');
create policy dcat_admin on document_categories for all    using (is_admin()) with check (is_admin());

-- bookmarks / search_history / download_log: only your own rows
create policy bookmarks_self on bookmarks
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy search_history_self on search_history
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy download_log_self on download_log
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- contributions: submitter can read their own + admin can read all; only admin can review
create policy contributions_submitter_read on contributions for select using (submitted_by = auth.uid() or is_admin());
create policy contributions_submit         on contributions for insert with check (submitted_by = auth.uid());
create policy contributions_admin_all      on contributions for all    using (is_admin()) with check (is_admin());

-- =====================================================================
-- Seed data
-- =====================================================================
insert into sources (slug, name, name_en, base_url, trust_level) values
  ('hms',         'HMS — Húsnæðis- og mannvirkjastofnun', 'HMS', 'https://hms.is', 5),
  ('rb',          'RB — Rannsóknarstofnun byggingariðnaðarins', 'RB', null, 5),
  ('contributed', 'Framlag notenda', 'User contributed', null, 3),
  ('external',    'Ytri hlekkur', 'External link', null, 2);

-- Top-level Icelandic AEC categories (extend later via admin UI)
insert into categories (slug, path, name, name_en, sort_order) values
  ('steypa',          'steypa',          'Steypa',              'Concrete',   1),
  ('einangrun',       'einangrun',       'Einangrun',           'Insulation', 2),
  ('thok',            'thok',            'Þök',                 'Roofing',    3),
  ('burdarvirki',     'burdarvirki',     'Burðarvirki',         'Structural', 4),
  ('lagnir',          'lagnir',          'Lagnir',              'Plumbing',   5),
  ('rafmagn',         'rafmagn',         'Rafmagn',             'Electrical', 6),
  ('brunavarnir',     'brunavarnir',     'Brunavarnir',         'Fire safety',7),
  ('hljodvist',       'hljodvist',       'Hljóðvist',           'Acoustics',  8),
  ('vinnuvernd',      'vinnuvernd',      'Vinnuvernd',          'Worker safety', 9),
  ('umhverfismal',    'umhverfismal',    'Umhverfismál',        'Environment',10);

-- Sub-categories under steypa (example)
insert into categories (slug, path, name, name_en, parent_id, sort_order)
select 'steypa.styrktarhonnun', 'steypa.styrktarhonnun', 'Styrktarhönnun', 'Structural design', id, 1
from categories where slug = 'steypa';

insert into categories (slug, path, name, name_en, parent_id, sort_order)
select 'steypa.styrkleikaprofun', 'steypa.styrkleikaprofun', 'Styrkleikaprófun', 'Strength testing', id, 2
from categories where slug = 'steypa';

-- Example synonyms (bilingual bridging)
insert into synonyms (term, aliases) values
  ('einangrun',   array['insulation','isolation']),
  ('steypa',      array['concrete','beton','steypuvinna']),
  ('þök',         array['roofing','roof','thak']),
  ('rakavörn',    array['moisture barrier','vapour barrier','damp proofing']),
  ('burðarvirki', array['structure','structural','load-bearing']);

-- Storage buckets (create via SQL — cleaner than the dashboard)
insert into storage.buckets (id, name, public) values
  ('documents', 'documents', false),
  ('logos',     'logos',     true)
on conflict (id) do nothing;

-- Storage policies: signed-in users can read documents, only admins write
create policy "read documents bucket"
  on storage.objects for select
  using (bucket_id = 'documents' and auth.role() = 'authenticated');

create policy "admin writes documents bucket"
  on storage.objects for insert
  with check (bucket_id = 'documents' and is_admin());

create policy "admin updates documents bucket"
  on storage.objects for update
  using (bucket_id = 'documents' and is_admin());

create policy "admin deletes documents bucket"
  on storage.objects for delete
  using (bucket_id = 'documents' and is_admin());

-- =====================================================================
-- End of migration
-- =====================================================================
