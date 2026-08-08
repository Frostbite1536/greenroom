# Public production screenshots

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
walkthrough and coordinated reseed, so they show **final** demo data: 11
sessions across May 12–14 2026 with correct event-local times, and the 10
scheduled speakers with their session links.

## Clean-install rehearsal

[INSTALL-REHEARSAL.md](INSTALL-REHEARSAL.md) documents a from-scratch install on
an empty database — fresh clone → seeded, running instance in under four minutes,
with the golden path passing 20/20 and 108/108 unit tests plus a 71/71 smoke on
that brand-new instance.

## Measured performance and accessibility

[PERFORMANCE.md](PERFORMANCE.md) records Lighthouse performance and
accessibility scores for the seven hottest routes (96–99 performance, 95–100
accessibility, zero layout shift, 28–33 ms production TTFB), plus the
accessibility issues that remain open.

## Reproduce

Run this PowerShell template from the repository root for any of the URLs above.
It uses a unique temporary Edge profile so it cannot reuse a signed-in browser
session.

```powershell
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path ([System.IO.Path]::GetTempPath()) ("greenroom-edge-" + [guid]::NewGuid().ToString('N'))
$url = 'https://greenroom-omega-dusky.vercel.app/embed/schedule?event=forward-2026'
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
