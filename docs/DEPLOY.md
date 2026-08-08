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
   | `RESEND_API_KEY` / `ACCELEVENTS_BASE_URL` / `AIRTABLE_API_KEY` | optional | Enable real integrations when present. |

4. First deploy checklist:
   - `/login` renders and the three persona buttons work.
   - After login, the shell (`/admin/*`, `/portal`) loads.
   - `/cfp/[formId]` and `/embed/schedule` render without a session.

## Database
- Schema is applied with `prisma db push` (see architect). Do not run destructive
  migrations against the shared Neon DB without coordination.
- Env validation lives in `lib/env.ts` (`getServerEnv`, `useMockIntegrations`,
  `isDemoResetAllowed`).

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
Persona users are upserted by email so logins survive a reseed. The speaker
persona (`sofia@greenroom.demo`) owns a confirmed session and is at 3/5 tasks.

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

Plus login-as-any-email (SPEAKER role).
