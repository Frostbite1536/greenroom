# Handoff — 2026-10-17

The starting point for the next working session. It records the state of `main`,
what changed in the October security cycle, the environment traps that cost time,
and the open work in priority order. Read it after `AGENTS.md`; the rules there
still govern.

## State of `main`

- **Head:** `264f212` (merge of #115), deployed to <https://greenroom-hq.com>.
- **Baseline at that head** (fresh `npm ci`, no env vars): `npm run typecheck`
  exit 0 · `npm test` **2095 tests, 2090 pass, 0 fail, 5 skipped** · `npm run build`
  exit 0 on Next.js 16.3.8. The 5 skips are the C33 race proofs, which only run
  with `RACE_PROOF=1` and a disposable Postgres. CI runs them on every PR.
- **Dependency audit** (`npm audit --omit=dev`): 0 critical, 3 high, all in the
  Prisma CLI chain (`prisma` → `@prisma/config` → `deepmerge-ts` < 8). No stable
  Prisma fixes it yet. It is reached only when the Prisma CLI loads our own config.

## What changed in October (PRs #111–#116)

Merged in this order. Each deploy was confirmed live by a behaviour only the new
build has, not by a status code.

| PR | Change | Decision record |
|---|---|---|
| #112 | `next` 16.3.0 → 16.3.8 (critical RCE-class advisories); `sharp`, `source-map-js` bumped | — |
| #111 | **First CI** (`.github/workflows/ci.yml`): `verify` (fresh `npm ci`, typecheck, test, build, no env), `race-proofs` (Postgres 16 service, `RACE_PROOF=1`, fails on any skipped test), `audit` (`--audit-level=critical`) | — |
| #113 | Seeded demo identities sign in with a password only where `arePersonaLoginsEnabled()`; the seed refuses `NODE_ENV=production` without `ALLOW_DEMO_RESET=true` | SEC-01 |
| #114 | `reviewer-invites/accept` requires a same-origin request, like every other session-issuing route | SEC-02 |
| #116 | Sessions bound to the credential: the cookie carries `cf`, an HMAC of the password hash, re-checked on every resolve. A password reset signs out every older cookie | SEC-03 |
| #115 | Low-severity hardening: admin-roster deck href filter, sanitizer escapes stray `<`, `safeHref` refuses `/\host`, CSP `default-src 'none'; sandbox` on file responses, production boot fails without `SESSION_SECRET` | "Production boot fails without SESSION_SECRET" |

Contract changes a future change must respect:

- `encodeSession` / `encodePendingSession` are **async** and read the user's
  current `passwordHash` themselves. Any new route that issues a session must
  `await` them, and must call `isSameOriginAuthRequest` first (SEC-02).
- Authorization must go through `getResolvedSession` / `requireSession` /
  `getApiContext`. `getSession()` is the unresolved cookie claim and does **not**
  enforce revocation.
- Production requires `SESSION_SECRET` (≥ 32 characters) at boot, and
  `DEMO_PERSONA_LOGIN_ENABLED=true` for the hosted demo's personas **and** its
  documented email/password demo credentials.

## Verified, and how

- **The race proofs protect the lock.** Commenting out both `lockEventTaskFanOut`
  calls (`lib/services/session-provisioning.ts`) turns 4 of the 5 C33 tests red
  (the second writer is not blocked, and the speaker gets 0 tasks instead of 1).
- **Each security fix was proven twice against a local production build**
  (`next start`, `NODE_ENV=production`, Postgres 16): once as a working exploit
  before the fix, once as a refusal after.
- **Checked and sound in the review**, so do not re-audit without cause:
  - cross-event ID access across ~60 id-taking routes, and role-level access;
  - the publish gates on public surfaces;
  - cookie flags, the DB-backed rate limiter, and reset/invite token design;
  - the sanitizer against ~45 bypass payloads, and file serving.

## Environment traps (Windows + this repo)

- **A stopped background `next start` can survive.** Killing the shell task did
  not kill the `npx`/`node` children. They held
  `node_modules/.prisma/client/query_engine-windows.dll.node` open, which made
  `npm ci` fail with `EPERM` and `git worktree remove` fail. Find them with
  `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` and stop them by PID.
- **`npm audit fix --omit=dev` also removes devDependencies** from
  `node_modules`, and it pinned `@types/react` to an exact version. Use targeted
  `npm install <pkg>@<exact>` / `npm update <pkg>` and diff the lockfile package
  by package.
- **`npm install next@^16.3.8` resolves to the newest 16.x** (it took 16.4.0).
  Pass the exact version for a patch-only bump.
- **`npx tsx -e '…'` hung**, waiting on stdin. Run a file instead.
- **`pg_ctl start` blocks a piped shell.** Redirect all three streams
  (`> /dev/null 2>&1 < /dev/null`).
- **`gh` needs `-R Frostbite1536/greenroom`** when run outside a checkout.
- **`git stash` is shared by every worktree.** Use a temporary commit, or a
  file copy, for mutation checks.
- **There is no Vercel preview for PRs.** `vercel.json`'s `ignoreCommand`
  builds `main` only. A PR is first deployed when it merges, so verify the
  deploy by the commit's Vercel status (`gh api repos/<repo>/commits/<sha>/status`),
  then by a new-code-only behaviour.
- **Every decision PR appends to the end of `docs/DECISIONS.md`.** Parallel
  PRs conflict there every time; the resolution is always keep-both, in merge
  order.
- **The reviewer invite token lives in the URL fragment as `#invite=…`**, not
  `#token=…`.
- **Cloning into a deep Windows path** needs `git config core.longpaths true`.

## Lessons from the Kill My SaaS result (2026-10-13)

Greenroom did not place. Comparing it against the three winning entries:

- **Optimize against the evaluator's own harness, continuously.** The official
  eval kit (`swyx/killmysaas-evals`) was run once mid-sprint (52%) and not
  iterated against. The highest-placed entries ran it repeatedly and logged every
  miss by cause.
- **Turn each organizer ruling into a scope decision the same day.** Discord
  waived Accelevents, said "a small useful agent is enough", and named the admin
  UI as the priority. Time spent on partial versions of waived items was time
  not spent on the scored ones.
- **Build the judge's entrance first.** That means copyable demo credentials, a
  short video, forgiving URLs, and a landing page that says what to try. Lead
  evaluator docs with what to do, not with commit-SHA provenance.
- **Rigor has to show up as a demo moment to count.** The locked,
  transactional conflict refusal was the strongest engineering in the
  comparison, but an evaluator meets it only through the one refused drag.
- **CI complements the two-track review.** The two recorded escapes were both
  mechanical: two green PRs turning `main` red together (#78), and a fresh clone
  whose `npm test` failed (the missing `postinstall`). A CI job catches both, and
  reviewers keep the judgment.
- **Prove findings with a request, not a reading.** Of the review's
  "confirmed" findings, one stored-`javascript:` link turned out not to be
  exploitable, because React 19 rewrites such hrefs at render. Another seemed
  minor and was a full admin takeover.

## Open work, in priority order

1. **Click-test a one-click persona button** on the live `/login`. That path
   (`app/login/actions.ts`) changed in #116; only its email/password sibling was
   verified live.
2. **Make Playwright part of CI.** `e2e/golden-path.spec.ts` exists but no
   workflow runs it. It needs the Postgres service, `E2E_EXPECTED_DB`, and a
   seeded database.
3. **Shrink the source-text tests.** 94 of 210 test files `readFileSync` their
   subject. Convert the ones that guard behaviour into tests that run it, and
   report the rest separately so the headline count isn't discounted.
4. **Add a linter.** There is no ESLint config or `lint` script.
5. **Automate reminders.** There is no scheduler; reminders go out only when an
   admin clicks. Vercel Cron, or an external trigger hitting an authenticated
   route, would cover the brief's "automated" communications.
6. **Product decisions left open by the security review** (need a call, not a
   bug fix):
   - a per-user / per-event **upload byte quota** (attempts are throttled, bytes
     are not);
   - whether to trust `X-Forwarded-For` **off Vercel** (today a self-host
     behind a proxy can have its rate-limit key spoofed);
   - **same-origin gating of non-auth admin POSTs** (they rely on
     `SameSite=Lax` alone);
   - a **rate limit on `cfp/submissions/resume`**.
7. **Sign-out revocation.** Sign-out still deletes only the browser's copy. A
   `User.sessionsValidAfter` column would add "sign out everywhere", but it is a
   schema change that must reach production before the deploy (see SEC-03 for
   the trade-off).
8. **Raise the CI audit to `--audit-level=high`** once Prisma ships a stable
   release with `deepmerge-ts` ≥ 8.
9. **Design debts:** uploaded files stored as Postgres `Bytes`, and screens
   showing one event at a time.
