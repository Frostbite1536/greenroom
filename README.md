# Greenroom

Greenroom is an open-source, self-hostable conference programme platform that
takes an organizer from an open CFP through structured review, atomic
acceptance, speaker readiness, conflict-safe scheduling, and a published
programme.

An alternative to closed CFP/speaker-ops SaaS: CFP forms, abstract evaluation,
speaker onboarding, and a conflict-aware agenda, with public embeds for your
event site.

Evaluating this project? Start at the
[judging index](docs/judging/README.md).

## Features (the golden path)

1. **CFP forms** — build a submission form (custom fields, conditional logic,
   submission limits, welcome/thank-you pages) and publish it at a public,
   event-scoped URL (`/cfp/{event}/{form}`). An unpublished form has no public
   page at all.
2. **Abstract intake** — speakers submit proposals with co-speakers (upserted by
   email); drafts and validation included.
3. **Evaluation** — review teams score abstracts against a weighted rubric
   through evaluation plans, routed by category. A round can be marked blind;
   assigned evaluators then lose speaker profiles, while the UI warns that
   proposal text can still identify its author.
4. **Accept → Session** — accepting an abstract atomically provisions its one
   confirmed, unscheduled session and every onboarding-task assignment for its
   speakers. The legacy conversion endpoint safely backfills older records.
5. **Speaker edits after acceptance** — speakers keep editing their own proposal
   while it is in draft, in review, or accepted; rejected and withdrawn
   proposals are read-only, and a confirmed talk's speaker list is fixed.
6. **Speaker onboarding** — a speaker portal with profile, status, and task
   checklists (tasks can carry forms), plus an admin dashboard at
   `/admin/speakers` showing who is behind.
7. **Agenda builder** — List / Day / Week / Tracks / Conflicts views, with
   drag-and-drop moves in the day grid and transactional room-overlap and
   speaker double-booking conflict detection.
8. **Public embeds** — a public landing page at `/`, plus a mobile-friendly
   schedule (day tabs, search, track filters, session details) and speaker
   gallery, with `.ics` calendar export and copy-paste snippets at
   `/admin/embeds`.

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
use the one-click demo personas (Admin / Evaluator / Speaker). There is no
self-service sign-up and no password reset — organizers provision accounts.

Demo personas: `maya@greenroom-hq.com` (admin), `ravi@greenroom-hq.com` (evaluator),
`sofia@greenroom-hq.com` (speaker).

`DATABASE_URL` is the only variable you must set; everything else defaults
safely (external integrations mocked, demo reset disabled, public REST API off).
This path is rehearsed end-to-end from a clean clone and empty database in
[`docs/judging/INSTALL-REHEARSAL.md`](docs/judging/INSTALL-REHEARSAL.md).

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

The one-click buttons on `/login` sign these three in without a password. The
credential form beside them accepts the same identities with the seeded demo
password — a deliberately public constant (`DEMO_PERSONA_PASSWORD` in
`lib/demo/seed.ts`), not a secret, rotated by editing it and reseeding.

| Role | Persona | Email | Main area |
| --- | --- | --- | --- |
| Event admin | Maya Chen | `maya@greenroom-hq.com` | Forms, Abstracts, Agenda |
| Evaluator | Ravi Patel | `ravi@greenroom-hq.com` | Evaluations |
| Speaker | Sofia Marques | `sofia@greenroom-hq.com` | Speaker portal |

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

## Current limitations

Stated up front rather than left to be discovered. The fuller list, with
context, is in the [judging index](docs/judging/README.md#current-limitations).

- **No self-service sign-up** and **no password reset** — organizers provision
  accounts. Public sign-up is roadmap, not shipped.
- **No event switching.** An admin can create a new event from **Event
  settings**, and it is created genuinely empty, but the workspace stays on the
  event the session was issued for. Switching is on the roadmap, so a brand-new
  event cannot yet be configured from the UI.
- **No file upload** on proposals or speaker profiles — slide decks and
  headshots are URLs. The only file input is the admin CSV proposal import.
- **One topic per submission, by design.** A form can offer several topic
  options; each proposal stores exactly one, and that is what routes it to a
  review team. The agenda `Track` is a separate, later placement choice.
- **Email is split on purpose.** Submission receipts dispatch on the live
  provider path when one is configured; decision mail is preview-gated and
  cannot send content that was not previewed.
- **The read-only v1 API is off** unless `GREENROOM_API_KEY` is configured.
- **Demo reset is refused** unless an operator sets `ALLOW_DEMO_RESET=true`. It
  is unset in production and there is no reset control in the UI.
- **Accessibility evidence is automated only** — no manual screen-reader pass.

## Stack

Next.js 16 (App Router) · React 19 · Prisma 6 · PostgreSQL · Zod. Plain CSS,
no UI framework. See `docs/ARCHITECTURE.md`.

## Documentation

| Document | What it covers |
| --- | --- |
| [`docs/judging/`](docs/judging/README.md) | Judging index: walkthrough script, screenshot index, verification receipts, limitations |
| [`docs/guides/`](docs/guides/) | Plain-language how-tos for admins, evaluators, and speakers |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Product boundary, domain model, routes, security |
| [`docs/LIFECYCLE.md`](docs/LIFECYCLE.md) | Abstract / Session / ScheduleSlot / SpeakerTask state machines |
| [`docs/INVARIANTS.md`](docs/INVARIANTS.md) | Rules the server enforces, referenced from code comments |
| [`docs/API.md`](docs/API.md) | Read-only `/api/v1` REST surface and the in-app speaker endpoints |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Vercel + Neon setup, environment variables, demo operations |

## Contributing / sprint history

This codebase was built during a 48-hour replication sprint; the multi-agent
workflow that produced it is documented in `docs/SPRINT_WORKFLOW.md`.

## License

Copyright © 2026 Frostbite1536.

Greenroom is licensed under the GNU Affero General Public License v3.0
(**AGPL-3.0-only**) — chosen so that hosted forks must share their source. See
[LICENSE](LICENSE) for the full text.
