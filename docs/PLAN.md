# Release plan — Greenroom

The delivery plan for the first release, in the order the work was sequenced.
It is written as *what must be true to ship*, not as a schedule: each stage is a
merge-and-verify cycle, and no stage starts before the one under it is
demonstrable on a deployed URL.

Durable product priorities live here; the state machines they operate on are in
[`LIFECYCLE.md`](LIFECYCLE.md) and the rules the server enforces are in
[`INVARIANTS.md`](INVARIANTS.md).

## Standing rules

- `main` stays deployable; changes merge early and often in small, reviewable
  slices.
- After every merge: `npm test`, typecheck, build, and exercise the golden path
  on the deployed URL.
- The golden path outranks every other feature at all times. A change that makes
  a new surface nicer and the golden path less reliable does not ship.

## Stage 1 — Golden path, end to end

Goal: one proposal travels from an open CFP to a published program slot.

- **Platform:** deployed on Vercel + Neon with environment validation at boot;
  every push to `main` auto-deploys.
- **Backend:** public CFP submit (shell-user upsert by email), form CRUD,
  evaluation plans/assignments/scores, accept→Session provisioning, schedule
  slots with transactional conflict detection (room overlap and speaker
  double-booking), category→review-team routing.
- **Frontend:** form builder (fields, conditional logic, welcome/thank-you
  pages, submission limits), public CFP renderer at the event-scoped URL,
  submission pipeline with status filters, evaluator scoring queue, agenda
  builder (day/room grid plus list).
- **Speaker and operations:** speaker portal (status, profile, task checklist
  including form-carrying tasks), admin speaker-readiness dashboard, `.ics`
  generation, audited email dispatch (mockable), and a deterministic demo seed:
  one event, four categories, three tracks, four rooms, 40 proposals across
  every status, three evaluators with scores, and a conflict-free three-day
  schedule.

Exit: a first-time operator can complete the whole workflow on the deployed URL
without instructions from the authors.

## Stage 2 — Breadth on the same spine

- Week and track schedule views, drag-and-drop refinement, public embeds
  (`/embed/schedule`, `/embed/speakers`) with copy-paste snippets.
- One-way Accelevents push (real POST, configurable base URL, delivery log;
  mocked when unconfigured) and mapped CSV import.
- Speaker resources (sanitized HTML), email templates, reminder triggers, real
  delivery through a provider when a key is present, and `.ics` attachments.

## Stage 3 — Integration surfaces and performance

- Read-only REST API at `/api/v1/*` (API-key gated, off by default) for
  submissions, speakers, and schedule.
- One-way Airtable mirror of confirmed program data; a no-op when
  unconfigured, with per-table repair reporting and no delete operation.
- Performance pass: no N+1 queries, server-rendered list pages, and measured
  timings for the hottest routes. A program tool that is slow to read is not
  finished.

## Stage 4 — Release readiness

- Documentation an operator can act on: quickstart, deployment, environment
  variables, role-based guides, and an honest limitations list.
- Clean-install rehearsal from a fresh clone and an empty database.
- Authorized, idempotent demo reset — refused unless an operator opts in, and
  never reachable from the UI.
- Accessibility and performance evidence, each labeled with what was measured
  and on which commit.
- A standalone page proving the schedule embed renders from a foreign origin.

## Stage 5 — Post-release integration queue

**Entry gate:** Stage 4's clean-install rehearsal, final-SHA evidence set, and
deployed golden-path verification are complete. This stage is intentionally not
part of the current release promise.

1. **Delivered:** a public static OpenAPI contract for the existing read-only v1
   API, with drift tests, safe static examples, and a workflow-to-route evidence
   map. The deployment-wide `GREENROOM_API_KEY` is never published.
2. **Delivered in the first post-release slice:** the scoped-read decision
   defines event discovery, resource visibility, held/unplaced-session privacy,
   narrowing filters, and the database-visibility proof a future incremental
   cursor must satisfy before any wider response model. Incremental sync itself
   remains unshipped.
3. **Delivered:** hashed, revocable per-event credentials and per-event deck
   associations in one reviewed schema/authorization window. The v1 endpoints
   accept a scoped key without exposing the deployment-wide key; the global
   `SpeakerProfile.slideDeckUrl` remains only the documented fallback. Safely
   scoped demo-key distribution and additional read models remain behind item 2.
4. Add generic webhook delivery and any narrow agent writes last. Writes require
   idempotency, per-token rate limits, audit records, and reuse of the existing
   abstract and schedule lock-protected service paths.
5. Take on lower-risk operator polish afterward: hidden-tab-paused,
   dirty-form-safe speaker refresh and pacing reports. `Day (rooms)` clarity and
   preview-safe bulk decisions are delivered. Manual assistive-technology
   evidence remains a real human gate.

**Exit gate:** every added route has a documented visibility model, authorization
and rate-limit tests, no global-key disclosure, and exact-head build plus
integration verification. Any write surface additionally proves the same
conflict and lifecycle refusals as its UI counterpart.

## Deployment decision

Vercel + Neon, chosen for zero Prisma friction and instant provisioning.
Cloudflare Workers hosting was evaluated and declined over Prisma/Workers
compatibility risk for a Postgres-backed application. See
[`DECISIONS.md`](DECISIONS.md).

## Out of scope (explicit)

CRM, marketing automation, payments, multi-language support, AI evaluation of
proposals, production OAuth, and speculative enterprise permission models.
These are exclusions, not backlog: adding one changes what this product is.
