# Evaluation index

> Greenroom is an open-source, self-hostable conference program platform that
> takes an organizer from an open CFP through structured review, atomic
> acceptance, speaker readiness, conflict-safe scheduling, and a published
> program.

**Deployed application:** <https://greenroom-hq.com>
**Commit this evidence describes:** `9e058f3560a398352bbd48277ef80cb16e8550dc`

Every primary artifact in this directory describes that one commit. Anything
measured or captured on an earlier build is labeled **historical** and is not
presented as current evidence.

## Start here

| Artifact | What it is |
| --- | --- |
| [VIDEO-SCRIPT.md](VIDEO-SCRIPT.md) | Shot list and narration for the walkthrough video: the full operating loop, one deliberate conflict refusal, and the greenfield event/CFP proof |
| [SCREENSHOT-INDEX.md](SCREENSHOT-INDEX.md) | The current screenshot set, organized by role and workflow, with per-artifact commit, URL, timestamp, viewport, access role, and read-only/mutation status |
| [WORKFLOW-ROUTES.md](WORKFLOW-ROUTES.md) | Current shipped workflow-to-route map for admins, evaluators, speakers, and the public, linked to the applicable evidence rows |
| [INSTALL-REHEARSAL.md](INSTALL-REHEARSAL.md) | Clean-install rehearsal from a fresh clone and an empty database (**historical** — recorded at `f80247e`) |
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
  key-gated and off by default.
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

Recorded results for the current commit are captured during the coordinated
evidence window and belong here:

| Gate | Commit | Result | Recorded |
| --- | --- | --- | --- |
| `npm test` | `9e058f3` | *fill in* | *fill in* |
| `npm run typecheck` | `9e058f3` | *fill in* | *fill in* |
| `npm run build` | `9e058f3` | *fill in* | *fill in* |
| frontend smoke | `9e058f3` | *fill in* | *fill in* |
| `scripts/prod-verify.mjs` | `9e058f3` | *fill in* | *fill in* |

The frontend smoke creates and removes only its own `scratch-frontend` event.
[A3-PRODUCTION-WALKTHROUGH.md](A3-PRODUCTION-WALKTHROUGH.md) and
[INSTALL-REHEARSAL.md](INSTALL-REHEARSAL.md) are the same kind of receipt,
recorded on earlier commits and labeled as such.

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
- **No file upload on proposals.** Speaker profiles do take real uploads —
  headshots and slide decks are stored in the database and served from
  `/api/files/<id>`, with a URL field still offered as the alternative — but a
  proposal itself still carries no attachment.
- **One topic per submission, by design.** A CFP form can offer several topic
  options, but each submitted proposal stores exactly one selected topic, which
  is what routes it to a review team. The agenda `Track` is a separate placement
  choice made later, not the submitted topic.
- **Email delivery is split on purpose.** Submission receipts dispatch on the
  live provider path when one is configured. Decision mail is preview-gated: the
  send button stays disabled until the exact content has been previewed, and the
  send is bound to that content and recipient set.
- **The read-only v1 API is off by default.** It serves data only when
  `GREENROOM_API_KEY` is configured on the server.
- **Accessibility evidence is automated only.** Every audited route scored 100 on
  Lighthouse accessibility at the recorded measurement, and the three admin
  modal overlays now use the native `<dialog>` focus model — but no manual
  screen-reader pass has been performed. That gap is real and unclosed.
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
  (fine at demo scale, an outbox at real scale); the v1 API uses one
  deployment-wide read-only key rather than scoped credentials; browser security
  headers beyond framework defaults (CSP et al.) are not yet set; admin profile
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
  opening keynote, Grand Ballroom, 09:00 on 12 May — which the schema supports
  but no route creates, so direct UI creation of that special case is not
  claimed here. The seeded program itself is conflict-free across all three
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
