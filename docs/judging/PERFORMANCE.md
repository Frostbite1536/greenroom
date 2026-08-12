# Measured performance and accessibility

Lighthouse 13.4.1, headless Microsoft Edge (Chromium), default **mobile**
emulation with simulated 4G throttling — the harshest of the standard presets.
One run per route, captured by the Ops worker: the public routes on
**2026-08-08 16:41 UTC**, everything else re-measured on **2026-08-08 20:59–21:03
UTC** after the accessibility fixes and the newer screens landed. Every measured
request is a read-only `GET`; no mutation, seed, or reset was issued.

> **Historical measurement, preserved as measured.** The public-route numbers
> below were captured from the then-canonical Vercel deployment before the
> canonical-domain cutover. They remain evidence for that build, not a fresh
> measurement of current `https://greenroom-hq.com`. Use the canonical URL in
> the reproduction command for a new measurement; do not overwrite this table
> without recording the new date, commit, and environment.

## Results

| Route | Environment | Perf | A11y | FCP | LCP | TBT | CLS | Speed Index | TTFB | Page weight |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/login` | production | **98** | **100** | 0.8 s | 1.8 s | 140 ms | 0 | 1.1 s | 33 ms | 142 KiB |
| `/cfp/call-for-speakers` | production | **98** | **100** | 0.9 s | 1.6 s | 160 ms | 0 | 2.3 s | 28 ms | 152 KiB |
| `/embed/schedule` | production | **96** | **100** | 0.9 s | 1.8 s | 160 ms | 0 | 3.7 s | 29 ms | 152 KiB |
| `/embed/speakers` | production | **98** | **100** | 0.9 s | 1.6 s | 150 ms | 0 | 2.2 s | 29 ms | 155 KiB |
| `/admin/abstracts` | local prod build | **96** | **100** | 0.9 s | 2.2 s | 180 ms | 0 | 2.1 s | 1057 ms¹ | 159 KiB |
| `/admin/agenda` | local prod build | **95** | **100** | 0.9 s | 2.3 s | 210 ms | 0 | 1.7 s | 762 ms¹ | 161 KiB |
| `/admin/speakers` | local prod build | **99** | **100** | 0.9 s | 1.6 s | 80 ms | 0 | 1.9 s | 960 ms¹ | 156 KiB |
| `/admin/operations` | local prod build | **98** | **100** | 0.9 s | 1.7 s | 150 ms | 0 | 1.7 s | 823 ms¹ | 177 KiB |
| `/portal` | local prod build | **97** | **100** | 0.9 s | 2.2 s | 150 ms | 0 | 2.1 s | 1124 ms¹ | 152 KiB |
| `/portal/submissions/[id]` | local prod build | **97** | **100** | 0.9 s | 2.2 s | 150 ms | 0 | 2.5 s | 609 ms¹ | 159 KiB |

**At the recorded measurement, every audited route scored 100 on accessibility,
with zero layout shift, and every page shipped under ~180 KiB.** Ten routes
covering all four user journeys:
public visitor, speaker, reviewer, and event admin.

¹ **Read this before comparing TTFB columns.** The admin and portal routes
require an authenticated session, and the production `SESSION_SECRET` is not
available to workers, so they were measured against a local `next start` build.
Their TTFB is therefore *worse* than production, not better: every request pays a
cold round trip from a laptop in North America to the shared Neon Postgres
instance, with no connection reuse. Production public routes measure 28–33 ms
TTFB on the same code. Treat the local numbers as an upper bound.

## What the numbers reflect

- **Server-rendered reads, no client data fetching.** Admin and portal screens
  query Prisma directly in server components (`lib/data/reads.ts`) instead of
  fetching this app's own HTTP API, which removes a full round trip and cookie
  forwarding per page.
- **Narrow client islands.** Interactivity is scoped to the components that need
  it (task checklist, profile form, agenda builder, operations panels), which is
  why TBT stays at 80–210 ms. `/admin/speakers` ships **no** client JavaScript —
  its filters are links, so it works with scripting disabled and every filter is
  URL-restorable.
- **Bounded queries.** Operator reads cap the rows they materialize
  (`lib/api/query-limits.ts`) instead of degrading silently as an event grows.

The one repeated opportunity Lighthouse reports is 29–48 KiB of unused
JavaScript in the shared framework chunk — the Next.js/React runtime baseline,
not application code.

### One measurement caveat, stated honestly

`/portal/submissions/[id]` renders a shell and then loads the proposal from the
backend contract in the browser, so a naïve audit could have scored an empty
loading state. It did not: Lighthouse's own final screenshot for that run shows
the fully loaded editor — talk title "Scaling Vector Search", the Accepted
status, description, session type, length, track, and both custom questions. The
100 is on the real form.

## Accessibility

**No automated accessibility failures remain on any audited route.** The issues
recorded in the previous revision of this document have all been fixed and
re-measured:

| Route | Was | Fix | Now |
| --- | --- | --- | --- |
| `/embed/schedule` | 98 — no `main` landmark | `<main>` landmark added | **100** |
| `/admin/abstracts` | 96 — tab count badge at 4.33:1 | badge contrast raised | **100** |
| `/admin/agenda` | 95 — white text at 2.14:1 on amber track chips | chip text colour now derived from background luminance | **100** |
| `/admin/speakers` | 94 — `aria-pressed` on anchors | filter links use `aria-current="page"` | **100** |

Automated tooling is not a complete accessibility review.

### Manual screen-reader pass — partial

A manual screen-reader pass was performed on production on **2026-08-12** by the
project owner, using **NVDA with Chrome on Windows**. It is **partial**: three of
ten planned journeys were started, and not all of those completed. The results
are recorded exactly as run.

| Journey | Result |
| --- | --- |
| 1 — public landing → schedule | **6 of 6 checkpoints PASS** |
| 2 — admin sign-in → dashboard | **6 PASS, 1 minor FAIL** |
| 3 — review queue → accept a proposal | **3.1–3.7 PASS; 3.8 NOT CONFIRMED; 3.9 NOT RUN** |
| 4–10 | **NOT RUN** |

Two entries need their labels read literally rather than rounded:

- **Journey 2's failing checkpoint was not identified by the runner.** Severity
  was reported as minor and non-blocking, but which checkpoint failed is not
  recorded, so it cannot be pointed at a fix or a regression test.
- **NOT CONFIRMED is not a pass.** Checkpoint 3.8 was reached but its outcome
  was not established. Checkpoint 3.9 and journeys 4 through 10 were **NOT
  RUN** — no evidence exists for them in either direction.

Scope limits that still stand:

- NVDA on Chrome on Windows only.
- No VoiceOver, no JAWS, no real mobile screen reader, no braille display.
- This is **not a WCAG conformance audit**.

So the honest position is narrower than "manually tested": one journey is fully
covered, one has an unlocated minor defect, one is incomplete, and seven were
never attempted.

## Reproduce

```bash
# Public production routes
CHROME_PATH="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" \
npx lighthouse "https://greenroom-hq.com/embed/schedule?event=forward-2026" \
  --only-categories=performance,accessibility \
  --chrome-flags="--headless=new --no-sandbox" \
  --output=json --output-path=lighthouse-embed-schedule.json

# Authenticated routes: build, start a local server on an ops port, and pass a
# signed session cookie (see scripts/_signed-session.mjs).
npm run build && SESSION_SECRET=<smoke secret> npx next start -p 3235
npx lighthouse "http://127.0.0.1:3235/admin/operations" \
  --only-categories=performance,accessibility \
  --chrome-flags="--headless=new --no-sandbox" \
  --extra-headers '{"Cookie":"sb_session=…"}' \
  --output=json --output-path=lighthouse-admin-operations.json
```

To confirm a client-loaded page was measured in its loaded state, write the run's
own screenshot out and look at it:

```bash
node -e "const r=require('./lighthouse-admin-operations.json');
require('fs').writeFileSync('shot.png', Buffer.from(r.audits['final-screenshot'].details.data.split(',')[1],'base64'))"
```

Kill only the PID you spawned (`netstat -ano | findstr :3235`), never Node by
image name.
