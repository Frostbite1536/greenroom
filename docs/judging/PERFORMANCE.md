# Measured performance and accessibility

Lighthouse 13.4.1, headless Microsoft Edge (Chromium), default **mobile**
emulation with simulated 4G throttling — the harshest of the standard presets.
One run per route, captured **2026-08-08 16:41–16:46 UTC** by the Ops worker.
Every measured request is a read-only `GET`; no mutation, seed, or reset was
issued.

## Results

| Route | Environment | Perf | A11y | FCP | LCP | TBT | CLS | Speed Index | TTFB | Page weight |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/login` | production | **98** | **100** | 0.8 s | 1.8 s | 140 ms | 0 | 1.1 s | 33 ms | 142 KiB |
| `/cfp/call-for-speakers` | production | **98** | **100** | 0.9 s | 1.6 s | 160 ms | 0 | 2.3 s | 28 ms | 152 KiB |
| `/embed/schedule` | production | **97** | 98 | 0.9 s | 1.6 s | 160 ms | 0 | 2.6 s | 30 ms | 151 KiB |
| `/embed/speakers` | production | **98** | **100** | 0.9 s | 1.6 s | 150 ms | 0 | 2.2 s | 29 ms | 155 KiB |
| `/admin/abstracts` | local prod build | **96** | 96 | 0.9 s | 2.2 s | 160 ms | 0 | 2.6 s | 1410 ms¹ | 158 KiB |
| `/admin/agenda` | local prod build | **97** | 95 | 0.9 s | 2.2 s | 150 ms | 0 | 2.2 s | 1135 ms¹ | 158 KiB |
| `/admin/speakers` | local prod build | **99** | **100** | 0.9 s | 1.6 s | 80 ms | 0 | 1.9 s | 960 ms¹ | 156 KiB |

Zero layout shift on every route, and every page ships under ~160 KiB total.

¹ **Read this before comparing TTFB columns.** The admin routes require an
authenticated session, and the production `SESSION_SECRET` is not available to
workers, so they were measured against a local `next start` build. Their TTFB is
therefore *worse* than production, not better: every request pays a cold
round trip from a laptop in North America to the shared Neon Postgres instance,
with no connection reuse. Production public routes measure 28–33 ms TTFB on the
same code. Treat the local admin numbers as an upper bound.

## What the numbers reflect

- **Server-rendered reads, no client data fetching.** Admin and portal screens
  query Prisma directly in server components (`lib/data/reads.ts`) instead of
  fetching this app's own HTTP API, which removes a full round trip and cookie
  forwarding per page.
- **Narrow client islands.** Interactivity is scoped to the components that need
  it (task checklist, profile form, agenda builder), which is why TBT stays at
  60–160 ms. `/admin/speakers` ships **no** client JavaScript — its filters are
  links, so it works with scripting disabled and every filter is URL-restorable.
- **Bounded queries.** Operator reads cap the rows they materialize
  (`lib/api/query-limits.ts`) instead of degrading silently as an event grows.

The one repeated opportunity Lighthouse reports is 29–48 KiB of unused
JavaScript in the shared framework chunk — the Next.js/React runtime baseline,
not application code.

## Accessibility findings

Fixed in this pass:

- `/admin/speakers` — filter links carried `aria-pressed`, which is not a valid
  attribute on an anchor (`aria-allowed-attr`, 4 nodes). They are links, not
  toggles, so the active filter is now marked with `aria-current="page"`.
  Route went 94 → **100**.

Known issues, logged not fixed (frontend-owned files; filed in coordination as
`requests/ops-a11y-frontend-findings.md`):

| Route | Audit | Detail |
| --- | --- | --- |
| `/embed/schedule` | `landmark-one-main` | The page has no `<main>` landmark. `components/embed-schedule.tsx:72` renders `<div className="embed-body">`; `components/embed-speakers.tsx:152` already uses `<main className="embed-body …">` and scores 100, so the fix is one element name. |
| `/admin/abstracts` | `color-contrast` | `.tab .count` badge: `#687276` on `#eef1f0` = **4.33:1** at 11 px, just under the 4.5:1 required for small text (`components/feature.css:40`). |
| `/admin/agenda` | `color-contrast` | White text on the agenda track colours: `#0ea5e9` = **2.77:1**, `#f59e0b` = **2.14:1**, `#6366f1` = 4.46:1 (7 nodes). The slot palette needs darker track colours, or dark text on the light ones. |

All other audited routes pass every automated check. Automated tooling is not a
complete accessibility review; no manual screen-reader pass was performed.

## Reproduce

```bash
# Public production routes
CHROME_PATH="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" \
npx lighthouse "https://greenroom-omega-dusky.vercel.app/embed/schedule?event=forward-2026" \
  --only-categories=performance,accessibility \
  --chrome-flags="--headless=new --no-sandbox" \
  --output=json --output-path=lighthouse-embed-schedule.json

# Authenticated admin routes: build, start a local server on an ops port, and
# pass a signed session cookie (see scripts/_signed-session.mjs).
npm run build && SESSION_SECRET=<smoke secret> npx next start -p 3235
npx lighthouse "http://127.0.0.1:3235/admin/speakers" \
  --only-categories=performance,accessibility \
  --chrome-flags="--headless=new --no-sandbox" \
  --extra-headers '{"Cookie":"sb_session=…"}' \
  --output=json --output-path=lighthouse-admin-speakers.json
```

Kill only the PID you spawned (`netstat -ano | findstr :3235`), never Node by
image name.
