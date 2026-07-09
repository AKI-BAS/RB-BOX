# HMS Rb-leiðbeiningablöð adapter

## The problem this solves

hms.is is a Next.js + Prismic-CMS site. Every listing page — including the RB blöð archive at `/fraedsla/mannvirkjamal---fraedsla/rb-blod/utgafusafn-rb` — is fully JavaScript-rendered. HTML crawlers see an empty shell. On top of that, HMS aggressively rate-limits the public web front end (429 responses at 1 req/sec).

The solution: skip the front-end entirely and go straight to Prismic's public REST API. Prismic allows 200 req/sec, returns clean JSON with direct PDF URLs, publication dates, and category tags.

## What's in this bundle

Three files:

| File | Purpose |
|---|---|
| `src/lib/scrapers/adapters/hms-rb-blod.ts` | **NEW** — Prismic-driven adapter for RB blöð |
| `src/lib/scrapers/registry.ts` | Registers the new adapter alongside the existing five |
| `supabase/migrations/20260709010000_hms_rb_blod.sql` | Seeds a new `hms-rb-blod` source |

## Install

1. Extract on top of your project — it overwrites `registry.ts` (adds one import + one line) and adds two new files.
2. Apply the migration:
   ```bash
   supabase db push
   ```
   or paste it into the SQL Editor. Idempotent — safe to re-run.
3. Restart `npm run dev`.
4. In `/admin/sources`, you should now see **HMS · Rb-leiðbeiningablöð** as a new source. Click **Keyra**.

Expected first run: pulls up to 200 documents in one pass (adjust `max_docs_per_run` in `scrape_config` if you want more). Runs fast because Prismic doesn't need us to throttle.

## What it actually does

1. Fetches `https://hms-web.cdn.prismic.io/api/v2` to get the current master ref
2. Queries `/documents/search?q=[[at(document.tags,["Rb-blöð"])]]&pageSize=100` paginated
3. For each document, walks the JSON tree looking for a Media field pointing at a PDF (that's the actual RB blað file)
4. Yields it as a Candidate with the doc's `uid` as `externalId`, `first_publication_date` as the publish date, and `rb_blad` as the document_type
5. Runner takes it from there — downloads the PDF, hashes for dedup, sends to Claude for analysis, uploads to Storage, inserts a `documents` row

## What you can tweak

Everything's in the `scrape_config` jsonb on the source row. Change via SQL or the admin UI:

```json
{
  "prismic_repo": "hms-web",
  "tag": "Rb-blöð",
  "lang": "*",
  "page_size": 100,
  "max_docs_per_run": 200
}
```

- `tag` — if HMS ever renames the tag (e.g. "Rb-blod" without diacritics), change this
- `lang` — set to `is` to force Icelandic only; default `*` returns all languages
- `max_docs_per_run` — raise if you want to import the whole archive in one go

## Sanity check without running the whole pipeline

You can hit the Prismic API in PowerShell to see exactly what the adapter will see:

```powershell
$meta = Invoke-RestMethod -Uri "https://hms-web.cdn.prismic.io/api/v2"
$ref = ($meta.refs | Where-Object { $_.isMasterRef }).ref
$query = "[[at(document.tags,[""Rb-blöð""])]]"
$encoded = [uri]::EscapeDataString($query)
$url = "https://hms-web.cdn.prismic.io/api/v2/documents/search?ref=$ref&q=$encoded&pageSize=5"
Invoke-RestMethod -Uri $url | Select-Object total_results_size, total_pages
```

If `total_results_size` is a positive number (say 40, 80, 200), the adapter will find that many RB blöð. If it's 0, the tag name is different than "Rb-blöð" — try alternates like "Rb-blad" or check the Prismic API meta's `tags` array for the actual tag list.

## Note on the existing HMS source

I left the original `hms` source in place — it still handles the fire-safety and accessibility pages via HTML crawl (which does work for those, since those pages have static links). If you want to silence it while you focus on RB blöð, just toggle `is_active=false` on the `hms` source from the admin UI. It'll stop scraping without being deleted.
