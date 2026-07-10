-- ═══════════════════════════════════════════════════════════════════════
-- Five new top-level categories + their tag rules / keywords
-- ═══════════════════════════════════════════════════════════════════════
--
-- The categorization dry-run (see 20260709040000_categorization.sql) found
-- that the majority of uncategorized hms-rb-blod docs carry tags with no
-- corresponding category at all — a real taxonomy gap, not a matching
-- problem. Adding the 5 most common missing subjects here.
--
-- This migration is a mirror of REST inserts already applied directly via
-- the service-role client (categories table has no DDL changes, this is
-- pure seed data) — included so a fresh `supabase db reset` stays in sync
-- with the live DB.

insert into public.categories (slug, path, name, name_en, sort_order) values
  ('klaedning',       'klaedning',       'Klæðning',          'Cladding',        11),
  ('timbur',          'timbur',          'Timbur',            'Timber',          12),
  ('gluggar-og-gler', 'gluggar-og-gler', 'Gluggar og gler',   'Windows & glass', 13),
  ('malning',         'malning',         'Málning',           'Paint',           14),
  ('flisar',          'flisar',          'Flísar',            'Tiles',           15)
on conflict (slug) do nothing;

-- ── category_tag_rules for the new categories ────────────────────────────
-- Verified tag frequency across all 381 live "RB Blöð" documents
-- (see hms-rb-blod.ts git history / prior conversation): these were
-- previously left unmapped for lack of a category to put them in.
insert into public.category_tag_rules (source_tag, category_slug, priority) values
  ('Timbur',                  'timbur',          10),
  ('Tré',                     'timbur',          10),
  ('Byggingartimbur',         'timbur',          20),
  ('Klæðning',                'klaedning',       10),
  ('Klæðningar',              'klaedning',       10),
  ('Lofta- og veggklæðning',  'klaedning',       15),
  ('Gler og gluggar',         'gluggar-og-gler', 10),
  ('Flísar',                  'flisar',          10),
  ('Málningarvörur',          'malning',         10)
on conflict (source_tag, category_slug) do update set priority = excluded.priority;

-- ── category_keywords for the new categories ─────────────────────────────
insert into public.category_keywords (keyword, category_slug, weight) values
  -- timbur (timber)
  ('timbur', 'timbur', 3), ('tré', 'timbur', 2), ('límtré', 'timbur', 3),
  ('krossviður', 'timbur', 3), ('viður', 'timbur', 2), ('timburklæðning', 'timbur', 2),
  ('spónaplata', 'timbur', 2), ('harðviður', 'timbur', 2), ('timburgrind', 'timbur', 1),

  -- gluggar-og-gler (windows & glass)
  ('gluggi', 'gluggar-og-gler', 3), ('gluggar', 'gluggar-og-gler', 3), ('gler', 'gluggar-og-gler', 2),
  ('rúða', 'gluggar-og-gler', 2), ('rúður', 'gluggar-og-gler', 2), ('glerjun', 'gluggar-og-gler', 2),
  ('gluggaísetning', 'gluggar-og-gler', 2), ('tvöfalt gler', 'gluggar-og-gler', 2),

  -- flisar (tiles)
  ('flís', 'flisar', 3), ('flísar', 'flisar', 3), ('flísalögn', 'flisar', 3), ('flísalögð', 'flisar', 1),

  -- malning (paint)
  ('málning', 'malning', 3), ('lakk', 'malning', 2), ('grunnur', 'malning', 1), -- weak/ambiguous alone (also means "foundation"): needs a second hit to qualify
  ('málningarvinna', 'malning', 2), ('málað', 'malning', 1), ('lakkering', 'malning', 2),

  -- klaedning (cladding)
  ('klæðning', 'klaedning', 3), ('utanhússklæðning', 'klaedning', 3), ('veggklæðning', 'klaedning', 2),
  ('klæða', 'klaedning', 1), ('báruklæðning', 'klaedning', 1)
on conflict (keyword, category_slug) do update set weight = excluded.weight;
