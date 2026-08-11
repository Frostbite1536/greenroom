# Clean-database installation rehearsal

## Intermediate `ff78b1d` rerun — preserved after Track C authorization

Jeremy authorized the Track C AI pass after this rehearsal, so this receipt is
**intermediate**, not the final submitted-SHA receipt. It remains valid evidence
for product tree `ff78b1d2dcdecd6eaa89b4348b0b247de1be280d` and the harness-only
corrections at `56eddd5` / `988c812`; the final sequence must be repeated after
both AI features merge. The disposable Neon target was retained for that later
run and no credential is recorded here.

| Step | Result |
| --- | --- |
| Fresh clone | 4.4 s, clean at `ff78b1d` |
| Locked install | 32.5 s, 72 packages, **0 vulnerabilities** |
| Empty-target proof | 0 tables and 0 enums; target distinct from production/shared databases |
| `db:push` + post-diff | 17.7 s; schema created; post-diff empty |
| Seed | 53.7 s; 51 users, 4 categories, 3 tracks, 4 rooms, 4 forms, 40 abstracts, 13 sessions, 11 slots, 6 onboarding tasks, 72 speaker tasks, 5 templates, 2 resources |
| Product-tree unit | **1671 pass / 0 fail / 5 gated skips** |
| Evidence-harness unit | **1672 pass / 0 fail / 5 gated skips** |
| Type/build | app + E2E typechecks and fresh Next 16.3 build passed |
| Install rehearsal | **20/20**, sentinel matched, owned server stopped and port released |
| Screenshot capture | **5/5**, 27 files + 27 manifest rows, 2026-08-11T20:46:26.919Z–20:47:32.461Z |
| Golden-path E2E | **1/1 twice**, fresh reseed each run, owned port released after both |

The screenshots and manifest are preserved on this evidence branch and are
explicitly labeled intermediate in `SCREENSHOT-INDEX.md`.

Evidence that the README Quickstart works verbatim on a machine that has never
seen this project. Performed by the Ops worker against a **separate, disposable
Neon project** (its own host, never the shared demo database, never added to
Vercel; deleted after this report).

Rehearsed twice on **2026-08-08**: first at `798580f`, then re-run at
**`f80247e`** — the freeze-candidate tree, including the operator console, the
speaker proposal editor and the template editor. Both runs were a fresh
`git clone` from GitHub, not a copy of a working tree. The second run started
from a **genuinely empty database** (`DROP SCHEMA public CASCADE` first), so
`db:push` had to build all 24+ tables from nothing.

> **Historical evidence, preserved as measured.** Current `main` has since moved
> Session creation into the acceptance transaction: accept returns 200 with
> `sessionCreated`/`tasksAssigned`, and the legacy convert/backfill call normally
> returns 200 for that existing Session. The 20/20 statuses and seed counts below
> describe `f80247e`; they are not rewritten to imply a rerun that did not happen.

## Result: clean install works, golden path 20/20

Timings below are the second (freeze-candidate) run.

| Step | Command | Time | Result |
| --- | --- | ---: | --- |
| 1 | `git clone …/greenroom.git app` | 2.8 s | clean |
| 2 | `npm install` | 30 s | 69 packages, **0 vulnerabilities** |
| 3 | `cp .env.example .env` + set `DATABASE_URL` | — | only that one variable had to change |
| 4 | `npm run db:push` | 16 s | built the whole schema from an empty database; Prisma Client generated automatically |
| 5 | `npm run db:seed` | 53 s | 45 users, 4 categories, 3 tracks, 4 rooms, 2 forms, 40 abstracts, 13 sessions, 11 slots, 5 onboarding tasks, 60 speaker tasks, 4 templates, 2 resources |
| 6 | `npm run dev` | ready in **0.8 s** | `http://localhost:3000/login` renders |
| 7 | `npm test` | 6.5 s | **162/162** |
| 8 | `npm run build` | 21 s | compiled successfully |
| 9 | `SMOKE_PORT=3237 node --env-file=.env scripts/_frontend-smoke.mjs` | 35 s | **75/75** |

**Total: under three minutes from `git clone` to a working, fully seeded
instance**, of which ~53 s is seeding 40 abstracts and a full schedule.

The first run at `798580f` produced the same outcome (108/108 tests, 71/71 smoke
against the suites of the day, golden path 20/20), so this is a repeatable
property of the project rather than a lucky machine.

The seeded counts are byte-identical to the production demo event, which is the
point of a deterministic seed: anyone who installs locally sees the same data as
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

The run also asserts a **sentinel** before touching anything: the harness proves
the server it is about to drive shares the disposable database the operator
named. Loopback alone would not prove that — a local dev server pointed at the
shared demo database would still be mutated.

The three guardrails matter as much as the happy path: a fresh install is safe by
default — destructive reset off, public API off rather than open, role
authorization on.

## Findings

1. **README Quickstart had no prerequisites.** Next 16 requires **Node ≥ 20.9**
   (`next@16.3.0` `engines`), and the documented smoke command uses
   `node --env-file`, which needs Node ≥ 20.6. An evaluator on Node 18 would have hit
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

## Reproduce the recorded tree

```bash
git clone https://github.com/Frostbite1536/greenroom.git app && cd app
git checkout f80247e
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

At the recorded checkout, `scripts/install-rehearsal.mjs` **writes** (submit → accept → convert → schedule
→ task completion), so it refuses to run unless all three guards pass: the
explicit opt-in, a loopback-only target, and `INSTALL_REHEARSAL_EXPECTED_DB`
matching the `DATABASE_URL` it was launched with — loopback alone proves the
server is local, not that its database is disposable. Never point it at the
shared demo database.
