# Public production screenshots

Captured **2026-08-08T07:19:21-05:00** at a **1440 × 1000** viewport with
headless Microsoft Edge and a fresh temporary browser profile. Each capture is
public and read-only; no authenticated session, mutation, reset, or seed was
used.

> The schedule image reflects the currently deployed seed before local timezone
> correction `46e3885`. Recapture it after that change is deployed and the demo
> event is reset through the coordinated single-writer path.

| File | Public URL |
| --- | --- |
| [screenshots/login.png](screenshots/login.png) | <https://greenroom-omega-dusky.vercel.app/login> |
| [screenshots/public-cfp.png](screenshots/public-cfp.png) | <https://greenroom-omega-dusky.vercel.app/cfp/call-for-speakers> |
| [screenshots/public-schedule.png](screenshots/public-schedule.png) | <https://greenroom-omega-dusky.vercel.app/embed/schedule?event=forward-2026> |

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
