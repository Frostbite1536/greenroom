# Screenshot index — current production evidence

The primary screenshot set for judging. Every row is captured from the deployed
application at one recorded commit, and every row carries the metadata needed to
reproduce or challenge it.

**Status: template awaiting capture.** The shot list, the required metadata
fields, and the capture procedure below are fixed. The per-row values marked
*fill in* are completed by the single capture owner during the coordinated
window — no row may be filled in from memory.

## Capture contract

| Field | Value |
| --- | --- |
| Deployed commit | `9e058f3560a398352bbd48277ef80cb16e8550dc` |
| Production URL | <https://greenroom-hq.com> |
| Capture owner | *fill in* |
| Capture window (start–end, with timezone) | *fill in* |
| Viewport | 1440 × 1000 unless a row says otherwise |
| Browser | headless Microsoft Edge (Chromium), fresh temporary profile |

Rules for this set:

- **One commit.** If the deployment moves mid-capture, discard the set and start
  again. Artifacts describing two commits are not evidence.
- **Read-only by default.** A row is `read-only` unless it required a write, in
  which case it is `coordinated mutation` and must fall inside an
  Architect-announced write window.
- **Role or logged out** is recorded explicitly on every row. "Logged out" means
  a browser profile that never held a session, not a signed-out tab.
- **No secrets on screen.** No API key, bearer token, password field contents,
  session cookie, or non-persona address. The three demo personas
  (`maya@`, `ravi@`, `sofia@greenroom-hq.com`) are the documented demo
  identities and may appear.
- Files land in `screenshots/` beside this file, named exactly as the table says.

## Shot list

Adapted from the evidence contract's suggested coverage to the surfaces that
exist at this commit. `Access` is the authenticated role or `logged out`;
`Mutation` is `read-only` or `coordinated mutation`.

| # | File | Surface | URL / path | Access | Mutation | Must be visible | Captured (ISO 8601 + TZ) | Viewport |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `login.png` | Sign-in | `/login` | logged out | read-only | credential form, the sign-up/reset roadmap note, and all three persona buttons | *fill in* | 1440 × 1000 |
| 2 | `landing.png` | Public landing page | `/` | logged out | read-only | event name and dates, session/speaker/track metrics, open-CFP panel | *fill in* | 1440 × 1000 |
| 3 | `public-cfp.png` | Public call for speakers | `/cfp/forward-2026/call-for-speakers` | logged out | read-only | topic selector, a custom question, the co-speaker block with its role field | *fill in* | 1440 × 1000 |
| 4 | `event-settings.png` | Event settings + event creation | `/admin/settings` | ADMIN | read-only | event name/dates/timezone, rooms, groupings, and the **New event** button | *fill in* | 1440 × 1000 |
| 5 | `new-event-dialog.png` | New event dialog | `/admin/settings` (dialog open) | ADMIN | read-only | name, web address with its `/cfp/{slug}` hint, timezone, optional dates | *fill in* | 1440 × 1000 |
| 6 | `cfp-builder.png` | CFP form builder | `/admin/forms/[formId]` | ADMIN | read-only | question list, a conditional rule, the **Published** switch, live preview | *fill in* | 1440 × 1000 |
| 7 | `admin-abstracts.png` | Submission pipeline | `/admin/abstracts` | ADMIN | read-only | filter chips, summary metrics, a selected proposal with its custom answers, **Export CSV** | *fill in* | 1440 × 1000 |
| 8 | `evaluation-setup.png` | Review round setup | `/admin/evaluations` | ADMIN | read-only | rubric criteria with the `Weight … · …% of rubric weight` line, round window dates | *fill in* | 1440 × 1000 |
| 9 | `evaluation-coverage.png` | Reviewer coverage | `/admin/evaluations` | ADMIN | read-only | the **Review coverage** table with a sorted column and its sort indicator | *fill in* | 1440 × 1000 |
| 10 | `evaluator-workspace.png` | Reviewer workspace | `/admin/evaluations` | EVALUATOR | read-only | own queue with statuses, rubric scoring, running weighted score, **Declare a conflict** | *fill in* | 1440 × 1000 |
| 11 | `agenda-day.png` | Agenda Day view + backlog | `/admin/agenda` | ADMIN | read-only | Day grid with room columns and the **Unscheduled backlog** strip | *fill in* | 1440 × 1000 |
| 12 | `agenda-conflict-refusal.png` | Conflict refusal | `/admin/agenda` | ADMIN | coordinated mutation (refused write) | the server's refusal message naming what the placement collides with | *fill in* | 1440 × 1000 |
| 13 | `agenda-fill-open-slots.png` | Assisted placement preview | `/admin/agenda` | ADMIN | read-only (preview saves nothing) | proposed placements, "could not be placed" list, **Apply**/**Discard** | *fill in* | 1440 × 1000 |
| 14 | `speaker-portal.png` | Speaker portal | `/portal` | SPEAKER | read-only | profile completeness, confirmed sessions, the task checklist with due dates | *fill in* | 1440 × 1000 |
| 15 | `speaker-task-form.png` | Form-carrying onboarding task | `/portal/tasks/[taskId]` | SPEAKER | read-only | a conditional question and the **Save and mark done** gate | *fill in* | 1440 × 1000 |
| 16 | `admin-speakers.png` | Speaker readiness chase list | `/admin/speakers` | ADMIN | read-only | metrics row, per-speaker profile/task/next-due columns, overdue and status pills | *fill in* | 1440 × 1000 |
| 17 | `admin-emails.png` | Email history | `/admin/emails` | ADMIN | read-only | per-row delivery status and outcome wording | *fill in* | 1440 × 1000 |
| 18 | `public-schedule.png` | Public schedule | `/embed/schedule?event=forward-2026` | logged out | read-only | day tabs, search form, track filters, session details, topic/track/room chips | *fill in* | 1440 × 1000 |
| 19 | `public-schedule-mobile.png` | Public schedule, narrow | `/embed/schedule?event=forward-2026` | logged out | read-only | the same page usable at phone width | *fill in* | 390 × 844 |
| 20 | `public-speakers.png` | Public speaker directory | `/embed/speakers?event=forward-2026` | logged out | read-only | headshots, an expanded full profile, session links | *fill in* | 1440 × 1000 |
| 21 | `admin-embeds.png` | Embed configuration | `/admin/embeds` | ADMIN | read-only | both copyable `<iframe>` snippets and the direct links | *fill in* | 1440 × 1000 |
| 22 | `admin-operations.png` | Decision mail preview gate | `/admin/operations` | ADMIN | read-only | **Send it** disabled until **Preview email** has run | *fill in* | 1440 × 1000 |

Rows 12 and 13 are the safety evidence called for by the contract: a visible
server refusal, and an assisted placement that writes nothing until applied.
Row 12 is the only row that requires a write attempt — the write is *refused*,
so it leaves no residue, but capture it inside the announced window anyway.

## Capture procedure

Public, logged-out rows reproduce from a clean profile with no session. Run from
the repository root and pass `--screenshot` an **absolute** path:

```powershell
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path ([System.IO.Path]::GetTempPath()) ("greenroom-edge-" + [guid]::NewGuid().ToString('N'))
$url = 'https://greenroom-hq.com/embed/schedule?event=forward-2026'
$output = Join-Path (Get-Location) 'docs\judging\screenshots\public-schedule.png'

New-Item -ItemType Directory -Path $profile | Out-Null
& $edge --headless=new --disable-gpu --no-first-run --hide-scrollbars `
  --run-all-compositor-stages-before-draw --virtual-time-budget=5000 `
  "--user-data-dir=$profile" --window-size=1440,1000 "--screenshot=$output" $url
```

Two traps worth knowing: Edge prints a `… bytes written to file <path>` line on
success — if you do not see it, nothing was captured. And a relative or mangled
`--screenshot` path silently writes somewhere else rather than failing.

Authenticated rows (4–17, 21, 22) need a real session, so capture them by hand
in a clean interactive profile: sign in with the persona named in the `Access`
column, size the window to the recorded viewport, and use the browser's own
capture. Record the wall-clock time with its timezone offset as you go.

Before committing any PNG, open it and confirm it shows the intended page — not
a deployment-authentication screen, an error state, or a stale tab — and that no
secret is on screen.

## Historical screenshots

The four PNGs currently in [`screenshots/`](screenshots/) — `login.png`,
`public-cfp.png`, `public-schedule.png`, `public-speakers.png` — are
**historical**. They were captured on **2026-08-08** from the then-canonical
Vercel deployment `https://greenroom-omega-dusky.vercel.app`, before the
canonical-domain cutover and before the Cycle 5 work (landing page, enriched
embeds, credential login, event-scoped CFP URLs) landed. They are not fresh
captures of the current domain and must not be presented as current evidence.

When the rows above are captured, the new files replace them at the same
filenames where the names collide (1, 3, 18, 20); the per-row metadata in this
table is then the record for each file, and the paragraph above becomes the
record of what was replaced.

## Related evidence

- [`VIDEO-SCRIPT.md`](VIDEO-SCRIPT.md) — the walkthrough these shots support,
  recorded at the same commit.
- [`README.md`](README.md) — the judging index, the product narrative, and the
  current limitations list.
- [`PERFORMANCE.md`](PERFORMANCE.md) — Lighthouse results, labeled historical.
