# Greenroom — from a pile of proposals to defensible program decisions

### ▶ Try it live: <https://greenroom-hq.com> — one click signs you in as the event admin. No signup, no password.

Program committees drown after the CFP deadline closes. Greenroom is the
review-and-decide workspace for that moment: route every proposal to a reviewer
team by its category, score it against a weighted rubric, and accept it — where
"accept" is a single transaction that creates the talk's one session, assigns
every speaker's onboarding tasks, and leaves it unscheduled. Scheduling is then
its own guarded step: the server re-checks room and speaker overlap inside the
write and refuses a placement that double-books, unless an admin deliberately
overrides it.

For conference and meetup organizers who run a program committee. Closed
CFP/speaker-ops SaaS optimizes the intake form; Greenroom optimizes what happens
after the deadline closes.

Open source (AGPL-3.0), self-hostable, one required environment variable to run
it locally (`DATABASE_URL`); a production deployment adds one more
(`SESSION_SECRET`).

- **Watch it decide (60s):** [`/login`](https://greenroom-hq.com/login) → **Event admin** → **Abstracts** → pick a row → **Accept** → **Agenda** → drag a talk onto an occupied room slot and watch the server refuse the move.
- **See the published output:** [schedule](https://greenroom-hq.com/schedule) · [speakers](https://greenroom-hq.com/speakers) · [read-only API](https://greenroom-hq.com/docs/api)
- **Evaluating this project?** Start at the [evaluation index](docs/judging/README.md).
- **Run it locally:** [Quickstart](#quickstart) — five commands, one variable.

## What it does, in decision order

1. **Routed evaluation** — review teams score abstracts against a weighted
   rubric inside an evaluation round (plan). Assignments are routed to a
   reviewer team by the proposal's category, and reviewer eligibility is
   re-checked server-side under a lock. A round can be marked blind; assigned
   evaluators then lose speaker profiles, while the UI warns that proposal text
   can still identify its author.
2. **Accept → Session** — accepting an abstract atomically provisions its one
   confirmed, unscheduled session and every onboarding-task assignment for its
   speakers, co-speakers included. Re-accepting tops up what is missing instead
   of duplicating. The legacy conversion endpoint safely backfills older
   records.
3. **Agenda builder** — List / Day (rooms) / Week / Track grid / Tracks /
   Conflicts views, with drag-and-drop moves in the day grid. Room-overlap and
   speaker double-booking detection runs inside the same transaction as the
   write, under an event-wide lock, and a refused move snaps back. The drag path
   has no override; the schedule dialog offers an explicit "Schedule anyway" to
   an admin who means it.
4. **Speaker onboarding** — a speaker portal with profile, status, and task
   checklists (tasks can carry forms), plus an admin dashboard at
   `/admin/speakers` showing who is behind.
5. **Speaker edits after acceptance** — speakers keep editing their own proposal
   while it is in draft, in review, or accepted; rejected and withdrawn
   proposals are read-only, and a confirmed talk's speaker list is fixed.
6. **CFP forms** — build a submission form (custom fields, conditional logic,
   submission limits, welcome/thank-you pages) and publish it at a public,
   event-scoped URL (`/cfp/{event}/{form}`). An unpublished form has no public
   page at all.
7. **Abstract intake** — speakers submit proposals with co-speakers (upserted by
   email); drafts and validation included.
8. **Public embeds** — a mobile-friendly schedule (day tabs, search, track
   filters, session details) and speaker gallery, published at `/schedule` and
   `/speakers` and embeddable chrome-free at `/embed/*`, with `.ics` calendar
   export and copy-paste snippets at `/admin/embeds`.
9. **Human-controlled authoring assistance** — administrators can start a
   speaker resource from deterministic templates, inspect a sanitized preview,
   and optionally ask the configured AI provider to turn bounded notes into a
   reviewable HTML suggestion. The same shared assistant can draft a short,
   plain-text decision note from explicitly selected review feedback. Neither
   action saves, publishes, sends mail, or changes a decision automatically.

## Deployed demo

**Canonical production URL:** <https://greenroom-hq.com>

The demo runs on Vercel + Neon; pushes to `main` auto-deploy.

### Production golden-path walkthrough

The public CFP uses the stable seeded slugs
[`/cfp/forward-2026/call-for-speakers`](https://greenroom-hq.com/cfp/forward-2026/call-for-speakers)
(the older one-segment `/cfp/call-for-speakers` still resolves and redirects
there). Use a distinctive, throwaway talk title so it is easy to find in the
admin pipeline.

1. Open the public CFP, complete its required fields, and submit it while
   logged out.
2. Go to [`/login`](https://greenroom-hq.com/login) and choose
   the **Event admin** persona. Open **Abstracts**, select the submitted row,
   then choose **Accept**. Acceptance creates the confirmed session and its
   speaker onboarding checklists; it does not schedule the talk.
3. Open **Agenda**. In the **Unscheduled backlog**, select the new session,
   choose an available date, time, room, and optional track, then choose
   **Schedule**. The server prevents room and speaker overlaps.
   - Switch to the **Day** tab and drag a session block to another room or time
     — the move is re-checked on the server and refused if it collides.
   - Switch to the **Week** tab for a read-only overview of the whole event.
4. Open **Speaker onboarding** (`/admin/speakers`) to see profile completeness,
   settled tasks, and unscheduled sessions per speaker, and **Website embeds**
   (`/admin/embeds`) to copy the `<iframe>` snippets for your event site.
5. Sign in as the **Speaker** persona (Sofia) and open the speaker portal. Her
   accepted proposal is still editable — content changes are saved against the
   original form; the speaker list of a confirmed talk is locked.
6. Verify the result while logged out at
   [`/embed/schedule`](https://greenroom-hq.com/embed/schedule).
   The demo event can also be selected explicitly with
   [`?event=forward-2026`](https://greenroom-hq.com/embed/schedule?event=forward-2026).
   The scheduled speaker lineup is available at
   [`/embed/speakers`](https://greenroom-hq.com/embed/speakers?event=forward-2026).

Non-technical walkthroughs of the same ground, one per role, live in
[`docs/guides/`](docs/guides/): [event admin](docs/guides/event-admin.md),
[evaluator](docs/guides/evaluator.md), [speaker](docs/guides/speaker.md).

### Demo personas

The one-click buttons on `/login` sign these three in without a password — no
credential is presented at all. The credential form beside them accepts the same
identities with the seeded demo password — a deliberately public constant
(`DEMO_PERSONA_PASSWORD` in `lib/demo/seed.ts`), not a secret, rotated by editing
it and reseeding.

| Role | Persona | Email | Main area |
| --- | --- | --- | --- |
| Event admin | Maya Chen | `maya@greenroom-hq.com` | Forms, Abstracts, Agenda |
| Evaluator | Ravi Patel | `ravi@greenroom-hq.com` | Evaluations |
| Speaker | Sofia Marques | `sofia@greenroom-hq.com` | Speaker portal |

The one-click buttons are always available outside production. In production
they are off unless `DEMO_PERSONA_LOGIN_ENABLED=true` is set, and the server
action refuses the sign-in — not just the buttons — when it is not. The hosted
demo sets it on purpose; your own deployment does not have to.

### Repeatable verification

Run these from a checked-out repository. The production verifier needs the
configured read-only database connection to discover a live published form; it
checks that production reset remains refused and does not seed or reset data.

```bash
npm test
npm run typecheck
npm run build
node --env-file=.env scripts/_frontend-smoke.mjs
node scripts/prod-verify.mjs https://greenroom-hq.com
```

The frontend smoke creates and removes only its `scratch-frontend` event. For
an external-origin embed proof, serve
[`docs/judging/embed-schedule-proof.html`](docs/judging/embed-schedule-proof.html)
from any static host or localhost.

## Quickstart

**Prerequisites:** Node.js **20.9+** (Next 16 requires it) and a Postgres
database you can point at — a free [Neon](https://neon.tech) project works and is
what the hosted demo uses.

```bash
npm install
cp .env.example .env       # set DATABASE_URL (Postgres, e.g. Neon)
npm run db:push            # apply the Prisma schema (also generates Prisma Client)
npm run db:seed            # deterministic demo data (event, forms, 40 abstracts, schedule)
npm run dev
```

Then open http://localhost:3000/login. Sign in with an email and password, or
use the one-click demo personas (Admin / Evaluator / Speaker). You can also
create an account at `/signup` and recover one at `/forgot`. A brand-new account
belongs to no event yet, so it lands on `/welcome` to create its first event or
wait for an organizer to add it.

Demo personas: `maya@greenroom-hq.com` (admin), `ravi@greenroom-hq.com` (evaluator),
`sofia@greenroom-hq.com` (speaker).

`DATABASE_URL` is the only variable a local install must set; everything else
defaults safely (external integrations mocked, demo reset disabled, public REST
API off, persona logins on outside production). A production deployment
additionally needs `SESSION_SECRET` — at least 32 characters — and fails closed
on sessions without it; see [`docs/DEPLOY.md`](docs/DEPLOY.md). This path is
rehearsed end-to-end from a clean clone and empty database in
[`docs/judging/INSTALL-REHEARSAL.md`](docs/judging/INSTALL-REHEARSAL.md).

## Current limitations

The three an evaluator hits first:

- **A new self-service account starts outside every event.** Sign-up grants no
  membership, so a fresh account lands on `/welcome` to create its own event or
  wait for an organizer to add its address.
- **Event switching is bounded by your own memberships.** There is no way to
  join an event you were not added to, and no cross-event view — every screen
  shows exactly one event.
- **Proposal attachments are portal-only and private to their uploader.** The
  anonymous public CFP form takes no attachment at all, and a co-speaker on a
  shared proposal can see that a document exists but cannot open it.

The authoritative, contextual list — eleven entries, each with its reasoning —
lives in one place: the
[evaluation index](docs/judging/README.md#current-limitations). The three above
are pointers to it, not a second copy of it.

## Stack

Next.js 16 (App Router) · React 19 · Prisma 6 · PostgreSQL · Zod. Plain CSS,
no UI framework. See `docs/ARCHITECTURE.md`.

## Documentation

| Document | What it covers |
| --- | --- |
| [`docs/judging/`](docs/judging/README.md) | Evaluation index: walkthrough script, screenshot index, verification receipts, limitations |
| [`docs/guides/`](docs/guides/) | Plain-language how-tos for admins, evaluators, and speakers |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Product boundary, domain model, routes, security |
| [`docs/LIFECYCLE.md`](docs/LIFECYCLE.md) | Abstract / Session / ScheduleSlot / SpeakerTask state machines |
| [`docs/INVARIANTS.md`](docs/INVARIANTS.md) | Rules the server enforces, referenced from code comments |
| [`docs/API.md`](docs/API.md) | Read-only `/api/v1` REST surface and the in-app speaker endpoints |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Vercel + Neon setup, environment variables, demo operations |

## Contributing

Greenroom is developed in the open. The engineering rules a change is held to
are in [`AGENTS.md`](AGENTS.md) — `main` stays deployable, changes stay focused
and reviewable, and secrets never enter the tree. The boundaries a change must
respect are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
[`docs/INVARIANTS.md`](docs/INVARIANTS.md), and
[`docs/LIFECYCLE.md`](docs/LIFECYCLE.md); design rationale is recorded in
[`docs/DECISIONS.md`](docs/DECISIONS.md). Run the verification commands above
before opening a pull request.

## License

Copyright © 2026 Frostbite1536.

Greenroom is licensed under the GNU Affero General Public License v3.0
(**AGPL-3.0-only**) — chosen so that hosted forks must share their source. See
[LICENSE](LICENSE) for the full text.
