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

## Operational hardening

Deployment, authorized idempotent demo reset, review checkpoints, accessibility
and performance audits, and a clean-environment install rehearsal. Evidence for
each is recorded with what was measured and on which commit.

## Explicit exclusions

CRM, marketing automation, payments, multi-language support, AI evaluation of
proposals, production OAuth, and speculative enterprise permission models.
These are deliberate boundaries rather than backlog items: adding one changes
what this product is.
