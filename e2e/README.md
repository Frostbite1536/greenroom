# Browser-level proof and evidence capture

Two Playwright suites that drive a real Chromium against a real production
build of this application:

| Suite | Script | What it proves |
| --- | --- | --- |
| `golden-path.spec.ts` | `npm run test:e2e` | The judge journey, in order: anonymous CFP → submission → organizer sign-in → the proposal in the pipeline → acceptance provisioning a session and onboarding tasks → a **refused** colliding placement → a clean placement → the speaker portal → the logged-out public programme. |
| `screenshots.spec.ts` | `npm run evidence:screenshots` | Every row of [`../docs/judging/SCREENSHOT-INDEX.md`](../docs/judging/SCREENSHOT-INDEX.md), captured as a PNG into `../docs/judging/screenshots/` together with a `capture-manifest.json` of per-file metadata. |

## The database rule — read this first

**Both suites WRITE.** They submit proposals, accept them (which creates
Sessions and assigns onboarding tasks), attempt and make schedule placements,
and cause mocked email dispatches. A browser journey that proves the product
has to write to the product.

So they run **only against a throwaway or local database**. Never the shared
demo database, never production.

This is enforced, not merely documented. Before a single step runs, the guard in
[`db-guard.ts`](db-guard.ts) — the same pattern as
[`../scripts/install-rehearsal.mjs`](../scripts/install-rehearsal.mjs) —
refuses to continue unless:

1. `E2E_EXPECTED_DB` is set to a **distinctive substring of the disposable
   database's host** (for example its Neon endpoint id), and
2. the `DATABASE_URL` this process resolves actually contains that substring, and
3. the target base URL is loopback (`127.0.0.1` / `localhost`).

No value read by the guard is ever printed. If the assertion is missing or does
not match, the run aborts before the seed and before the browser opens.

A loopback URL alone is not enough and the guard says so: it proves the *server*
is local, not that its *database* is disposable — a local server can be pointed
at a shared database. `E2E_EXPECTED_DB` is the operator's explicit assertion
about the database, and it is required every time.

## Running

```powershell
# 1. Build the production server the suites drive (they run `next start`).
npm run build

# 2. Assert which disposable database this is, then run.
$env:E2E_EXPECTED_DB = "<distinctive substring of the disposable DATABASE_URL host>"
npm run test:e2e
npm run evidence:screenshots
```

Both suites reseed in `beforeAll` with `npm run db:seed`, which wipes and
rebuilds all event-scoped data. That is what makes them **re-runnable**: run
either one twice in a row and the second run starts from the same state as the
first. The golden path also stamps its proposal title with the run's timestamp
so two runs can never collide on a title.

`playwright.config.ts` starts `next start` on port **3400** (outside the
3200–3299 range the sprint's other lanes use) and reuses an already-running
server if one is there. Override with `E2E_PORT`, or point at an existing server
with `E2E_BASE_URL`.

`next start` runs in production mode, where the session-cookie secret fails
closed; the config supplies a local-only `SESSION_SECRET` for the server it
spawns unless one is already in the environment. That secret is for a
throwaway local server and nothing else.

## Artifacts

- **Committed:** the evidence PNGs and `capture-manifest.json` under
  `docs/judging/screenshots/`. They are the deliverable.
- **Never committed:** `e2e/.artifacts/`, `playwright-report/`,
  `test-results/`, `blob-report/` — failure screenshots, traces and report
  debris. All are git-ignored.

Each journey step captures its own screenshot at the moment it fails and
attaches it to the report, because the end-of-test screenshot Playwright takes
by default can land on a page the failing step already navigated away from.

## Type checking

These files are deliberately outside the app's `tsconfig.json`, so they never
enter the Next build. They are type-checked on their own:

```powershell
npx tsc -p e2e/tsconfig.json
```
