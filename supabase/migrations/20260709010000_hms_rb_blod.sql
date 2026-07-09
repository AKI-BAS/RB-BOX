-- ═══════════════════════════════════════════════════════════════════════
-- Seed: HMS · Rb-leiðbeiningablöð (Prismic-backed source)
-- ═══════════════════════════════════════════════════════════════════════
--
-- This registers a new trusted source that pulls RB blöð directly from
-- HMS's Prismic CMS API — bypassing the JS-rendered public front end that
-- our HTML crawler can't see through.
--
-- Adapter: src/lib/scrapers/adapters/hms-rb-blod.ts
--
-- scrape_config keys used by the adapter:
--   prismic_repo  — Prismic repository name (default 'hms-web')
--   tag           — Prismic tag to filter by (default 'Rb-blöð')
--   lang          — Prismic language filter, or '*' for all (default '*')
--   page_size     — Results per page, max 100 (default 100)
-- Any of these can be omitted to use defaults.

insert into public.sources
  (slug, name, name_en, description, base_url, is_active,
   scrape_mode, scrape_config, scrape_interval_hours, auto_publish, trust_level)
values
  ('hms-rb-blod',
   'HMS · Rb-leiðbeiningablöð',
   'HMS · Rb Guidance Sheets',
   'Útgáfusafn Rb-leiðbeiningablaða frá Húsnæðis- og mannvirkjastofnun (sótt beint úr Prismic API)',
   'https://hms.is/fraedsla/mannvirkjamal---fraedsla/rb-blod/utgafusafn-rb',
   true, 'crawler',
   jsonb_build_object(
     'prismic_repo', 'hms-web',
     'tag',          'Rb-blöð',
     'lang',         '*',
     'page_size',    100,
     'max_docs_per_run', 200
   ),
   168, true, 5)

on conflict (slug) do update set
  scrape_mode = excluded.scrape_mode,
  scrape_config = excluded.scrape_config,
  scrape_interval_hours = excluded.scrape_interval_hours,
  auto_publish = excluded.auto_publish,
  is_active = excluded.is_active,
  description = coalesce(public.sources.description, excluded.description),
  base_url = coalesce(public.sources.base_url, excluded.base_url);
