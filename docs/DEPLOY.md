# Deployment & Demo Operations (Ops)

## Stack
Next.js 16 (App Router, Turbopack) + Prisma 6 + Neon Postgres. Deploy target: **Vercel + Neon**.

## Vercel setup
1. Import the repo into Vercel; framework auto-detects **Next.js**.
2. `vercel.json` overrides the build to `prisma generate && next build` so the
   Prisma client is always regenerated on deploy (no package.json change needed).
3. Environment variables (Project → Settings → Environment Variables):

   | Variable | Required | Notes |
   | --- | --- | --- |
   | `DATABASE_URL` | ✅ | Neon **pooled** URL (contains `-pooler`), `sslmode=require`. |
   | `MOCK_EXTERNAL_APIS` | recommended `true` | Email/Accelevents/Airtable run as logged mocks. |
   | `ALLOW_DEMO_RESET` | optional | `true` only if you want the reset endpoint live. Keep unset in prod. |
   | `APP_URL` | optional | Public URL for absolute links in emails/`.ics`. |
   | `RESEND_API_KEY` / `RESEND_FROM` | optional | Both are required for live email; use a verified Resend sender and keep mocks on otherwise. |
   | `ACCELEVENTS_BASE_URL` / `AIRTABLE_API_KEY` | optional | Enable the corresponding real integration when present. |
   | `ACCELEVENTS_API_KEY` | optional | Raw `Authorization` value for the configured Accelevents adapter. |
   | `AIRTABLE_BASE_ID` | optional | Required with `AIRTABLE_API_KEY` for the Airtable mirror. |
   | `GREENROOM_API_KEY` | optional | Enables the server-only, read-only `/api/v1/*` surface; leave unset to disable it (503). |
   | `SESSION_SECRET` | production required | Server-only random value (minimum 32 characters) used to sign and expire auth cookies. The app fails closed without it in production. |

4. First deploy checklist:
   - `/login` renders and the three persona buttons work.
   - After login, the shell (`/admin/*`, `/portal`) loads.
   - `/cfp/[formId]`, `/embed/schedule`, and `/embed/speakers` render without a session.

## Database
- Schema is applied with `prisma db push` (see architect). Do not run destructive
  migrations against the shared Neon DB without coordination.
- Env validation lives in `lib/env.ts` (`getServerEnv`, `useMockIntegrations`,
  `isDemoResetAllowed`, `getV1ApiKey`, `getResendFrom`).
- API-key REST setup, endpoint contracts, and curl examples are in
  [`docs/API.md`](API.md). Do not expose `GREENROOM_API_KEY` to browser code.

## Airtable one-way mirror

`POST /api/comms/airtable/mirror` is ADMIN-only and event-scoped. It returns a
credential-free preview by default (`{ eventId, dryRun: true }`) and never calls
Airtable unless all of the following are explicit: request `dryRun: false`,
`MOCK_EXTERNAL_APIS=false`, `AIRTABLE_API_KEY`, and `AIRTABLE_BASE_ID`.

Create these tables in the target base before enabling live sync. Every table
needs a writable, unique single-line-text **External ID** field; it is the
upsert merge key. Other fields may be single-line text unless noted.

| Table | Fields |
| --- | --- |
| `Sessions` | External ID, Event ID, Event, Title, Description, Format, Duration Minutes (number), Speaker IDs, Speaker Emails, Scheduled Start, Scheduled End, Room, Track |
| `Speakers` | External ID, Event ID, Event, Name, Email, Company, Job Title, Bio |
| `Schedule` | External ID, Event ID, Event, Session ID, Session Title, Starts At, Ends At, Room, Track |

The mirror uses `PATCH /v0/{base}/{table}` with Airtable `performUpsert` on
`External ID`, sends at most 10 records per request, and never deletes records.

### Partial-write recovery

A live run returns a per-table report instead of failing whole-hog:

```jsonc
{ "ok": true, "data": { "mode": "live", "counts": { "Sessions": 13, "Speakers": 10, "Schedule": 11 },
  "report": { "status": "partial", "attempted": 34, "upserted": 33, "failed": 1, "requests": 15,
    "tables": [{ "table": "Sessions", "attempted": 13, "upserted": 12, "failed": 1, "requests": 12,
      "failures": [{ "externalId": "session:abc", "status": 422, "message": "INVALID_VALUE_FOR_COLUMN: …" }],
      "failuresTruncated": false }] } } }
```

- A rejected batch is retried one record at a time, so one unmappable row cannot
  discard the nine valid rows sent with it; each skipped row is reported with its
  External ID and Airtable's own reason (at most 50 per table, then
  `failuresTruncated`).
- Retryable statuses (429/5xx/timeouts) get up to 3 bounded attempts. Credential
  or table faults (401/403/404) stop that table immediately rather than
  amplifying requests; the other tables still run.
- `status` is `complete` (HTTP 200), `partial` (HTTP 200, inspect `failures`), or
  `failed` (HTTP 502 `AIRTABLE_SYNC_FAILED` when nothing was written).
- **Resume = re-run the same request.** Upserts merge on `External ID`, so rows
  that already landed are rewritten identically and failed rows are retried, with
  no duplicates and no deletes.

## Accelevents one-way program push

`POST /api/integrations/accelevents/push` is ADMIN-only and event-scoped. It is
safe by default: `{ eventId, dryRun: true }` only returns projected counts. A
request can make one external POST only when `dryRun: false`,
`MOCK_EXTERNAL_APIS=false`, and `ACCELEVENTS_BASE_URL` is configured.

`ACCELEVENTS_BASE_URL` is intentionally the **full receiving endpoint URL**
(including its path), supplied by the operator for an integration adapter. The
direct Accelevents host-session API requires target event URL, ticket types,
accepted format values, and an existing remote record ID for updates—data that
Greenroom does not model—so this integration never appends or assumes a direct
vendor path. If the configured adapter requires Accelevents-style API-key
authentication, set optional `ACCELEVENTS_API_KEY`; its value is sent unchanged
in the `Authorization` header.

The POST body is a stable `schemaVersion: "1.0"`, `operation:
"program.push"` envelope: event (`event:<id>`), accepted/guaranteed sessions
(`session:<id>`), deduplicated speakers (`speaker:<id>`), and optional schedule
details (`slot:<id>`, start/end ISO timestamps, room, track). Stable IDs allow
the adapter to reconcile idempotently; this application performs no deletes and
has no schema-level delivery log.

## Demo seed
Idempotent, deterministic seed for the whole golden path.

```bash
npx tsx prisma/seed.ts
```

Rebuilds all demo-event data (wipes + recreates): 1 event, 4 categories,
3 tracks, 4 rooms, 2 forms, 40 abstracts across every status, an evaluation
plan with 3 evaluators + scores, 13 sessions (incl. a guaranteed keynote),
11 schedule slots **with one deliberate room conflict**, 5 onboarding tasks
(one carries a form), per-speaker task status, 4 email templates, 2 resources.
Persona users are upserted by email so fixed-persona access survives a reseed.
The speaker persona (`sofia@greenroom.demo`) owns a confirmed session and is at
3/5 tasks.

> Once the architect wires `package.json`, this is also runnable via
> `npm run db:seed` / `prisma db seed` (see coordination request).

## Demo reset
Two ways to rebuild demo data from a clean state:
- **Script:** `npx tsx prisma/seed.ts` (server-side, always available to operators).
- **Endpoint:** `POST /api/admin/reset` — guarded by INV-RESET-001:
  - environment-gated: refused unless `ALLOW_DEMO_RESET=true`;
  - authorized: requires an **ADMIN** session;
  - idempotent: reseeds deterministically;
  - returns the seed summary as `{ ok: true, data: {...} }`.

## Demo credentials
One-click personas on `/login`:
- **Admin** — Maya Chen (`maya@greenroom.demo`)
- **Evaluator** — Ravi Patel (`ravi@greenroom.demo`)
- **Speaker** — Sofia Marques (`sofia@greenroom.demo`)

Only these fixed seeded personas can sign in; public CFP submissions do not
create an authorized portal account.
