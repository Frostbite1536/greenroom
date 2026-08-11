# Deployment & Demo Operations (Ops)

## Stack
Next.js 16 (App Router, Turbopack) + Prisma 6 + Neon Postgres. Deploy target: **Vercel + Neon**.
Requires **Node.js 20.9+**.

## From-scratch install
The clean-database install path (clone → `npm install` → `db:push` → `db:seed` →
running app, ~4 minutes) is rehearsed and timed in
[`judging/INSTALL-REHEARSAL.md`](judging/INSTALL-REHEARSAL.md), including the
golden-path verification harness `scripts/install-rehearsal.mjs`.

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
   | `DEMO_PERSONA_LOGIN_ENABLED` | **production required for the demo** | Must be exactly `true` for the one-click `/login` personas to work in production (GRA2-01). Anything else — unset, `false`, `TRUE`, `1` — refuses them and hides the buttons; the email/password form still works. Not consulted outside production, so local dev, tests and the smoke harnesses need nothing. |
   | `APP_URL` | optional | Public URL for absolute links in emails/`.ics`; production should use the canonical `https://greenroom-hq.com`. |
   | `RESEND_API_KEY` / `RESEND_FROM` | optional | Both are required for live email; use a sender verified for the deployment's domain and keep mocks on otherwise. Submission, decision, and reminder mail share the same audited delivery path—see "Email status" below. |
   | `ACCELEVENTS_BASE_URL` / `AIRTABLE_API_KEY` | optional | Enable the corresponding real integration when present. |
   | `ACCELEVENTS_API_KEY` | optional | Raw `Authorization` value for the configured Accelevents adapter. |
   | `AIRTABLE_BASE_ID` | optional | Required with `AIRTABLE_API_KEY` for the Airtable mirror. |
   | `GREENROOM_API_KEY` | optional | Enables the server-only, read-only `/api/v1/*` surface; leave unset to disable it (503). |
   | `SESSION_SECRET` | production required | Server-only random value (minimum 32 characters) used to sign and expire auth cookies. The app fails closed without it in production. |

4. First deploy checklist:
   - `/login` renders and the three persona buttons work. If the buttons are
     missing, `DEMO_PERSONA_LOGIN_ENABLED` is not exactly `true` in this
     environment — set it and redeploy.
   - After login, the shell (`/admin/*`, `/portal`) loads.
   - `/cfp/[formId]`, `/embed/schedule`, and `/embed/speakers` render without a session.

## Database
- Schema is applied with `prisma db push` (see architect). Do not run destructive
  migrations against the shared Neon DB without coordination.
- Env validation lives in `lib/env.ts` (`getServerEnv`, `useMockIntegrations`,
  `isDemoResetAllowed`, `getV1ApiKey`, `getResendFrom`).
- API-key REST setup, endpoint contracts, and curl examples are in
  [`docs/API.md`](API.md). Do not expose `GREENROOM_API_KEY` to browser code.

## Operator console

`/admin/operations` (ADMIN only) is the operator surface for everything below:
speaker reminders, mapped CSV import, and the Airtable/Accelevents one-way
pushes. It adds no privileges — every button is a POST the API already
authorizes — and it tells the operator **before** they press it whether the
deployment will really reach the third party, derived from the same rules as
`resolveAirtableMirrorMode` / `resolveAcceleventsPushMode`. Credentials are
never sent to the browser; the page passes booleans only.

Both integration runs default to the APIs' own `dryRun: true` — "Check first" is
the primary action and the live run is a separate button, disabled with the
reason shown when the deployment cannot write externally.

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

## Email status

Every Greenroom email passes through `lib/comms/send.ts`. It creates an `EmailDispatch` row
before delivery, uses a stable idempotency key for that dispatch, and records `sent`, `mocked`,
or `failed` afterwards. A provider failure is evidence in the database rather than an erased
proposal or an untracked fire-and-forget promise.

Real Resend POSTs are possible only when `MOCK_EXTERNAL_APIS=false`, `RESEND_API_KEY`, and a
valid `RESEND_FROM` are all present. Otherwise delivery is mocked and recorded without making
a provider request. Unit tests that exercise the live branch inject a fake fetcher; ordinary
tests and smokes never contact Resend.

Current mail-producing paths are:

- public proposal submit: when the event has an email template, after the database transaction
  commits one receipt goes to the persisted primary submitter. Co-speakers and event admins do
  not receive submission fan-out. Notification failure is deliberately non-throwing, so a saved
  proposal stays saved;
- `POST /api/comms/decision`: ADMIN-only, decided proposals only. Preview is the default and a
  short-lived signed token binds the subsequent send to the exact recipients/content. Optional
  feedback includes written reviewer comments only—never scores or reviewer identities;
- `POST /api/comms/reminders`: renders the event's reminder template for speakers with open
  onboarding work.

The production Resend key/domain readiness is operator-reported. Confirm only redacted
presence and the canonical sender/`APP_URL` during the announced integration window; never
copy secret values into a command transcript, chat, or Markdown.

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
npm run db:seed          # = tsx prisma/seed.ts
```

Rebuilds all demo-event data (wipes + recreates): 1 event, 4 categories,
3 tracks, 4 rooms, **4 forms** (the public CFP plus three used inside tasks),
40 abstracts across every status, an evaluation plan with 3 evaluators +
scores, 13 sessions (incl. a guaranteed keynote), 11 conflict-free schedule
slots across all three event days, **6 onboarding tasks (three carry a form:
hotel stay, flight reimbursement, A/V logistics)**, per-speaker task status,
5 email templates, 2 resources. Persona users are upserted by email so
fixed-persona access survives a reseed; a database seeded before the Cycle 5
move to `@greenroom-hq.com` has its three persona rows renamed in place first,
so they keep their ids, speaker profiles and passwords rather than being
replaced by duplicates. The speaker persona
(`sofia@greenroom-hq.com`) owns a confirmed session and is at **3/6 tasks** — with
one completed task form to review and the flight reimbursement still
outstanding, so both task-form states are demonstrable.

The task forms are `published: false`, so they never appear on public `/cfp`
routes while remaining fully usable inside a task.

Task deadlines are staggered from April 17 through May 11 in the event's Los
Angeles timezone, ahead of the May 12 opening day. The hotel and flight
follow-ups become required only when the speaker asks for that support.

## Demo reset
Two ways to rebuild demo data from a clean state:
- **Script:** `npm run db:seed` (server-side, always available to operators).
- **Endpoint:** `POST /api/admin/reset` — guarded by INV-RESET-001:
  - environment-gated: refused unless `ALLOW_DEMO_RESET=true`;
  - authorized: requires an **ADMIN** session;
  - idempotent: reseeds deterministically;
  - returns the seed summary as `{ ok: true, data: {...} }`.

## Demo credentials
One-click personas on `/login`:
- **Admin** — Maya Chen (`maya@greenroom-hq.com`)
- **Evaluator** — Ravi Patel (`ravi@greenroom-hq.com`)
- **Speaker** — Sofia Marques (`sofia@greenroom-hq.com`)

These buttons are passwordless by design and are therefore gated in production
(GRA2-01): they work only where `DEMO_PERSONA_LOGIN_ENABLED=true`, and the
server action refuses the POST — not merely the button — anywhere else, sending
the visitor to `/login?error=personas-disabled`. Development, test and the smoke
harnesses are unaffected and need no flag.

`/login` offers these three one-click persona buttons alongside an
email/password form (the seeded personas and harness fixtures have credentials;
there is deliberately no self-service registration — new accounts are on the
post-hackathon roadmap). Either path yields the same kind of session, and a
session grants no authority by itself: the role is resolved from the
`EventMember` row for the signed-in email on every request. Shell users created
by a public CFP submission (co-speakers keyed by email) have no membership and
therefore no portal access. See [`LIFECYCLE.md`](LIFECYCLE.md) for what each
record can do once signed in.
