-- ═══════════════════════════════════════════════════════════════════════
-- Three more categories: áhrif vatns og vinda, innréttingar, byggingarhlutar
-- ═══════════════════════════════════════════════════════════════════════
--
-- Fourth taxonomy-gap batch. "Byggingarhlutar" (generic "building parts") is
-- intentionally broad — keyword coverage is thin for it since there's no
-- specific vocabulary to key off; it relies mostly on the direct tag rule.
--
-- Mirrors REST inserts already applied via the service-role client.

insert into public.categories (slug, path, name, name_en, sort_order) values
  ('ahrif-vatns-og-vinda', 'ahrif-vatns-og-vinda', 'Áhrif vatns og vinda', 'Water & wind effects', 19),
  ('innrettingar',         'innrettingar',         'Innréttingar',         'Interior fittings',    20),
  ('byggingarhlutar',      'byggingarhlutar',      'Byggingarhlutar',      'Building parts',       21)
on conflict (slug) do nothing;

insert into public.category_tag_rules (source_tag, category_slug, priority) values
  ('Áhrif vatns og vinda', 'ahrif-vatns-og-vinda', 10),
  ('Innréttingar',         'innrettingar',         10),
  ('Byggingarhlutar',      'byggingarhlutar',      10)
on conflict (source_tag, category_slug) do update set priority = excluded.priority;

insert into public.category_keywords (keyword, category_slug, weight) values
  -- ahrif-vatns-og-vinda (water & wind effects / building physics)
  ('vindálag', 'ahrif-vatns-og-vinda', 3), ('raki', 'ahrif-vatns-og-vinda', 1), -- weak/generic alone
  ('rakaskemmdir', 'ahrif-vatns-og-vinda', 2), ('rakavarnarlag', 'ahrif-vatns-og-vinda', 2),
  ('veðrun', 'ahrif-vatns-og-vinda', 2), ('úrkoma', 'ahrif-vatns-og-vinda', 2),
  ('vatnsvarnir', 'ahrif-vatns-og-vinda', 2), ('vindþéttleiki', 'ahrif-vatns-og-vinda', 2),
  ('vatnsþéttleiki', 'ahrif-vatns-og-vinda', 2), ('regnvarnir', 'ahrif-vatns-og-vinda', 2),

  -- innrettingar (interior fittings)
  ('innrétting', 'innrettingar', 3), ('innréttingar', 'innrettingar', 3),
  ('eldhúsinnrétting', 'innrettingar', 2), ('borðplata', 'innrettingar', 2),
  ('fataskápur', 'innrettingar', 1), ('skápur', 'innrettingar', 1), -- weak/generic ("cabinet" broadly)

  -- byggingarhlutar (generic building parts — thin keyword coverage by design)
  ('byggingarhluti', 'byggingarhlutar', 2), ('byggingarhluta', 'byggingarhlutar', 2),
  ('mannvirkjahluti', 'byggingarhlutar', 1), ('verksmiðjueining', 'byggingarhlutar', 1)
on conflict (keyword, category_slug) do update set weight = excluded.weight;
