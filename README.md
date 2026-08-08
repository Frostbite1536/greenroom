# Greenroom

Open-source event program management — an alternative to closed CFP/speaker-ops
SaaS. Greenroom covers the full life of a conference program: CFP forms,
abstract evaluation, speaker onboarding, and a conflict-aware agenda, with
public embeds for your event site.

## Features (the golden path)

1. **CFP forms** — build a submission form (custom fields, conditional logic,
   submission limits, welcome/thank-you pages) and publish it at a public URL.
2. **Abstract intake** — speakers submit proposals with co-speakers (upserted by
   email); drafts and validation included.
3. **Evaluation** — review teams score abstracts against a weighted rubric
   through evaluation plans, routed by category. A round can be marked blind,
   which hides speaker names in the evaluator's scoring queue.
4. **Accept → Session** — accepted abstracts convert into confirmed, schedulable
   sessions (at most one session per abstract).
5. **Speaker edits after acceptance** — speakers keep editing their own proposal
   while it is in draft, in review, or accepted; rejected and withdrawn
   proposals are read-only, and a converted talk's speaker list is fixed.
6. **Speaker onboarding** — a speaker portal with profile, status, and task
   checklists (tasks can carry forms), plus an admin dashboard at
   `/admin/speakers` showing who is behind.
7. **Agenda builder** — List / Day / Week / Tracks / Conflicts views, with
   drag-and-drop moves in the day grid and transactional room-overlap and
   speaker double-booking conflict detection.
8. **Public embeds** — mobile-friendly schedule and compact speaker gallery,
   with `.ics` calendar export and copy-paste snippets at `/admin/embeds`.

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

Then open http://localhost:3000/login — one-click demo personas (Admin /
Evaluator / Speaker) are available for the fixed seeded demo personas.

Demo personas: `maya@greenroom.demo` (admin), `ravi@greenroom.demo` (evaluator),
`sofia@greenroom.demo` (speaker).

`DATABASE_URL` is the only variable you must set; everything else defaults
safely (external integrations mocked, demo reset disabled, public REST API off).
This path is rehearsed end-to-end from a clean clone and empty database in
[`docs/judging/INSTALL-REHEARSAL.md`](docs/judging/INSTALL-REHEARSAL.md).

## Deployed demo

**Canonical production URL:** <https://greenroom-omega-dusky.vercel.app>

The demo runs on Vercel + Neon; pushes to `main` auto-deploy.

### Production golden-path walkthrough

The public CFP uses the stable seeded slug
[`/cfp/call-for-speakers`](https://greenroom-omega-dusky.vercel.app/cfp/call-for-speakers).
Use a distinctive, throwaway talk title so it is easy to find in the admin
pipeline.

1. Open the public CFP, complete its required fields, and submit it while
   logged out.
2. Go to [`/login`](https://greenroom-omega-dusky.vercel.app/login) and choose
   the **Event admin** persona. Open **Abstracts**, select the submitted row,
   then choose **Accept**.
3. With that row still selected after refresh, choose **Create session**.
4. Open **Agenda**. In the **Unscheduled backlog**, select the new session,
   choose an available date, time, room, and optional track, then choose
   **Schedule**. The server prevents room and speaker overlaps.
   - Switch to the **Day** tab and drag a session block to another room or time
     — the move is re-checked on the server and refused if it collides.
   - Switch to the **Week** tab for a read-only overview of the whole event.
5. Open **Speaker onboarding** (`/admin/speakers`) to see profile completeness,
   settled tasks, and unscheduled sessions per speaker, and **Website embeds**
   (`/admin/embeds`) to copy the `<iframe>` snippets for your event site.
6. Sign in as the **Speaker** persona (Sofia) and open the speaker portal. Her
   accepted proposal is still editable — content changes are saved against the
   original form; the speaker list of a converted talk is locked.
7. Verify the result while logged out at
   [`/embed/schedule`](https://greenroom-omega-dusky.vercel.app/embed/schedule).
   The demo event can also be selected explicitly with
   [`?event=forward-2026`](https://greenroom-omega-dusky.vercel.app/embed/schedule?event=forward-2026).
   The scheduled speaker lineup is available at
   [`/embed/speakers`](https://greenroom-omega-dusky.vercel.app/embed/speakers?event=forward-2026).

Non-technical walkthroughs of the same ground, one per role, live in
[`docs/guides/`](docs/guides/): [event admin](docs/guides/event-admin.md),
[evaluator](docs/guides/evaluator.md), [speaker](docs/guides/speaker.md).

### Demo personas

Sign in through the one-click buttons on `/login`; no password is required.

| Role | Persona | Email | Main area |
| --- | --- | --- | --- |
| Event admin | Maya Chen | `maya@greenroom.demo` | Forms, Abstracts, Agenda |
| Evaluator | Ravi Patel | `ravi@greenroom.demo` | Evaluations |
| Speaker | Sofia Marques | `sofia@greenroom.demo` | Speaker portal |

### Repeatable verification

Run these from a checked-out repository. The production verifier needs the
configured read-only database connection to discover a live published form; it
checks that production reset remains refused and does not seed or reset data.

```bash
npm test
npm run typecheck
npm run build
node --env-file=.env scripts/_frontend-smoke.mjs
node scripts/prod-verify.mjs https://greenroom-omega-dusky.vercel.app
```

The frontend smoke creates and removes only its `scratch-frontend` event. For
an external-origin embed proof, serve
[`docs/judging/embed-schedule-proof.html`](docs/judging/embed-schedule-proof.html)
from any static host or localhost.

## Stack

Next.js 16 (App Router) · React 19 · Prisma 6 · PostgreSQL · Zod. Plain CSS,
no UI framework. See `docs/ARCHITECTURE.md`.

## Documentation

| Document | What it covers |
| --- | --- |
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
