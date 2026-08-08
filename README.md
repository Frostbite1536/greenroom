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

**Live at <https://greenroom-omega-dusky.vercel.app>** (Vercel + Neon; pushes to
`main` auto-deploy). See `docs/DEPLOY.md` for the deploy runbook, environment
variables, and the gated demo-reset endpoint.

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
