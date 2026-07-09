# RB-BOX Scraper

Periodic ingestion of Icelandic AEC guidance from trusted sources into the RB-BOX library.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  Vercel Cron (nightly 03:00 UTC) ──► GET /api/cron/scrape       │
│                                        │                        │
│  Admin: "Run now" ────► POST /api/admin/scrape/run ─────┐      │
│                                                          │      │
│  Admin: "Import URL" ─► POST /api/admin/scrape/import ──┤      │
│                                                          ▼      │
│                                        ┌─────────────────────┐  │
│                                        │  runScrape(source)  │  │
│                                        └─────────┬───────────┘  │
│                                                  │              │
│                    ┌─────────────────────────────┴──────────┐   │
│                    │                                        │   │
│              adapter.discover()             ┌───────────────▼─┐ │
│              (per-source spider)  ────────► │ processCandidate│ │
│                                             │  fetch          │ │
│                                             │  hash + dedup   │ │
│                                             │  analyzeDocument│ │
│                                             │  storage upload │ │
│                                             │  documents row  │ │
│                                             └─────────────────┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Env vars

Add to `.env.local` (and to your Vercel Project settings for prod):

```
# Required for the analyze pipeline (same key the categorize route uses)
ANTHROPIC_API_KEY=sk-ant-...

# Required for the cron endpoint auth. Vercel Cron sends this automatically
# once you set it in Project → Settings → Environment Variables.
CRON_SECRET=<generate a 32-byte random hex string>

# Optional overrides
SCRAPER_USER_AGENT="RB-BOX/1.0 (+https://your-domain/bot)"
SUPABASE_STORAGE_BUCKET=documents   # default
```

Generate a CRON_SECRET:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Migrations

Apply the scraper migration:

```bash
supabase db push
# or via the SQL Editor: paste supabase/migrations/20260709000000_scraper.sql
```

The migration is idempotent — safe to re-run. It:

- Adds columns to `sources`: `scrape_mode`, `scrape_config`, `scrape_interval_hours`, `last_scraped_at`, `auto_publish`
- Creates `scrape_runs` and `scrape_queue` with RLS (admin-only)
- Seeds 5 trusted sources: `hms`, `byggingarreglugerd`, `taktak`, `svanurinn`, `byggjum-graenni`
- Adds `sources_due_for_scrape()` RPC used by the cron

## Trust model

Each source has an `auto_publish` boolean:

- `true`  → scraped docs land as `status='published'` immediately (trusted sources)
- `false` → scraped docs land as `status='pending_review'` for Sveinn to approve

Toggle from the admin sources page: click the check-mark button on any source card.

The 5 seed sources are all trusted by default. New sources created via the admin UI default to `auto_publish=false` — nothing publishes without an explicit opt-in.

## Testing locally

1. Apply the migration (see above).
2. Run the app: `npm run dev`
3. As an admin, go to `/admin/sources` → pick a source → click **Keyra** (Run).
4. Watch the terminal for `[scraper:hms] …` log lines.
5. Refresh the sources page — the "Síðast" line will show the run summary.
6. Newly imported documents appear in the main search UI (if trusted) or in the review queue.

## Testing the cron endpoint

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/scrape
```

## Adding a new source

1. Insert a row in `sources` (via the admin UI or SQL):

   ```sql
   insert into sources (slug, name, base_url, scrape_mode, scrape_config, auto_publish, is_active)
   values (
     'my-new-source', 'My New Source', 'https://example.is',
     'crawler',
     '{"seed_urls":["https://example.is/guidelines"], "allow_hosts":["example.is"], "max_docs_per_run":50}',
     false, true
   );
   ```

2. Create an adapter at `src/lib/scrapers/adapters/my-new-source.ts` (copy `hms.ts` as a template).
3. Register it in `src/lib/scrapers/registry.ts`.
4. Deploy. Cron picks it up on its next tick, or run manually.

## Politeness

The scraper:

- Sends a `User-Agent: RB-BOX/1.0 (+…)` header
- Rate-limits to 1 req/sec per host
- Fetches and caches `/robots.txt`, skips disallowed paths
- Content-hashes every fetched doc — re-runs on unchanged content are no-ops
- Caps each run at `max_docs_per_run` (default 50) so a runaway crawl can't blow up costs
