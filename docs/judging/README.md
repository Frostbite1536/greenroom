# Public production screenshots

## Current demo and evidence scope

The current canonical demo is <https://greenroom-hq.com>. The screenshots and
measurements below are retained as **historical evidence**: they were captured
on 2026-08-08 from the then-canonical Vercel deployment, whose URL is recorded
with each artifact. They are not represented as fresh captures of the current
domain. A consolidated post-reseed window owns replacement screenshots.

Captured at a **1440 × 1000** viewport with headless Microsoft Edge and a fresh
temporary browser profile. Each capture is public and read-only; no
authenticated session, mutation, reset, or seed was used.

| File | Public URL | Captured |
| --- | --- | --- |
| [screenshots/login.png](screenshots/login.png) | <https://greenroom-omega-dusky.vercel.app/login> | 2026-08-08T07:19-05:00 |
| [screenshots/public-cfp.png](screenshots/public-cfp.png) | <https://greenroom-omega-dusky.vercel.app/cfp/call-for-speakers> | 2026-08-08T07:19-05:00 |
| [screenshots/public-schedule.png](screenshots/public-schedule.png) | <https://greenroom-omega-dusky.vercel.app/embed/schedule?event=forward-2026> | **2026-08-08T13:50-05:00** |
| [screenshots/public-speakers.png](screenshots/public-speakers.png) | <https://greenroom-omega-dusky.vercel.app/embed/speakers?event=forward-2026> | **2026-08-08T13:50-05:00** |

The schedule and speakers captures were retaken after the A3 production
walkthrough and coordinated reseed, so they show the **then-final** demo data: 11
sessions across May 12–14 2026 with correct event-local times, and the 10
scheduled speakers with their session links.

## Clean-install rehearsal

[INSTALL-REHEARSAL.md](INSTALL-REHEARSAL.md) documents a from-scratch install on
an empty database — fresh clone → seeded, running instance in under four minutes,
with the golden path passing 20/20 and 108/108 unit tests plus a 71/71 smoke on
that brand-new instance.

## Measured performance and accessibility

[PERFORMANCE.md](PERFORMANCE.md) records Lighthouse scores for **ten routes**
covering all four user journeys: **95–99 performance, 100 accessibility on every
route**, zero layout shift everywhere, 28–33 ms production TTFB, and every page
under ~180 KiB. It also lists the four accessibility issues found in the first
pass and the fix that closed each one.

## Beyond the minimum

The required workflow is intentionally small: collect a proposal, route and
review it, accept it, onboard the speakers, schedule it safely, and publish the
programme. The following capabilities are already in the merged application;
they are not placeholders or planned work.

- **Evaluation depth.** Admins can create weighted rubric rounds, assign
  reviewers, and opt a round into blind review. Blind reviewer surfaces withhold
  speaker profiles, while making the important limitation explicit: proposal
  text can still identify its author.
- **Operations control room.** The ADMIN-only Operations area groups reminder
  sends, CSV import, email-template previews, and integration status instead of
  leaving operators to call endpoints directly.
- **Enforced form rules.** Conditional questions, typed answers, submission
  limits, and open/close windows are checked on the server; a hidden required
  question does not block a valid submitter.
- **Speaker operations.** The portal includes resources and form-carrying
  onboarding tasks. Completion is gated on the visible required answers, not a
  checkbox alone.
- **Programme tooling.** List, Day, Week, Tracks, and Conflicts agenda views
  complement conflict-safe scheduling. The deterministic demo also includes a
  source-less guaranteed keynote; direct UI creation of that special session is
  not claimed here.
- **Integration surfaces.** The key-gated, read-only v1 API exposes submissions,
  speakers, and schedule data. The Airtable mirror projects confirmed programme
  data into upserted Sessions, Speakers, and Schedule tables, with per-table
  repair reporting and no delete operation.

The Greenroom Assistant is intentionally absent from this list: it is not in
the current merged tree and should be documented only after it lands.

## Product decision: one track per submission

A CFP form can offer several track options, but each submitted abstract stores
one selected category/track. This is a deliberate product call, not an
unadvertised many-to-many capability: it keeps reviewer routing and programme
placement unambiguous. The organizer clarification recorded in
`REQUIREMENTS-AUDIT-2026-08-08.md`, Partials #5, line 116 — “single form w one
or more track options is great” — supports the form design. It does not change
the fact that a single submission has one chosen track.

## Reimbursement evidence

[COSTS.md](COSTS.md) separates the private subscription proof needed for a
reimbursement claim from transparent token telemetry. Its dollar figures are
API-equivalent estimates, not invoices, and must be refreshed at submission
freeze.

## Reproduce

Run this PowerShell template from the repository root for any of the URLs above.
It uses a unique temporary Edge profile so it cannot reuse a signed-in browser
session.

```powershell
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path ([System.IO.Path]::GetTempPath()) ("greenroom-edge-" + [guid]::NewGuid().ToString('N'))
$url = 'https://greenroom-hq.com/embed/schedule?event=forward-2026'
$output = 'docs\judging\screenshots\public-schedule.png'

New-Item -ItemType Directory -Path $profile | Out-Null
& $edge --headless=new --disable-gpu --no-first-run --hide-scrollbars `
  --run-all-compositor-stages-before-draw --virtual-time-budget=5000 `
  "--user-data-dir=$profile" --window-size=1440,1000 "--screenshot=$output" $url
```

After Edge exits, inspect the generated PNG before replacing a committed
artifact. The output should show the public page, not a deployment-authentication
or error screen.

Two traps worth knowing: Edge prints a `… bytes written to file <path>` line on
success — if you do not see it, nothing was captured. And pass `--screenshot` an
**absolute** path; a mangled or relative path silently writes somewhere else
rather than failing.

## Walkthrough video

[VIDEO-SCRIPT.md](VIDEO-SCRIPT.md) is the shot list and narration for the
recorded walkthrough: the golden path end to end, the logged-out `/embed/*`
proof, the `.ics` download, and the public API with and without a key.
