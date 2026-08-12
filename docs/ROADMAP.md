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

The public API contract, per-event credentials, and per-event deck association
have shipped and are described under "Integration and completeness" above. One
constraint it established governs everything still listed here: **never publish
the global `GREENROOM_API_KEY`.** It is deployment-wide rather than
demo-event scoped, so exposing it would turn every event this API can address
into public data. Scoped credentials solve key authority; item 1 still governs
which additional data may become reachable.

1. **Read scope before read breadth.** The first post-release slice defines the
   credential and visibility matrix before widening a response: event-scoped
   keys cannot enumerate other events; resource reads expose only published
   pages; held-back and unplaced talks stay private; submission filters narrow
   the existing authorized projection; and any future incremental read must
   prove a database-visible, stable `(updatedAt, id)` window. The decision is recorded in
   [`DECISIONS.md`](DECISIONS.md#v1-read-scope-precedes-read-breadth).
2. **Scoped credentials delivered; demo distribution still gated.** ADMINs can
   issue hashed, revocable per-event tokens after the reviewed schema and
   authorization window. No plaintext secret is recoverable after creation and
   every token scopes all three existing v1 reads to one event. A safely scoped
   demo-access mechanism is still required before publishing a credential.

   `EventSpeakerDeck` also holds a speaker's
   deck for one event, the portal writes it for the event you are signed in to,
   and every organizer surface resolves event-deck-then-global-fallback through
   one shared function with the source labelled. The global
   `SpeakerProfile.slideDeckUrl` is unchanged and remains the fallback for
   events with no association. The read-only v1 API's `profile.slideDeckUrl`
   continues to report
   only the global value, because widening that published contract is exactly
   the "read scope before read breadth" ordering item 1 establishes.
3. **Additional read models.** The status filter and event-scoped
   single-submission read are the first justified additions because they retain
   the existing projection. Incremental submissions reads remain pending a
   database visibility proof. Event discovery, resource endpoints, and
   accepted-but-unplaced session data remain separate changes behind their own
   authorization and visibility proofs.
4. **Integration and agent writes last.** Generic webhook delivery and any
   narrow agent-writable operations come only after credentials, idempotency,
   rate limits, audit records, and failure handling exist. Every decision,
   placement, or task write must reuse the same locked service path as the UI;
   no adapter may bypass abstract or schedule locks.
5. **Operator polish and evidence.** Add paused-when-hidden, dirty-form-safe
   speaker refresh and an accessible submission-pacing view. `Day (rooms)`
   clarity and preview-safe bulk decisions are already delivered. Complete a
   documented manual assistive-technology pass before upgrading the
   accessibility claim.

## Explicit exclusions

CRM, marketing automation, payments, multi-language support, automated AI
evaluation or autonomous agent workflows, production OAuth, and speculative
enterprise permission models.
These are deliberate boundaries rather than backlog items: adding one changes
what this product is.
