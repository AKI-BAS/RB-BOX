-- ═══════════════════════════════════════════════════════════════════════
-- Categorization overhaul: provenance, DB-driven tag rules, keyword fallback
-- ═══════════════════════════════════════════════════════════════════════
--
-- Three pieces:
--   1. documents.categorization — records WHY a doc got the categories it
--      did (method/source_tags/matched/confidence/rationale), independent of
--      the existing documents.metadata jsonb blob.
--   2. category_tag_rules — source-tag → category_slug mapping, moved out of
--      hardcoded adapter TypeScript so it's editable without a deploy. This
--      is exactly the PRISMIC_TAG_CATEGORY_MAP that lived in
--      adapters/hms-rb-blod.ts, seeded here from the same (evidence-based,
--      see that file's prior history) mapping.
--   3. category_keywords — keyword → category_slug fallback with a weight,
--      used when no tag rule matches. A starter set of common Icelandic AEC
--      terms per category — expected to be tuned over time directly in the
--      DB, no code change required.
--
-- `priority` on category_tag_rules: LOWER number = higher confidence/rank.
-- When multiple tag rules match a doc, the lowest-priority match becomes the
-- primary category (document_categories.is_primary).
--
-- `weight` on category_keywords: HIGHER number = stronger signal. Weights
-- accumulate per category across every matching keyword; a category needs a
-- total weight >= 2 to be assigned (a single weak/ambiguous weight-1 keyword
-- alone isn't enough, but any single weight-2-or-3 keyword is).

-- ── documents.categorization ─────────────────────────────────────────────
alter table public.documents
  add column if not exists categorization jsonb not null default '{}'::jsonb;

comment on column public.documents.categorization is
  'Provenance for how this doc''s categories were assigned: { method: rule|keyword|ai|manual, source_tags: [...], matched: [{rule|keyword, category_slug}], confidence, rationale }.';

-- ── category_tag_rules ───────────────────────────────────────────────────
create table if not exists public.category_tag_rules (
  id           uuid primary key default gen_random_uuid(),
  source_tag   text not null,
  category_slug text not null references public.categories(slug) on delete cascade,
  priority     int not null default 100,
  created_at   timestamptz not null default now(),
  unique (source_tag, category_slug)
);

create index if not exists category_tag_rules_source_tag_idx
  on public.category_tag_rules (lower(source_tag));

alter table public.category_tag_rules enable row level security;

create policy category_tag_rules_admin_all on public.category_tag_rules
  for all
  using (public.is_admin())
  with check (public.is_admin());

-- Public read: the categorizer runs with the service role (bypasses RLS
-- anyway), but this table isn't sensitive and admins may want to inspect it
-- from the client later — allow read to any authenticated user.
create policy category_tag_rules_read on public.category_tag_rules
  for select
  using (auth.role() = 'authenticated');

-- Verified against the live hms-web Prismic repo (2026-07-09): tag frequency
-- across all 381 "RB Blöð" documents. Only tags with a near-literal,
-- unambiguous match to an existing category slug are seeded — see
-- adapters/hms-rb-blod.ts git history for the full frequency table.
insert into public.category_tag_rules (source_tag, category_slug, priority) values
  ('Steypa',                                          'steypa',      10),
  ('Steinsteypa',                                      'steypa',      10),
  ('Einangrun',                                        'einangrun',   10),
  ('Einangrunarefni',                                  'einangrun',   20),
  ('Burður',                                           'burdarvirki', 10),
  ('Þök, veggir og gólf',                              'thok',        30), -- compound tag, best-effort (roofs named first)
  ('Hljóð o.fl.',                                      'hljodvist',   10),
  ('Hljóð og hljómburður',                             'hljodvist',   10),
  ('Lóð og lagnir',                                    'lagnir',      20),
  ('Hreinlætis-, hita-, og loftræstibúnaður',          'lagnir',      30), -- broader HVAC term, closest existing category
  ('raflagnir og rafbúnaður',                          'rafmagn',     10)
on conflict (source_tag, category_slug) do update set priority = excluded.priority;

-- ── category_keywords ────────────────────────────────────────────────────
create table if not exists public.category_keywords (
  id           uuid primary key default gen_random_uuid(),
  keyword      text not null,
  category_slug text not null references public.categories(slug) on delete cascade,
  weight       int not null default 2,
  created_at   timestamptz not null default now(),
  unique (keyword, category_slug)
);

create index if not exists category_keywords_keyword_idx
  on public.category_keywords (lower(keyword));

alter table public.category_keywords enable row level security;

create policy category_keywords_admin_all on public.category_keywords
  for all
  using (public.is_admin())
  with check (public.is_admin());

create policy category_keywords_read on public.category_keywords
  for select
  using (auth.role() = 'authenticated');

-- Starter set of common Icelandic AEC terms, judgment-called against the 10
-- top-level category slugs from the initial seed migration. Deliberately
-- skips subcategories (steypa.styrktarhonnun etc.) — scope decision, can be
-- extended later directly in this table. Matching is case-insensitive
-- substring against title + tags + first ~2000 chars of extracted PDF text
-- (see src/lib/scrapers/categorize.ts) — no stemming, so a few explicit
-- inflected/compound forms are included where they're common enough to
-- matter (e.g. both "þak" and "þök").
insert into public.category_keywords (keyword, category_slug, weight) values
  -- steypa (concrete)
  ('steypa', 'steypa', 3), ('steypu', 'steypa', 3), ('steinsteypa', 'steypa', 3),
  ('steinsteypu', 'steypa', 3), ('sement', 'steypa', 2), ('steypustyrkur', 'steypa', 2),
  ('steypumót', 'steypa', 2), ('mótauppsláttur', 'steypa', 2), ('bendistál', 'steypa', 2),
  ('járnbending', 'steypa', 2), ('steypuviðgerð', 'steypa', 2), ('steypuskemmdir', 'steypa', 2),
  ('alkalívirkni', 'steypa', 2), ('steypuþekja', 'steypa', 1), ('steypuvinna', 'steypa', 2),

  -- einangrun (insulation)
  ('einangrun', 'einangrun', 3), ('einangrunar', 'einangrun', 3), ('einangrunargler', 'einangrun', 2),
  ('einangrunarefni', 'einangrun', 2), ('glerull', 'einangrun', 2), ('steinull', 'einangrun', 2),
  ('frauðplast', 'einangrun', 2), ('kuldabrú', 'einangrun', 2), ('kuldabrýr', 'einangrun', 2),
  ('varmaeinangrun', 'einangrun', 3), ('gufusperra', 'einangrun', 1), ('u-gildi', 'einangrun', 1),

  -- burdarvirki (structural)
  ('burðarvirki', 'burdarvirki', 3), ('burðarþol', 'burdarvirki', 3), ('burður', 'burdarvirki', 2),
  ('styrktarhönnun', 'burdarvirki', 3), ('undirstöður', 'burdarvirki', 2), ('undirstaða', 'burdarvirki', 2),
  ('sökkull', 'burdarvirki', 2), ('súla', 'burdarvirki', 1), ('burðargeta', 'burdarvirki', 2),
  ('jarðskjálftahönnun', 'burdarvirki', 2), ('stálgrind', 'burdarvirki', 1), ('timburgrind', 'burdarvirki', 1),

  -- thok (roofing)
  ('þak', 'thok', 3), ('þök', 'thok', 2), ('þaki', 'thok', 2), ('þakefni', 'thok', 2),
  ('þakpappi', 'thok', 3), ('þakjárn', 'thok', 2), ('þakklæðning', 'thok', 2), ('bárujárn', 'thok', 2),
  ('þakrenna', 'thok', 2), ('þakgluggi', 'thok', 2), ('flatt þak', 'thok', 2),

  -- lagnir (plumbing)
  ('lagnir', 'lagnir', 3), ('lögn', 'lagnir', 2), ('vatnslögn', 'lagnir', 2), ('fráveitulögn', 'lagnir', 2),
  ('skólplögn', 'lagnir', 2), ('hitalögn', 'lagnir', 2), ('neysluvatn', 'lagnir', 2),
  ('hreinlætistæki', 'lagnir', 2), ('loftræsting', 'lagnir', 2), ('loftræstikerfi', 'lagnir', 2),
  ('frárennsli', 'lagnir', 2),

  -- rafmagn (electrical)
  ('rafmagn', 'rafmagn', 3), ('raflögn', 'rafmagn', 3), ('rafbúnaður', 'rafmagn', 2),
  ('rafkerfi', 'rafmagn', 2), ('töflubúnaður', 'rafmagn', 2), ('spennir', 'rafmagn', 1),
  ('jarðtenging', 'rafmagn', 2), ('rafmagnsöryggi', 'rafmagn', 2), ('stofnlögn', 'rafmagn', 1),

  -- brunavarnir (fire safety)
  ('brunavarnir', 'brunavarnir', 3), ('eldvarnir', 'brunavarnir', 3), ('brunahólfun', 'brunavarnir', 3),
  ('brunamótstaða', 'brunavarnir', 2), ('brunaþol', 'brunavarnir', 2), ('reykræsting', 'brunavarnir', 2),
  ('slökkvikerfi', 'brunavarnir', 2), ('brunaviðvörunarkerfi', 'brunavarnir', 2), ('flóttaleið', 'brunavarnir', 2),
  ('brunahönnun', 'brunavarnir', 2), ('brunaáhætta', 'brunavarnir', 2), ('brunaáhættumat', 'brunavarnir', 3),

  -- hljodvist (acoustics)
  ('hljóðvist', 'hljodvist', 3), ('hljóðeinangrun', 'hljodvist', 3), ('hljóðdeyfing', 'hljodvist', 2),
  ('hljómburður', 'hljodvist', 3), ('högghljóð', 'hljodvist', 2), ('hljóðstig', 'hljodvist', 2),
  ('ómtími', 'hljodvist', 1),

  -- also: "hljóðeinangrun" genuinely spans both acoustics and insulation
  ('hljóðeinangrun', 'einangrun', 1),

  -- vinnuvernd (worker safety)
  ('vinnuvernd', 'vinnuvernd', 3), ('vinnuöryggi', 'vinnuvernd', 3), ('persónuhlífar', 'vinnuvernd', 2),
  ('vinnuslys', 'vinnuvernd', 2), ('áhættumat', 'vinnuvernd', 1), ('vinnupallar', 'vinnuvernd', 2),
  ('fallvarnir', 'vinnuvernd', 2),

  -- umhverfismal (environment)
  ('umhverfismál', 'umhverfismal', 3), ('sjálfbærni', 'umhverfismal', 2), ('kolefnisspor', 'umhverfismal', 3),
  ('vistvænar byggingar', 'umhverfismal', 2), ('umhverfisvottun', 'umhverfismal', 2),
  ('lífsferilsgreining', 'umhverfismal', 2), ('endurvinnsla', 'umhverfismal', 1)
on conflict (keyword, category_slug) do update set weight = excluded.weight;
