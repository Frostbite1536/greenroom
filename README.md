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
   through evaluation plans (blind review supported), routed by category.
4. **Accept → Session** — accepted abstracts convert into confirmed, schedulable
   sessions.
5. **Speaker onboarding** — a speaker portal with profile, status, and task
   checklists (tasks can carry forms).
6. **Agenda builder** — day/room scheduling with transactional room-overlap and
   speaker double-booking conflict detection.
7. **Public embeds** — mobile-friendly schedule embed with `.ics` calendar
   export.

## Quickstart

```bash
npm install
cp .env.example .env       # set DATABASE_URL (Postgres, e.g. Neon)
npm run db:push            # apply the Prisma schema
npm run db:seed            # deterministic demo data (event, forms, 40 abstracts, schedule)
npm run dev
```

Then open http://localhost:3000/login — one-click demo personas (Admin /
Evaluator / Speaker) are available, plus login-as-any-email.

Demo personas: `maya@greenroom.demo` (admin), `ravi@greenroom.demo` (evaluator),
`sofia@greenroom.demo` (speaker).

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
5. Verify the result while logged out at
   [`/embed/schedule`](https://greenroom-omega-dusky.vercel.app/embed/schedule).
   The demo event can also be selected explicitly with
   [`?event=forward-2026`](https://greenroom-omega-dusky.vercel.app/embed/schedule?event=forward-2026).

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

## Contributing / sprint history

This codebase was built during a 48-hour replication sprint; the multi-agent
workflow that produced it is documented in `docs/SPRINT_WORKFLOW.md`.

## License

Copyright © 2026 Frostbite1536.

Greenroom is licensed under the GNU Affero General Public License v3.0
(**AGPL-3.0-only**) — chosen so that hosted forks must share their source. See
[LICENSE](LICENSE) for the full text.
