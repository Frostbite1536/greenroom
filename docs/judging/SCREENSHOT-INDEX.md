# Screenshot index — current production evidence

The primary screenshot set for judging. Every row is captured from the deployed
application at one recorded commit, and every row carries the metadata needed to
reproduce or challenge it.

**Status: captured by automation from a LOCAL production build.** Every row
below now has a file and per-row metadata, produced by
[`e2e/screenshots.spec.ts`](../../e2e/screenshots.spec.ts)
(`npm run evidence:screenshots`). Read the provenance row in the contract below
before citing any of these as production evidence: they were taken against a
locally built production server on a **disposable** database, not against the
deployment. The final judged set is re-captured from the deployed commit by
running the same script against it.

## Capture contract

| Field | Value |
| --- | --- |
| Deployed commit | `<final>` — re-capture against the submitted SHA before judging |
| Capture source | **local `next build` + `next start`** on `http://127.0.0.1:3400`, disposable database, freshly `npm run db:seed`ed |
| Production URL | <https://greenroom-hq.com> (the surface these paths correspond to) |
| Capture owner | `e2e/screenshots.spec.ts` (automated) |
| Capture window (start–end, with timezone) | 2026-08-11T05:18:02Z – 2026-08-11T05:19:08Z |
| Viewport | 1440 × 900 unless a row says otherwise |
| Browser | headless Chromium via Playwright, fresh context per role |
| Machine-readable record | [`screenshots/capture-manifest.json`](screenshots/capture-manifest.json) — file, path, role, viewport, capture mode and timestamp for every shot |

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
- **What the automated run writes.** It reseeds, and it submits exactly one
  proposal through the public form so the email-history row has a real dispatch
  to show rather than an empty state. That is why it may only be pointed at a
  disposable database; the guard in `e2e/db-guard.ts` enforces it.
- **Capture mode.** Desktop rows are full-page captures at the stated viewport
  width, so content below 900px is still in the file. The four dialog rows (5,
  12, 13, 25) are viewport captures, because a modal is fixed-positioned and a
  full-page capture would strand it above a dimmed page.

## Shot list

Adapted from the evidence contract's suggested coverage to the surfaces that
exist at this commit. `Access` is the authenticated role or `logged out`;
`Mutation` is `read-only` or `coordinated mutation`.

| # | File | Surface | URL / path | Access | Mutation | Must be visible | Captured (ISO 8601 + TZ) | Viewport |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `login.png` | Sign-in | `/login` | logged out | read-only | credential form, the sign-up/reset roadmap note, and all three persona buttons | 2026-08-11T05:18:02Z | 1440 × 900 |
| 2 | `landing.png` | Public landing page | `/` | logged out | read-only | event name and dates, session/speaker/track metrics, open-CFP panel | 2026-08-11T05:18:06Z | 1440 × 900 |
| 3 | `public-cfp.png` | Public call for speakers | `/cfp/forward-2026/call-for-speakers` | logged out | read-only | topic selector, a custom question, the co-speaker block with its role field | 2026-08-11T05:18:08Z | 1440 × 900 |
| 4 | `event-settings.png` | Event settings + event creation | `/admin/settings` | ADMIN | read-only | event name/dates/timezone, rooms, groupings, and the **New event** button | 2026-08-11T05:18:23Z | 1440 × 900 |
| 5 | `new-event-dialog.png` | New event dialog | `/admin/settings` (dialog open) | ADMIN | read-only | name, web address with its `/cfp/{slug}` hint, timezone, optional dates | 2026-08-11T05:18:23Z | 1440 × 900 |
| 6 | `cfp-builder.png` | CFP form builder | `/admin/forms/[formId]` | ADMIN | read-only | question list, a conditional rule, the **Published** switch, live preview | 2026-08-11T05:18:26Z | 1440 × 900 |
| 7 | `admin-abstracts.png` | Submission pipeline | `/admin/abstracts` | ADMIN | read-only | filter chips, summary metrics, a selected proposal with its custom answers, **Export CSV** | 2026-08-11T05:18:31Z | 1440 × 900 |
| 8 | `evaluation-setup.png` | Review round setup | `/admin/evaluations` | ADMIN | read-only | rubric criteria with the `Weight … · …% of rubric weight` line, round window dates | 2026-08-11T05:18:36Z | 1440 × 900 |
| 9 | `evaluation-coverage.png` | Reviewer coverage | `/admin/evaluations` | ADMIN | read-only | the **Review coverage** table with a sorted column and its sort indicator | 2026-08-11T05:18:37Z | 1440 × 900 |
| 10 | `evaluator-workspace.png` | Reviewer workspace | `/admin/evaluations` | EVALUATOR | read-only | own queue with statuses, rubric scoring, running weighted score, **Declare a conflict** | 2026-08-11T05:19:00Z | 1440 × 900 |
| 11 | `agenda-day.png` | Agenda Day view + backlog | `/admin/agenda` | ADMIN | read-only | Day grid with room columns and the **Unscheduled backlog** strip | 2026-08-11T05:18:40Z | 1440 × 900 |
| 12 | `agenda-conflict-refusal.png` | Conflict refusal | `/admin/agenda` | ADMIN | coordinated mutation (refused write) | the server's refusal message naming what the placement collides with | 2026-08-11T05:18:42Z | 1440 × 900 |
| 13 | `agenda-fill-open-slots.png` | Assisted placement preview | `/admin/agenda` | ADMIN | read-only (preview saves nothing) | proposed placements, "could not be placed" list, **Apply**/**Discard** | 2026-08-11T05:18:43Z | 1440 × 900 |
| 14 | `speaker-portal.png` | Speaker portal | `/portal` | SPEAKER | read-only | profile completeness, confirmed sessions, the task checklist with due dates | 2026-08-11T05:19:05Z | 1440 × 900 |
| 15 | `speaker-task-form.png` | Form-carrying onboarding task | `/portal/tasks/[taskId]` | SPEAKER | read-only | a conditional question and the **Save and mark done** gate | 2026-08-11T05:19:08Z | 1440 × 900 |
| 16 | `admin-speakers.png` | Speaker readiness chase list | `/admin/speakers` | ADMIN | read-only | metrics row, per-speaker profile/task/next-due columns, overdue and status pills | 2026-08-11T05:18:47Z | 1440 × 900 |
| 17 | `admin-emails.png` | Email history | `/admin/emails` | ADMIN | read-only | per-row delivery status and outcome wording | 2026-08-11T05:18:50Z | 1440 × 900 |
| 18 | `public-schedule.png` | Public schedule | `/embed/schedule?event=forward-2026` | logged out | read-only | day tabs, search form, track filters, session details, topic/track/room chips | 2026-08-11T05:18:10Z | 1440 × 900 |
| 19 | `public-schedule-mobile.png` | Public schedule, narrow | `/embed/schedule?event=forward-2026` | logged out | read-only | the same page usable at phone width | 2026-08-11T05:18:14Z | 390 × 844 |
| 20 | `public-speakers.png` | Public speaker directory | `/embed/speakers?event=forward-2026` | logged out | read-only | headshots, an expanded full profile, session links | 2026-08-11T05:18:12Z | 1440 × 900 |
| 21 | `admin-embeds.png` | Embed configuration | `/admin/embeds` | ADMIN | read-only | both copyable `<iframe>` snippets and the direct links | 2026-08-11T05:18:52Z | 1440 × 900 |
| 22 | `admin-operations.png` | Decision mail preview gate | `/admin/operations` | ADMIN | read-only | **Send it** disabled until **Preview email** has run | 2026-08-11T05:18:55Z | 1440 × 900 |
| 23 | `public-cfp-participants.png` | Public call for speakers, Participants step | `/cfp/forward-2026/call-for-speakers` | logged out | read-only | the co-speaker block with its role field (row 3's third item — see the note below) | 2026-08-11T05:18:08Z | 1440 × 900 |
| 24 | `cfp-builder-settings.png` | CFP form builder, Form settings step | `/admin/forms/[formId]` | ADMIN | read-only | the **Published** switch, the submission window and the speaker limits (row 6's third item — see the note below) | 2026-08-11T05:18:26Z | 1440 × 900 |
| 25 | `admin-abstracts-drawer.png` | Submission pipeline, one proposal open | `/admin/abstracts` (drawer open) | ADMIN | read-only | the decision summary and score-by-criterion, the review notes, and the custom answers under their original question labels (row 7's third item — see the note below) | 2026-08-11T05:18:32Z | 1440 × 900 |
| 26 | `public-speakers-mobile.png` | Public speaker directory, narrow | `/embed/speakers?event=forward-2026` | logged out | read-only | the same page usable at phone width | 2026-08-11T05:18:17Z | 390 × 844 |
| 27 | `public-cfp-mobile.png` | Public call for speakers, narrow | `/cfp/forward-2026/call-for-speakers` | logged out | read-only | the same form usable at phone width | 2026-08-11T05:18:18Z | 390 × 844 |

Rows 12 and 13 are the safety evidence called for by the contract: a visible
server refusal, and an assisted placement that writes nothing until applied.
Row 12 is the only row that requires a write attempt — the write is *refused*,
so it leaves no residue, but capture it inside the announced window anyway.

**Rows 23–25 exist because three surfaces cannot show everything their row asks
for in one frame.** The public CFP form is a four-step wizard (its topic
selector and custom questions are on the *Submission* step, its co-speaker role
field on the *Participants* step); the CFP builder is stepped the same way (the
question list and live preview on *Form questions*, the **Published** switch on
*Form settings*); and the abstracts drawer opens over the pipeline table, so the
filter chips and **Export CSV** are in row 7's frame and the selected proposal's
answers are in row 25's. Nothing is missing from the set — it takes two files
instead of one. Rows 26–27 are the responsive evidence for the other two public
surfaces, matching row 19.

Two honest gaps in what the automated set could produce, both properties of the
seeded data rather than of the capture:

- **Row 13** shows the proposed placements and **Apply**/**Discard**, but no
  "could not be placed" list — with the seeded backlog every talk *can* be
  placed, so that list is legitimately empty. A shot of it requires a backlog
  the scheduler cannot satisfy.
- **Row 17** shows one row, the submission receipt the capture run itself
  generated. It is a real dispatch with a truthful `Mocked — not delivered`
  status, because this deployment runs in mock mode; it is not a picture of a
  busy log.

## Capture procedure

The whole set is scripted. From the repository root:

```powershell
npm run build                                   # the suites drive `next start`
$env:E2E_EXPECTED_DB = "<substring of the DISPOSABLE DATABASE_URL host>"
npm run evidence:screenshots
```

Every row above is captured in one pass, into `screenshots/`, with
`capture-manifest.json` written beside them. The script reseeds first, signs in
as the persona each row's `Access` column names using a fresh browser context
per role (so "logged out" really means a context that never held a session), and
drives the dialog and refusal rows through the real UI rather than staging them.

It refuses to run unless `E2E_EXPECTED_DB` matches the `DATABASE_URL` it
resolves and the target is loopback — see
[`e2e/README.md`](../../e2e/README.md). Do not point it at production or the
shared demo database.

### Manual fallback (capturing against the deployment)

Public, logged-out rows also reproduce by hand from a clean profile with no
session. Run from the repository root and pass `--screenshot` an **absolute**
path:

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

Four PNGs previously in [`screenshots/`](screenshots/) — `login.png`,
`public-cfp.png`, `public-schedule.png`, `public-speakers.png` — were
**historical**. They were captured on **2026-08-08** from the then-canonical
Vercel deployment `https://greenroom-omega-dusky.vercel.app`, before the
canonical-domain cutover and before the Cycle 5 work (landing page, enriched
embeds, credential login, event-scoped CFP URLs) landed.

**They have now been replaced** at those same four filenames by the automated
capture recorded in the table above (rows 1, 3, 18, 20). The per-row metadata in
that table is the record for each file, and this paragraph is the record of what
was replaced. The pre-Cycle-5 originals are recoverable from git history if
anyone needs to compare.

## Related evidence

- [`VIDEO-SCRIPT.md`](VIDEO-SCRIPT.md) — the walkthrough these shots support,
  recorded at the same commit.
- [`README.md`](README.md) — the judging index, the product narrative, and the
  current limitations list.
- [`PERFORMANCE.md`](PERFORMANCE.md) — Lighthouse results, labeled historical.
