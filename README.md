# RB-BOX

An "instruction brain" for the Icelandic AEC industry. A single searchable library of RB blöð, HMS leiðbeiningar, and community-contributed manuals — closed-loop, invite-only, admin-managed.

**Stack:** Next.js 14 (App Router) · TypeScript · Tailwind · Supabase (Postgres + Auth + Storage + Edge Functions) · Anthropic API for auto-categorization.

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Copy env template and fill in your keys
cp .env.example .env.local

# 3. Start Supabase locally (or link to a hosted project)
npx supabase start
# — OR —
npx supabase link --project-ref YOUR_REF

# 4. Push the schema
npx supabase db push
# (Local dev: `npx supabase db reset` re-applies migrations from scratch.)

# 5. Regenerate types from the live schema
npm run types:gen

# 6. Run the app
npm run dev
```

Open http://localhost:3000. You'll be redirected to `/login`. To sign in you first need to create a user — see the bootstrap section below.

---

## Bootstrapping the first admin

Since signup is disabled, you need one manual step to create the first admin (Sæunn). Do this once against your Supabase project:

```sql
-- In the Supabase SQL editor:
-- 1. Create the auth user (replace values):
select auth.admin.create_user(
  email    => 'saeunn@rbbox.local',
  password => 'CHANGE-THIS-STRONG-PASSWORD',
  email_confirm => true
);

-- 2. Grab the new user's UUID from the response, then insert profile:
insert into profiles (id, username, full_name, role, access_level, must_change_password)
values (
  'THE-UUID-FROM-STEP-1',
  'saeunn',
  'Sæunn',
  'admin',
  'paid',
  false
);
```

You can now sign in at `/login` with username `saeunn` + your chosen password. From `/admin/users` you can create every other account.

---

## Project shape

```
rb-box/
├── supabase/
│   ├── config.toml
│   └── migrations/
│       └── 20260101000000_initial_schema.sql   ← schema, RLS, seed data
├── src/
│   ├── app/
│   │   ├── layout.tsx              root shell + theme boot
│   │   ├── globals.css             theme variables
│   │   ├── page.tsx                Layout C — spotlight + browse panel
│   │   ├── login/
│   │   │   └── page.tsx            username + password login
│   │   ├── document/[id]/
│   │   │   └── page.tsx            document detail
│   │   ├── admin/                  gated: role='admin' only
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx            dashboard
│   │   │   ├── sources/page.tsx
│   │   │   ├── categories/page.tsx
│   │   │   ├── users/page.tsx      create + list users
│   │   │   └── upload/page.tsx     upload + AI auto-categorize
│   │   └── api/admin/
│   │       ├── create-user/route.ts    admin API — creates auth user + profile
│   │       └── categorize/route.ts     reads PDF, returns suggested categories
│   ├── components/
│   │   ├── Spotlight.tsx           ⌘K search bar + results
│   │   └── BrowsePanel.tsx         [ filters panel
│   ├── lib/
│   │   ├── i18n.ts                 IS/EN strings
│   │   ├── auth.ts                 username ↔ synthetic email
│   │   └── supabase/
│   │       ├── client.ts           browser client
│   │       ├── server.ts           RSC / route-handler client
│   │       └── admin.ts            service-role client (server-only)
│   └── types/
│       └── database.ts             regenerate with `npm run types:gen`
└── middleware.ts                   session refresh + auth + admin gating
```

---

## Design decisions locked in

| Decision              | Choice                                                            |
| --------------------- | ----------------------------------------------------------------- |
| Layout                | C — spotlight command-palette with toggleable browse panel        |
| Accent color          | Brick red `#A32D2D`                                               |
| Themes                | Light + dark, per-user preference stored in `profiles.theme`      |
| Default language      | Icelandic, with IS/EN toggle everywhere                           |
| Auth                  | Invite-only. Username + password. Synthetic emails under the hood |
| Admin gate            | `profiles.role = 'admin'` — enforced in middleware **and** RLS    |
| Search                | Postgres `tsvector` full-text + `pg_trgm` fuzzy + synonyms table  |
| Categories            | `ltree` hierarchical                                              |
| Access tiers          | `open` → `internal` → `restricted` → `paid` (paid unused for now) |
| Keyboard              | `⌘K` focus search · `[` toggle browse panel                       |
| AI categorization     | Optional — Anthropic API reads PDF, suggests categories + summary |

---

## Open questions parked in memory

Ping when you want to revisit any of these:

1. **Accent color** — brick red locked for now, but moss, olive, terracotta, or Icelandic blue are still options.
2. **HMS integration** — scrape / partnership / contributor-first. Nothing built yet; the `sources` table has HMS seeded.
3. **Pro/Paid tier day-one** — RLS already handles it; just needs a Stripe flow when the time comes.
4. **Contributor uploads** — currently admin-only. Review queue is scaffolded (`contributions` table + `status = 'pending_review'`) but not wired to a UI yet.

---

## What's not built yet (natural next steps)

- **HMS ingestion Edge Function** — a scheduled fetch of the HMS RB-blað listing that inserts new docs into `documents`. Wire under `supabase/functions/ingest-hms/`.
- **PDF text extraction** — right now `documents.extracted_text` is empty on upload. Add a `pdf-parse` step in `/api/admin/upload` (or a background Edge Function) so the full-text search actually indexes body text.
- **Category filter join** — see the TODO in `src/app/page.tsx`; needs a lookup via `document_categories`.
- **Bookmarks + search history** — tables exist, UI does not.
- **First-login "change password" screen** — profile flag `must_change_password` is set; nothing consumes it yet.
- **Public "Request access" contact form** — right now the link is a `mailto:`.

---

## Useful commands

```bash
# Reset local Supabase (wipes DB, re-runs migrations + seed)
npx supabase db reset

# Push migrations to hosted project
npx supabase db push

# Regenerate TypeScript types after schema changes
npm run types:gen

# Add a new migration
npx supabase migration new my_change
```
