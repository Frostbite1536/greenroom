# Jeremy Inbox

This tracked file is the template and durable record. For live parallel-agent coordination, use the external copy at `$SPRINT_COORDINATION_DIR/JEREMY-INBOX.md`.

Agents should append questions only when a decision affects product behavior, architecture, data, security, or significant rework. Every question must include a recommendation and fallback so work continues without waiting.

## Open Questions

_None._

## Resolved Questions

> Synced from `$SPRINT_COORDINATION_DIR/JEREMY-INBOX.md` at each merge cycle.
> Rationale for architectural decisions lives in `docs/DECISIONS.md`.

### [ops] Vercel deploy blocked on credentials
- **Decision:** Repo is live and **private** at `https://github.com/Frostbite1536/greenroom`
  (main + all three feature branches pushed; `origin` wired into the worktrees).
  Jeremy imports it into Vercel via the **GitHub integration**, so pushes to
  `main` auto-deploy. No `vercel login` / `vercel link` needed by any agent.
- **Ops follow-up:** `vercel.json` pins the build to `prisma generate && next build`.
  Env vars are tabulated in `docs/DEPLOY.md`; `DATABASE_URL` (Neon pooled) is the
  only required one. `ALLOW_DEMO_RESET` must stay unset in production so
  `/api/admin/reset` is refused; ops verifies this against the live URL.
- **Status:** RESOLVED (2026-08-08, ops)

### [architect] Database credentials required
- **Decision:** **Neon Postgres 17** (pooled URL in git-ignored `.env`).
  `prisma db push` applied; demo event seeded. The original fallback ("no agent
  runs `db push`, seed, or destructive reset") no longer applies — seeding and
  the gated reset are live under single-writer discipline (see `docs/DECISIONS.md`).
- **Status:** RESOLVED (2026-08-08, ops)

### Program scope refinement
- **Decision:** Program management only. Abstracts and Sessions are distinct.
  Manual evaluation plans/rubrics take priority; AI evaluation is excluded.
  CRM, marketing, payments, and multi-language are excluded.
- **Status:** RESOLVED

### Product identity and licensing (Jeremy, direct)
- **Decision:** Ships post-sprint as **Greenroom**, an open-source alternative,
  licensed **AGPL-3.0-only** (so hosted forks must share source). Rename landed
  atomically as `20976f8` with the demo DB reseeded under `@greenroom.demo`.
- **Status:** RESOLVED (2026-08-08, architect)
