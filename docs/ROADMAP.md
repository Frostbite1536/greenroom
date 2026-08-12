# Greenroom product roadmap

What the product covers, in the order the capability areas were established.
The live "not yet" list — the limitations an operator should know about before
adopting Greenroom — is maintained in one place, the
[evaluation index](judging/README.md#current-limitations), so it cannot drift
from the shipped application.

## Foundation

Lock the `Abstract` vs `Session` domain boundary, the form/evaluation/schedule
contracts, the application shell, and the verification commands. Exit: Prisma
validates, the client generates, typecheck and build pass, and a schema push
succeeds against a real database.

## Golden path

- **Intake:** public form submission, event-scoped and open/close aware.
- **Evaluation:** weighted rubric scoring, routed by topic to review teams.
- **Acceptance:** one transactional accept that provisions the confirmed session
  and every speaker's onboarding checklist.
- **Scheduling:** conflict-safe placement — room overlap and speaker
  double-booking detected inside the transaction that would write the slot.
- **Speaker readiness:** profile and task portal, with admin visibility into who
  is behind.

Exit: one proposal travels from draft through a published schedule.

## Integration and completeness

External event-platform push, mapped CSV/JSON import, realistic deterministic
demo data, and public schedule/speaker embeds. Every operator-facing screen
carries populated, loading, empty, error, and responsive states — an empty state
is part of the product, not a gap in it.

The read-only v1 API's contract is published here too, in two public forms that
need no key: the static OpenAPI 3.1.1 document at `/api/v1/openapi.json`, and
its rendered page at `/docs/api`, which is generated from that same document
rather than restating it. A drift test fails the suite when the document stops
describing what the routes do, a purity test pins the document's whole import
graph away from the environment, auth, and the database, and a workflow-to-route
map ([judging/WORKFLOW-ROUTES.md](judging/WORKFLOW-ROUTES.md)) says which
surface answers which question. Every example uses a placeholder credential.

The optional Greenroom Assistant is deliberately narrower than an agent. It
ships two ADMIN-only suggestion actions on one non-retained, rate-limited,
server-only provider: turn bounded organizer notes and a static template into a
sanitized resource-page draft, or turn an explicit decision plus selected
bounded feedback into a plain-text personal-note draft. Templates and resource
preview do not require the provider. Suggestions never save, publish, send, or
replace existing content without a separate human action.

## Operational hardening

Deployment, authorized idempotent demo reset, review checkpoints, accessibility
and performance audits, and a clean-environment install rehearsal. Evidence for
each is recorded with what was measured and on which commit.

## Next build queue — after release readiness

This is a post-release sequence, not a claim that any item below is available
today. It starts only after the clean-install rehearsal, final evidence capture,
and deployed golden-path verification are complete.

The first item of this queue — the public API contract and its safe examples —
has shipped and is described under "Integration and completeness" above. One
constraint it established governs everything still listed here: **never publish
the global `GREENROOM_API_KEY`.** It is deployment-wide rather than
demo-event scoped, so exposing it would turn every event this API can address
into public data. That is what item 2 below has to solve first.

1. **Read scope before read breadth.** Define event discovery, resource
   visibility, and incremental-sync cursor semantics before adding filtered
   submissions, individual resources, or additional session reads. Held-back
   and unplaced talks stay private until an explicit contract says otherwise.
2. **Scoped credentials.** Add hashed, revocable per-event tokens and a safely
   scoped demo-access mechanism before any public data demonstration. This is a
   schema and authorization change, so it requires its own reviewed database
   window and migration plan. The global `SpeakerProfile.slideDeckUrl` also
   needs a later per-event deck pointer or association in that reviewed window;
   one global profile URL cannot provide per-event-private deck access.
3. **Additional read models.** Add only the reads justified by the preceding
   scope contract, with bounded pagination, stable ordering, event authorization,
   and contract tests on every response.
4. **Integration and agent writes last.** Generic webhook delivery and any
   narrow agent-writable operations come only after credentials, idempotency,
   rate limits, audit records, and failure handling exist. Every decision,
   placement, or task write must reuse the same locked service path as the UI;
   no adapter may bypass abstract or schedule locks.
5. **Operator polish and evidence.** Consider paused-when-hidden speaker
   refresh, a `Day (rooms)` agenda label, preview-safe bulk decisions, and a
   submission-pacing view. Complete a documented manual assistive-technology
   pass before upgrading the accessibility claim.

## Explicit exclusions

CRM, marketing automation, payments, multi-language support, automated AI
evaluation or autonomous agent workflows, production OAuth, and speculative
enterprise permission models.
These are deliberate boundaries rather than backlog items: adding one changes
what this product is.
