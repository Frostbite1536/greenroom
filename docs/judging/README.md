# Evaluation index

> Greenroom is an open-source, self-hostable conference program platform that
> takes an organizer from an open CFP through structured review, atomic
> acceptance, speaker readiness, conflict-safe scheduling, and a published
> program.

**Deployed application:** <https://greenroom-hq.com>
**Current deployed commit:** `8b2a1cf0b7aa95185a8a530e6e0adce8405fe0d0`

**Captured evidence product commit:** `7f34b6ec14005f4e185722b09d894342da52383c`

**Evidence tooling/artifact commit:** `db00ff88bcba043d13aba76daa7876e112e49c29`

Every primary screenshot, walkthrough, rehearsal, and golden-path artifact in
this directory describes the captured evidence product commit. Those artifacts
are preserved rather than relabeled. The current deployment adds only the
reviewed, additive PR #100 tranche described in
[Post-release deployment provenance](#post-release-deployment-provenance); its
separate receipts do not imply that the earlier screenshots depict those new
surfaces. Anything measured or captured on an older build remains labeled
**historical** and is not presented as current evidence.

## Start here

| Artifact | What it is |
| --- | --- |
| [PROCESS.md](PROCESS.md) | How this was built: the two-track adversarial review, the gate stack and why it is ordered that way, evidence provenance, and per-pattern `file:line`/test receipts an auditor can check |
| [VIDEO-SCRIPT.md](VIDEO-SCRIPT.md) | Shot list and narration for the walkthrough video: the full operating loop, one deliberate conflict refusal, and the greenfield event/CFP proof |
| [SCREENSHOT-INDEX.md](SCREENSHOT-INDEX.md) | The current screenshot set, organized by role and workflow, with per-artifact commit, URL, timestamp, viewport, access role, and read-only/mutation status |
| [WORKFLOW-ROUTES.md](WORKFLOW-ROUTES.md) | Current shipped workflow-to-route map for admins, evaluators, speakers, and the public, linked to the applicable evidence rows |
| [INSTALL-REHEARSAL.md](INSTALL-REHEARSAL.md) | Historical rehearsal at `f80247e`, plus the final-product clean-worktree/empty-database rehearsal at `7f34b6e` |
| [PERFORMANCE.md](PERFORMANCE.md) | Lighthouse performance and accessibility results for ten routes (**historical** — measured 2026-08-08 on the pre-cutover deployment) |
| [A3-PRODUCTION-WALKTHROUGH.md](A3-PRODUCTION-WALKTHROUGH.md) | An authenticated production verification receipt, 14/14 (**historical** — recorded at `0bb4aad`) |
| [COSTS.md](COSTS.md) | Reimbursement claim structure and token telemetry (estimates, not invoices) |
| [embed-schedule-proof.html](embed-schedule-proof.html) | Standalone page proving the schedule embed works from a foreign origin |

Written guides for the three roles live in [`../guides/`](../guides/):
[event admin](../guides/event-admin.md) · [evaluator](../guides/evaluator.md) ·
[speaker](../guides/speaker.md).

Developer-facing documents: [`../ARCHITECTURE.md`](../ARCHITECTURE.md) (product
boundary, domain model, routes, security), [`../INVARIANTS.md`](../INVARIANTS.md)
(the rules the server enforces), [`../LIFECYCLE.md`](../LIFECYCLE.md),
[`../API.md`](../API.md), [`../DEPLOY.md`](../DEPLOY.md).

## Proof points

- Conventional **Next.js, TypeScript, PostgreSQL, and Prisma** stack — no exotic
  infrastructure to evaluate.
- **Reproducible setup with one required database variable.** `DATABASE_URL` is
  the only value a local install must set; a production deployment additionally
  needs `SESSION_SECRET`, and fails closed without it.
- **Deterministic demo data and one-click role personas** — the same seed
  produces the same 40 proposals, 13 sessions, and 11 placements every time.
- **Event-scoped authorization resolved from persisted membership.** The signed
  cookie identifies an email and an active event; it never carries a role. Every
  protected read and write re-resolves the `EventMember` row server-side
  (`lib/api/context.ts`, INV-EVENT-001).
- **Transactional acceptance and scheduling rules.** Acceptance provisions at
  most one session plus its onboarding assignments in one transaction; room and
  speaker overlaps are detected and refused inside the transaction that would
  write the slot (INV-DOMAIN-001, INV-SCHEDULE-001).
- **Speaker onboarding with form-backed tasks.** A form-carrying task cannot be
  completed until its visible required answers pass the same validator the
  public form uses (INV-TASK-001).
- **Public schedule and speaker surfaces, embeds, calendar export, and a
  read-only API** — all reachable without an account, except the API, which is
  key-gated and refuses every uncredentialed request by default.
- **Explicit verification, accessibility, and performance evidence**, each
  labeled with what was measured and on which commit.

## Verification receipts

Run these from a checked-out repository. `prod-verify.mjs` is read-only: it needs
the configured read-only database connection to discover a live published form,
confirms production reset stays refused, and never seeds or resets data.

```bash
npm test
npm run typecheck
npm run build
node --env-file=.env scripts/_frontend-smoke.mjs
node scripts/prod-verify.mjs https://greenroom-hq.com
```

Recorded results for the captured evidence product are from its coordinated
evidence window:

| Gate | Commit | Result | Recorded |
| --- | --- | --- | --- |
| `npm test` | `7f34b6e` + evidence-tool fix `b312ac1` | **1,939 pass / 0 fail / 5 gated skips** | 2026-08-11 CDT |
| `npm run typecheck` + E2E typecheck | `7f34b6e` + evidence-tool fix `b312ac1` | **pass** | 2026-08-11 CDT |
| fresh `npm run build` | `7f34b6e` | **pass**, Next 16.3.0 | 2026-08-11 CDT |
| backend / frontend smokes | `fe9cae0` product tree | **441/441 + 591/591** | 2026-08-11 CDT |
| clean-install rehearsal | product `7f34b6e`, harness `b312ac1` | **20/20** | 2026-08-11 CDT |
| screenshot capture | product `7f34b6e`, artifacts `db00ff8` | **27 files; 5/5 Playwright cases** | 2026-08-11 CDT |
| golden-path E2E, run 1 + run 2 | product `7f34b6e`, harness `db00ff8` | **1/1 + 1/1** | 2026-08-11 CDT |
| `scripts/prod-verify.mjs` | deployed `7f34b6e` | **5/5** | 2026-08-11 CDT |

### Post-release deployment provenance

Production now serves merge `8b2a1cf`, whose first parent is the prior deployed
evidence closure `53bddcf` and whose second parent is reviewed PR #100 head
`e259d5a`. Relative to the captured product tree, the later release history adds
the final evidence tooling and artifact closure documented above and then PR
#100's additive scoped v1 reads, bounded submission-pacing report, and
dirty-form-safe speaker-roster refresh. It does not rewrite or invalidate the
27 screenshots, the clean-install receipt, or the twice-run golden-path
evidence; those remain truthfully attributed to `7f34b6e`.

| Post-release gate | Tested/reviewed commit | Result | Recorded |
| --- | --- | --- | --- |
| `npm test` | reviewed `e259d5a` | **1,960 pass / 0 fail / 5 gated skips** | 2026-08-12 CDT |
| app + E2E typechecks and fresh build | reviewed `e259d5a` | **pass**, Next 16.3.0 | 2026-08-12 CDT |
| backend / frontend smokes | reviewed `e259d5a` | **446/446 + 594/594** | 2026-08-12 CDT |
| focused Chromium proof | reviewed `e259d5a` | **2/2**, including 390px and dirty-draft preservation | 2026-08-12 CDT |
| external review | reviewed `e259d5a` | **Greptile 5/5**, no remaining finding | 2026-08-12 CDT |
| deployment + bounded production GET verification | deployed `8b2a1cf` | **success** | 2026-08-12 CDT |

The frontend smoke creates and removes only its own `scratch-frontend` event.
[A3-PRODUCTION-WALKTHROUGH.md](A3-PRODUCTION-WALKTHROUGH.md) and
[INSTALL-REHEARSAL.md](INSTALL-REHEARSAL.md) preserves the earlier receipt and
adds the final-product run as a separate section.

## Enforced rules you can check

These are server-enforced, not UI conventions. The walkthrough video captures the
first one on camera; the rest are covered by the automated suites and the
invariant references in [`../INVARIANTS.md`](../INVARIANTS.md).

- A room overlap is refused, and so is a speaker double-booking — detection and
  the slot write share one transaction.
- Acceptance provisions **at most one** session per proposal and never
  duplicates onboarding assignments; repeating it tops up what is missing.
- A form-carrying onboarding task cannot be marked complete while a visible
  required answer is missing or invalid.
- An accepted proposal's text stays editable by its speaker, while the confirmed
  speaker roster is locked.
- Cross-event access fails closed: a resource belonging to another event is
  refused rather than filtered.
- Demo reset is refused unless an operator explicitly opts in with
  `ALLOW_DEMO_RESET=true` — it is not set in production, and there is no reset
  control anywhere in the UI.
- The read-only API refuses any request without an accepted key with `401`. Two
  kinds reach it: a deployment-wide key the operator sets, and per-event keys an
  organizer issues and revokes, each reaching only its own event. A deployment
  with neither configured accepts nothing rather than serving data openly.

## Current limitations

Stated plainly, because an evaluator should not have to discover them.

- **A new self-service account starts outside every event.** Sign-up (`/signup`)
  and password reset (`/forgot`, a signed single-use link that expires in 30
  minutes) are both public. What sign-up does not do is grant membership: a new
  account holds no `EventMember` row, so it lands on `/welcome` to create its own
  event or wait for an organizer to add its address.
- **Event switching is bounded by your own memberships.** An admin can create a new
  event from **Event settings** and switch straight into it from the success notice.
  The sidebar switcher lists every event you hold an `EventMember` row on, and your
  role is re-resolved per event, so the same person can be an admin on one and a
  speaker on another. What is *not* there: no way to join an event you were not
  added to, and no cross-event view — every screen still shows exactly one event.
- **Proposal attachments are portal-only, and private to their uploader.** A
  signed-in speaker can attach up to three PDF supporting documents (≤5 MiB
  each) to their own proposal while it is still editable, through the same
  upload pipeline as headshots and decks. Two limits an evaluator should know:
  the **anonymous public CFP form takes no attachment at all** — a document can
  only be added afterwards, from the portal — and the bytes are readable by the
  uploader and this event's organizers only, so a **co-speaker on a shared
  proposal sees that a document exists but cannot open it**. Each row says so
  rather than offering a link that would fail. Removing an attachment removes
  the link, not the stored bytes; there is no reaper for orphaned uploads.
- **A speaker's slide deck is now per event, with the old global one as the
  fallback.** The portal writes a deck for the event you are signed in to, and
  the organizer roster shows it with its source named ("This event" or "Global
  profile (fallback)"). The global `SpeakerProfile.slideDeckUrl` is unchanged
  and still editable — it is what every event without its own association
  resolves to. What is **not** per-event yet: the read-only v1 API's
  `profile.slideDeckUrl` still reports only the global value. Widening that
  published response is a separately versioned API-contract change.
- **One topic per submission, by design.** A CFP form can offer several topic
  options, but each submitted proposal stores exactly one selected topic, which
  is what routes it to a review team. The agenda `Track` is a separate placement
  choice made later, not the submitted topic.
- **Email delivery is split on purpose.** Submission receipts dispatch on the
  live provider path when one is configured. Decision mail is preview-gated: the
  send button stays disabled until the exact content has been previewed, and the
  send is bound to that content and recipient set.
- **The read-only v1 API refuses every uncredentialed request.** It accepts the
  deployment-wide `GREENROOM_API_KEY` or an ADMIN-issued, revocable per-event
  `grk_...` key. A fresh install has neither and returns the same 401 without
  serving program data.
- **Accessibility evidence is automated plus one partial manual pass.** Every
  audited route scored 100 on Lighthouse accessibility at the recorded
  measurement, and the three admin modal overlays now use the native `<dialog>`
  focus model. A manual NVDA + Brave pass was run on production on 2026-08-12
  and covered three of ten planned journeys: journey 1 (sign-in through to the
  admin dashboard) passed 6 of 6; journey 2 (admin shell landmarks and
  navigation) passed CP2.1–CP2.2 and CP2.4–CP2.7, with CP2.3 a minor FAIL
  because reaching the main landmark took 6 `D` presses against a threshold of
  5 or fewer; journey 3 passed CP3.1–CP3.7 with CP3.8 not confirmed and CP3.9
  not run; journeys 4–10 were not run. The CP2.3 cause is that the application
  ships no skip link on any route, so landmarks are the only bypass. No
  VoiceOver, JAWS, mobile screen reader, or braille testing, and this is not a
  WCAG conformance audit. The gap is narrowed, not closed —
  see [PERFORMANCE.md](PERFORMANCE.md#manual-screen-reader-pass--partial).
- **The Greenroom Assistant is optional and advisory.** Without a configured
  provider, deterministic resource templates, sanitized preview, manual HTML,
  save/publish, manual decision notes, preview, and send continue to work. With
  a provider, only the bounded fields disclosed beside each action are sent;
  generated results remain separate suggestions until an administrator applies
  them. The assistant has no tools, memory, automatic save/publish/send, or
  proposal-evaluation authority.
- **The demo deployment intentionally hands out admin.** The one-click personas
  are the evaluation entry point, so any visitor can become the seeded event's
  admin — including its operations console, whose live-send buttons work when
  real provider credentials are configured. Every identity and address in the
  deployment is a fixture (`@greenroom-hq.com` routes to the operator), so the
  blast radius is the demo itself. Any other production deployment is fail-closed:
  the personas require `DEMO_PERSONA_LOGIN_ENABLED=true` exactly, and the refusal
  lives in the server action rather than in whether the buttons render.
- **Two external code audits were commissioned and triaged.**
  Confirmed defects were fixed and regression-tested (conflict-identity forgery,
  unlocked unschedule, far-east timezone day labels, unpublished-session leaks
  into integrations, cross-event reset authority, missing route boundaries,
  modal focus management). The remaining accepted findings are recorded here as
  roadmap, not hidden: schema changes apply via audited `db push` windows rather
  than versioned migrations; email and Airtable delivery run serially in-request
  (fine at demo scale, an outbox at real scale); the v1 API exposes three bounded
  collection reads plus a keyed submission read and does not provide a public
  demo credential;
  route-aware `nosniff`, HSTS, referrer, permissions, and frame-ancestor
  headers are set; a full script/style/default/connect CSP is not; admin profile
  edits use last-write-wins rather than version checks.

## Beyond the minimum

The required workflow is intentionally small: collect a proposal, route and
review it, accept it, onboard the speakers, schedule it safely, and publish the
program. The following are already in the merged application — not
placeholders, not planned work.

- **Evaluation depth.** Weighted rubric rounds with each criterion's share of
  the total rubric shown as a percentage, optional open/close dates per round,
  reviewer coverage that sorts by whichever column the team is chasing, a
  reviewer's own conflict declaration, and optional blind rounds that withhold
  speaker profiles server-side while stating plainly that proposal text can
  still identify its author.
- **Operations control room.** An ADMIN-only area grouping reminder sends, CSV
  import, email-template previews, the preview-gated decision send, and
  integration status, plus a separate **Email history** panel that reports each
  dispatch's real outcome — including "mocked, not delivered".
- **Enforced form rules.** Conditional questions, typed answers, submission
  limits, and open/close windows are all checked on the server; a hidden
  required question never blocks a valid submitter. After the call closes,
  non-accepted proposals become read-only while accepted ones stay editable —
  and withdrawal is never blocked by the deadline.
- **Speaker operations.** Resources and form-carrying onboarding tasks with per-
  task due dates, an overdue count, and a readiness chase list on the admin side.
- **Program tooling.** List, Day (rooms), Week, Track grid, Tracks, and
  Conflicts agenda views — the schedule is readable by list, by day, by week, by
  track, and by room;
  drag-and-drop moves re-checked on the server; an assisted **Fill open slots**
  pass that previews conflict-free placements and writes nothing until applied;
  and per-session publication control, so a confirmed talk can be held back from
  the public program without losing its slot, speakers, or tasks. The
  deterministic demo also includes a source-less guaranteed keynote — the
  opening keynote, Grand Ballroom, 09:00 on 12 May — and organizers can now
  create the same kind of draft session directly from the agenda. The seeded
  program itself is conflict-free across all three
  event days and the Conflicts view reads zero: the walkthrough demonstrates a
  refusal live, which is stronger proof than shipping a standing mistake to
  point at.
- **Integration surfaces.** The key-gated, read-only v1 API exposes submissions,
  speakers, and schedule data. The Airtable mirror projects confirmed program
  data into upserted Sessions, Speakers, and Schedule tables, with per-table
  repair reporting and no delete operation.

## Reimbursement evidence

[COSTS.md](COSTS.md) separates the private subscription proof needed for a
reimbursement claim from transparent token telemetry. Its dollar figures are
API-equivalent estimates, not invoices, and must be refreshed at submission
freeze.
