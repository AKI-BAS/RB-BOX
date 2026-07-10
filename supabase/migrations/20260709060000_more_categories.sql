-- ═══════════════════════════════════════════════════════════════════════
-- Three more categories: málmar, hleðslusteinar, jarðefni-og-fylliefni
-- ═══════════════════════════════════════════════════════════════════════
--
-- Continues the taxonomy-gap fixes from 20260709050000_new_categories.sql.
-- jarðefni-og-fylliefni is ONE combined category (per request) — both the
-- "Jarðefni" (earth materials) and "Fylliefni" (fillers/aggregates) Prismic
-- tags map to it.
--
-- Mirrors REST inserts already applied via the service-role client.

insert into public.categories (slug, path, name, name_en, sort_order) values
  ('malmar',                 'malmar',                 'Málmar',                 'Metals',                 16),
  ('hledslusteinar',         'hledslusteinar',         'Hleðslusteinar',         'Masonry blocks',         17),
  ('jardefni-og-fylliefni',  'jardefni-og-fylliefni',  'Jarðefni og fylliefni',  'Earth materials & fillers', 18)
on conflict (slug) do nothing;

insert into public.category_tag_rules (source_tag, category_slug, priority) values
  ('Málmar',          'malmar',                10),
  ('Hleðslusteinar',  'hledslusteinar',         10),
  ('Jarðefni',        'jardefni-og-fylliefni',  10),
  ('Fylliefni',       'jardefni-og-fylliefni',  10)
on conflict (source_tag, category_slug) do update set priority = excluded.priority;

insert into public.category_keywords (keyword, category_slug, weight) values
  -- malmar (metals)
  ('málmur', 'malmar', 3), ('málmar', 'malmar', 3), ('stál', 'malmar', 3),
  ('ál', 'malmar', 1), -- weak/ambiguous alone (substring of "álag" = load/stress): needs a second hit to qualify
  ('járn', 'malmar', 2), ('ryðfrítt stál', 'malmar', 3), ('zink', 'malmar', 3),
  ('kopar', 'malmar', 3), ('stálgrind', 'malmar', 1),

  -- hledslusteinar (masonry blocks)
  ('hleðslusteinn', 'hledslusteinar', 3), ('hleðslusteinar', 'hledslusteinar', 3),
  ('vikurplötur', 'hledslusteinar', 2), ('steinhleðsla', 'hledslusteinar', 2),
  ('múrsteinn', 'hledslusteinar', 2), ('léttsteinn', 'hledslusteinar', 2),
  ('hleðsla', 'hledslusteinar', 1), -- weak/generic ("laying/stacking" broadly)

  -- jardefni-og-fylliefni (earth materials & fillers)
  ('jarðefni', 'jardefni-og-fylliefni', 3), ('fylliefni', 'jardefni-og-fylliefni', 3),
  ('möl', 'jardefni-og-fylliefni', 2), ('sandur', 'jardefni-og-fylliefni', 2),
  ('malarefni', 'jardefni-og-fylliefni', 2), ('fyllingarefni', 'jardefni-og-fylliefni', 2),
  ('uppfylling', 'jardefni-og-fylliefni', 2), ('jarðvegur', 'jardefni-og-fylliefni', 1),
  ('burðarlag', 'jardefni-og-fylliefni', 1)
on conflict (keyword, category_slug) do update set weight = excluded.weight;
