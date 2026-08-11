# Greenroom Program Manager Architecture

## Product boundary

A fast program-management workspace for event admins, evaluators, and speakers. It covers CFP intake, abstract evaluation, confirmed sessions, speaker onboarding, agenda scheduling, public embeds, communications, and imports.

Explicit non-goals: CRM, marketing automation, payments, multi-language support, and AI evaluation workflows.

## Golden path

1. Admin publishes a configured CFP form.
2. Speaker saves and submits an `Abstract` with one or more speakers.
3. Admin assigns the abstract through an `EvaluationPlan`; evaluators score rubric criteria.
4. Admin accepts the abstract, atomically provisioning one confirmed, unscheduled `Session`
   plus each speaker's onboarding checklist (or starts with a seeded guaranteed session).
5. Speaker completes profile and onboarding tasks.
6. Admin schedules the session; room and speaker overlap checks must pass.
7. Public schedule embed exposes the session and an `.ics` download.

Off the main line: an accepted speaker can still edit their own submission (R1 — statuses
`DRAFT`/`SUBMITTED`/`UNDER_REVIEW`/`ACCEPTED`), and an admin can copy embed snippets from
`/admin/embeds` and watch onboarding progress on `/admin/speakers`.

## Stack

- Next.js 16 App Router, React 19, TypeScript strict mode
- PostgreSQL (Neon) via Prisma 6
- Zod contracts at `types/api.ts`
- Server components by default; client components only for interactive builders
- Auth boundary at `lib/auth.ts`: HMAC-signed, expiring `sb_session` cookie

## Domain model

All program data is event-scoped. `EventMember` assigns admin, evaluator, or speaker roles.

- `FormConfig` owns submission windows, limits, messaging, speaker constraints, and `FormField` definitions.
- `Abstract` is a proposal submitted through a form. It owns custom answers, speakers, assignments, and scores.
- `EvaluationPlan` owns a versioned rubric JSON and evaluator/team assignments.
- Accepting an `Abstract` produces exactly one `Session`; guaranteed/sponsor sessions have no source abstract.
- `Session` is the schedulable confirmed-talk record and has one optional `ScheduleSlot`.
- `ScheduleSlot` references a room and optional track. Services must detect room and speaker interval overlaps transactionally.
- `OnboardingTask` templates produce per-speaker `SpeakerTask` status/artifact records.
- Email, import, and resource records support the demo integration surfaces.

Status transitions for `Abstract`, `Session`/`ScheduleSlot`, and `SpeakerTask` — including
which route performs each one — are documented in [`LIFECYCLE.md`](LIFECYCLE.md).

Primary keys are CUID strings. Unique/index constraints are documented in `prisma/schema.prisma`.

## Locked routes and contracts

Shell routes (inside `app/(app)/`, behind the sidebar shell; sidebar entries are filtered by
role in `components/app-shell.tsx`, mirroring the server-side authorization each page enforces):

- `/admin/forms` and `/admin/forms/[formId]` — form list, create-form dialog, form builder
- `/admin/abstracts` — submission pipeline, custom answers, and accept/decline decisions
- `/admin/evaluations` — evaluator scoring workspace
- `/admin/agenda` — agenda builder: List / Day (rooms) / Week / Track grid /
  Tracks / Conflicts views. Drag-and-drop moves are offered in the **Day
  (rooms)** view only (`onMove` is passed for `view === "day"`); Week is a
  read-only multi-day overview, Track grid is one day laid out in track columns
  (its view id is still the legacy `"rooms"`), and Tracks is a read-only
  programme-wide grouping by track. Both track surfaces route through
  `lib/agenda-track-view.ts`, which is what keeps a slot with no track — or one
  whose track was deleted — rendered in a "No track" column or bucket rather
  than matching nothing and vanishing from the view.
- `/admin/speakers` — speaker onboarding status dashboard (read-only, filterable)
- `/admin/embeds` — copy-paste `<iframe>`/link snippets for the public embeds
- `/admin/settings` — event identity/dates/timezone, rooms, categories, and the
  create-event dialog
- `/admin/emails` — the email dispatch history panel (truthful delivery status)
- `/admin/operations` — reminders, CSV import, decision emails, external sync
- `/portal`, `/portal/resources/[slug]`, and `/portal/tasks/[taskId]` — speaker
  workspace, resources, and task forms

Public routes (no shell, must render with a null session): `/` (landing),
`/cfp/[eventSlug]/[formSlug]` (canonical; the legacy one-segment `/cfp/[formId]`
resolves exact published IDs and unambiguous slugs only), `/embed/schedule`,
`/embed/speakers`, the canonical public programme pages `/schedule` and
`/speakers` (server-rendered from the same agenda read as the embeds),
`/reviewer-invite`, `/login`, and the alias redirects `/agenda` and `/sessions`
(both into `/schedule`).

Backend ownership routes:

- `/api/cfp/*`: form config, public form, draft/submit abstract
- `/api/cfp/submissions/mine` and `/api/cfp/submissions/[abstractId]`: R1 — a signed-in
  speaker lists and edits their own submissions after submission/acceptance
- `/api/evaluations/*`: plans, assignments, scores, decisions with automatic provisioning,
  and legacy abstract-to-session backfill
- `/api/agenda/*`: sessions, slots, conflict checks
- `/api/integrations/*`: Accelevents webhook and CSV/JSON import
- `/api/v1/*`: read-only, API-key-gated server-to-server surface (see [`API.md`](API.md))

Ops ownership routes:

- `/api/portal/*`: profile and task updates
- `/api/comms/*`: audited submission/decision/reminder email dispatch, calendar downloads,
  Airtable one-way mirror
- `/api/admin/reset`: environment-gated demo reset (refused in production)

Request schemas and API envelope types are locked in `types/api.ts`. Workers must request shared changes through coordination rather than redefining contracts.

## Security and performance

- Sessions are HMAC-signed and expiring (`lib/auth.ts`, `SESSION_SECRET`, 7-day TTL). In
  production a missing or short secret fails closed — every cookie decode is rejected.
- The cookie identifies an email and active event; it **never** carries authority. Roles are
  resolved from the persisted `EventMember` row on each request (`lib/api/context.ts`,
  `getResolvedSession`), so a forged role claim buys nothing.
- Every API verifies event membership and role server-side (INV-EVENT-001).
- Public form reads are scoped to a published form and its event. Anonymous CFP draft and submit
  writes both require that form to be open, use a 128 KiB bounded body plus strict bounded
  answers/roster, reject duplicate normalized speaker emails, and pass durable rate limits.
- Resource HTML must be sanitized before persistence or rendering.
- Uploads use validated server-side storage adapters; URLs are not trusted as authorization.
  Concretely, the adapter is the database: `POST /api/files?kind=headshot|slide-deck` takes a raw
  authenticated body, refuses an oversize stream mid-read (`413 REQUEST_TOO_LARGE`, 1 MiB for a
  headshot, 5 MiB for a deck), sniffs the magic bytes and refuses anything whose real format is
  not accepted for that kind or does not match the claimed content type (`422`), then stores the
  bytes in `StoredFile` keyed by `(uploader, kind, fingerprint)` so a same-scope re-upload
  returns the id that already exists. A public headshot's fingerprint is its raw content SHA;
  a private slide deck uses a versioned, event-scoped SHA over the event id and raw content
  digest, so identical bytes uploaded under another event cannot inherit the first event's
  organizer access. Same-event legacy raw-digest deck rows remain reusable. The **stored,
  server-derived** mime — never the client's header — is what
  `GET /api/files/:id` sets as `Content-Type`, which is what makes the deployment-wide `nosniff`
  binding. Reads mirror the exposure each column already had: a `HEADSHOT` is public because it
  renders on the anonymous speaker gallery and the speakers embed (`public, max-age=31536000,
  immutable`), a `SLIDE_DECK` is the uploader's or that event's ADMIN's only (`private, no-store`,
  served as an attachment), and a file that does not exist is the same 404 as one the caller may
  not read. The matrix, caps and sniffer are one pure module (`lib/uploads/stored-file.ts`); the
  per-user throttle reuses the S19 durable bucket table rather than counting the product table,
  which dedupe would undercount. Bytes in Postgres was chosen over a blob service deliberately: a
  headshot is small and rarely read, and the alternative was a new external credential.
- Schedule conflict checks and writes happen in one transaction (INV-SCHEDULE-001).
- Every writer that check-then-writes one abstract (speaker edit/withdrawal, review assignment
  or score, admin decision, legacy conversion)
  first takes a per-abstract transaction-scoped advisory lock (`lib/services/abstract-lock.ts`,
  INV-ABSTRACT-001) and re-reads the row inside the transaction, closing the TOCTOU window.
- The one global `SpeakerProfile` row per person has two request-path writers — the organizer's
  roster editor and the speaker's own portal — and both take the same per-user advisory lock
  (`speakerProfileLockKey`, `lib/services/speaker-roster.ts`) before writing. The roster dialog
  additionally sends only the fields the operator actually changed, so an organizer saving a
  status cannot write back a stale snapshot over a bio the speaker just edited (GRA-05).
- The passwordless one-click `/login` personas are gated fail-closed in production: they require
  `DEMO_PERSONA_LOGIN_ENABLED=true` exactly, and the refusal lives in the server action
  (`app/login/actions.ts`), not merely in whether the buttons render. Outside production they are
  unconditionally on, so development, tests and the smoke harnesses need no configuration
  (GRA2-01, `arePersonaLoginsEnabled` in `lib/env.ts`).
- Baseline security headers are set route-aware in `next.config.mjs`: `nosniff`, a
  strict-origin-when-cross-origin referrer policy, an empty camera/microphone/geolocation
  permissions policy, and a one-year HSTS everywhere; plus `Content-Security-Policy:
  frame-ancestors 'none'` on everything EXCEPT `/embed/*`, which must stay frameable because
  embedding it in someone else's page is the feature. Deliberately not a full CSP — `script-src`
  needs a measured nonce migration and is a named follow-up (GRA2-08).
- The v1 API authenticates before any database work and compares fixed-size key hashes.
- Keep interactive client islands narrow and avoid serial data waterfalls.

## Environment and deployment status

The app is deployed and live on **Vercel + Neon Postgres**; pushes to `main` auto-deploy.
The schema is applied with `prisma db push` against the Neon database and the deterministic
demo seed (`lib/demo/seed.ts`) has been run against it.

- Local setup needs `DATABASE_URL` only; everything else defaults safely (external
  integrations mocked, demo reset disabled, v1 API disabled). See the README Quickstart and
  [`DEPLOY.md`](DEPLOY.md) for the full variable table.
- `SESSION_SECRET` is required in production (see Security above) and is configured
  separately for Preview and Production.
- `GREENROOM_API_KEY` is configured, so `/api/v1/*` is live; unset it and those routes return
  `503 API_KEY_NOT_CONFIGURED`.
- `ALLOW_DEMO_RESET` is unset in production, so `/api/admin/reset` refuses every
  caller (INV-RESET-001). The refusal body depends on who asks, by design (S-18):
  anyone who has not proved they are an admin gets `403 FORBIDDEN` — the same
  body a deployment with the flag *set* returns them, so the refusal cannot be
  used to read the flag. An authenticated admin gets `403 RESET_DISABLED`, which
  names the variable to set.
- Airtable mirror credentials (`AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID`,
  `MOCK_EXTERNAL_APIS=false`) are configured in production and a live one-way mirror run has
  completed.
- **Vercel bakes environment variables at deploy time**: after editing any variable you must
  redeploy before it takes effect.
