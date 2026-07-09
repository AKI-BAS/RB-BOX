-- ═══════════════════════════════════════════════════════════════════════
-- Fix: hms-rb-blod source was seeded with the wrong Prismic tag
-- ═══════════════════════════════════════════════════════════════════════
--
-- The original migration (20260709010000_hms_rb_blod.sql) seeded
-- scrape_config.tag = 'Rb-blöð'. Verified live against the hms-web Prismic
-- repo on 2026-07-09: that string matches only 3 unrelated narrative
-- articles (custom type "monthly_report") that happen to carry a stray
-- legacy tag of that spelling.
--
-- The real archive — 381 documents of custom type "document", each with a
-- title/version/date/file(PDF) — is tagged exactly "RB Blöð" (space,
-- title case). Since scrape_config in the DB overrides the adapter's code
-- default, the seeded value must be corrected here too.

update public.sources
set scrape_config = scrape_config || jsonb_build_object('tag', 'RB Blöð')
where slug = 'hms-rb-blod';
