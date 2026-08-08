# Clean-database installation rehearsal

Evidence that the README Quickstart works verbatim on a machine that has never
seen this project. Performed **2026-08-08** by the Ops worker against a
**separate, disposable Neon project** (its own host, never the shared demo
database, never added to Vercel; deleted after this report).

Rehearsed commit: **`798580f`** (`origin/main` at the time), fresh `git clone`
from GitHub — not a copy of a working tree.

## Result: clean install works, golden path 20/20

| Step | Command | Time | Result |
| --- | --- | ---: | --- |
| 1 | `git clone …/greenroom.git app` | 2.4 s | clean |
| 2 | `npm install` | 29 s | 69 packages, **0 vulnerabilities** |
| 3 | `cp .env.example .env` + set `DATABASE_URL` | — | only that one variable had to change |
| 4 | `npm run db:push` | 17 s | schema in sync; Prisma Client generated automatically |
| 5 | `npm run db:seed` | 69 s | 45 users, 4 categories, 3 tracks, 4 rooms, 2 forms, 40 abstracts, 13 sessions, 11 slots, 5 onboarding tasks, 60 speaker tasks, 4 templates, 2 resources |
| 6 | `npm run dev` | ready in **1.0 s** | `http://localhost:3000/login` renders |
| 7 | `npm test` | 6 s | **108/108** |
| 8 | `npm run build` | 24 s | compiled successfully |
| 9 | `SMOKE_PORT=3237 node --env-file=.env scripts/_frontend-smoke.mjs` | 36 s | **71/71** |

**Total: under four minutes from `git clone` to a working, fully seeded
instance**, of which ~70 s is seeding 40 abstracts and a full schedule.

The seeded counts are byte-identical to the production demo event, which is the
point of a deterministic seed: a judge who installs locally sees the same data as
the deployed demo.

## Golden path on the fresh install — 20/20

Driven by `scripts/install-rehearsal.mjs` against the `npm run dev` server.

| Golden-path step | Checks |
| --- | --- |
| 1. Publish a configured CFP form | seeded form is published; `/cfp/call-for-speakers` renders **logged out**; categories are offered as track options |
| 2. Speaker submits an abstract | anonymous submit → **201**, status `SUBMITTED` |
| 3. Evaluator scores through a plan | evaluator queue renders; score against the plan rubric persists → **200** |
| 4. Admin accepts and converts | accept → **200**; convert → **201** (new `Session`) |
| 5. Speaker completes onboarding | portal renders; task check-off persists → **200** |
| 6. Admin schedules without conflicts | conflicting placement **refused 409 `SCHEDULE_CONFLICT` / `ROOM_OVERLAP`**; clean placement → **200** |
| 7. Public embed + `.ics` | new talk visible on `/embed/schedule` **logged out**; `.ics` export → 200 and contains the talk; `/embed/speakers` → 200 |
| guardrails | `/api/admin/reset` refused **403 `RESET_DISABLED`**; `/api/v1/*` returns **503** with no `GREENROOM_API_KEY` (fails closed, never public); a SPEAKER session is **307**-redirected away from `/admin/agenda` |

The three guardrails matter as much as the happy path: a fresh install is safe by
default — destructive reset off, public API off rather than open, role
authorization on.

## Findings

1. **README Quickstart had no prerequisites.** Next 16 requires **Node ≥ 20.9**
   (`next@16.3.0` `engines`), and the documented smoke command uses
   `node --env-file`, which needs Node ≥ 20.6. A judge on Node 18 would have hit
   a confusing failure. Fixed in this pass — the Quickstart now states Node 20.9+
   and that a Postgres database is required first.
2. **Nothing else drifted.** `cp .env.example .env` plus one `DATABASE_URL` is
   genuinely all the configuration needed; every other variable is optional and
   defaults safely (`MOCK_EXTERNAL_APIS=true`, reset disabled, v1 API disabled).
3. **`prisma db push` runs `generate` for you**, so the Quickstart does not need
   a separate `db:generate` step. Confirmed, not assumed.
4. **Submission limits are real.** Re-running the rehearsal with the same speaker
   email returned **409 `SUBMISSION_LIMIT`** ("You can submit at most 3
   proposal(s) to this form") — correct enforcement of the seeded form's limit,
   discovered because the harness reused one address. It now uses a unique
   address per run.

## Reproduce

```bash
git clone https://github.com/Frostbite1536/greenroom.git app && cd app
npm install
cp .env.example .env          # set DATABASE_URL to a DISPOSABLE Postgres database
npm run db:push
npm run db:seed
npm run dev                   # http://localhost:3000/login

# in a second shell
npm test
INSTALL_REHEARSAL_ALLOW_WRITES=1 \
INSTALL_REHEARSAL_EXPECTED_DB=<distinctive substring of the disposable DB host> \
node --env-file=.env scripts/install-rehearsal.mjs
npm run build && SMOKE_PORT=3237 node --env-file=.env scripts/_frontend-smoke.mjs
```

`scripts/install-rehearsal.mjs` **writes** (submit → accept → convert → schedule
→ task completion), so it refuses to run unless all three guards pass: the
explicit opt-in, a loopback-only target, and `INSTALL_REHEARSAL_EXPECTED_DB`
matching the `DATABASE_URL` it was launched with — loopback alone proves the
server is local, not that its database is disposable. Never point it at the
shared demo database.
