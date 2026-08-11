# Workflow → routes and evidence

This is a factual navigation map for the routes shipped in this repository. It
is not an external requirements-compliance matrix, and it does not change the
capture status or commit metadata recorded in
[SCREENSHOT-INDEX.md](SCREENSHOT-INDEX.md).

Paths are relative to the deployed application URL. Evidence-row references
point to the current screenshot index; a missing row means the route exists in
the route tree but is not separately represented by a screenshot.

## Admin workflow

| Workflow | Live route | Evidence |
| --- | --- | --- |
| Program overview and next actions | `/admin` | Route exists; the linked workflow screens below carry the evidence. |
| Event identity, rooms, tracks, and create-event flow | `/admin/settings` | Screenshot rows [4–5](SCREENSHOT-INDEX.md#shot-list). |
| CFP list and form builder | `/admin/forms`, `/admin/forms/[formId]` | Screenshot rows [6, 24](SCREENSHOT-INDEX.md#shot-list). |
| Proposal pipeline, decisions, and review-results CSV | `/admin/abstracts` | Screenshot rows [7, 25](SCREENSHOT-INDEX.md#shot-list). |
| Round setup, coverage, and evaluator routing | `/admin/evaluations` | Screenshot rows [8–9](SCREENSHOT-INDEX.md#shot-list). |
| Conflict-safe placement, room grid, and assisted placement | `/admin/agenda` | Screenshot rows [11–13](SCREENSHOT-INDEX.md#shot-list). |
| Speaker readiness and task administration | `/admin/speakers` | Screenshot row [16](SCREENSHOT-INDEX.md#shot-list). |
| Funnel, review-load, utilization, readiness, and CSV reports | `/admin/reports` | Route exists; reports are not separately captured. |
| Embed snippets and public links | `/admin/embeds` | Screenshot row [21](SCREENSHOT-INDEX.md#shot-list). |
| Preview-gated decision mail and integration operations | `/admin/operations` | Screenshot row [22](SCREENSHOT-INDEX.md#shot-list). |
| Delivery history | `/admin/emails` | Screenshot row [17](SCREENSHOT-INDEX.md#shot-list). |

## Evaluator workflow

| Workflow | Live route | Evidence |
| --- | --- | --- |
| Assigned queue, rubric scoring, and conflict declaration | `/admin/evaluations` | Screenshot row [10](SCREENSHOT-INDEX.md#shot-list). The same route renders the evaluator-scoped workspace after server-side role resolution. |

## Speaker workflow

| Workflow | Live route | Evidence |
| --- | --- | --- |
| Profile, submissions, confirmed sessions, and task checklist | `/portal` | Screenshot row [14](SCREENSHOT-INDEX.md#shot-list). |
| A submitted or accepted proposal the speaker is allowed to edit | `/portal/submissions/[abstractId]` | Route exists; lifecycle and authorization rules are documented in [../API.md](../API.md). |
| Form-backed onboarding task | `/portal/tasks/[taskId]` | Screenshot row [15](SCREENSHOT-INDEX.md#shot-list). |
| Speaker resource | `/portal/resources/[slug]` | Route exists; access is speaker-session scoped. |

## Public and account workflow

| Workflow | Live route | Evidence |
| --- | --- | --- |
| Landing page and currently open CFP entry | `/` | Screenshot row [2](SCREENSHOT-INDEX.md#shot-list). |
| Canonical public call for speakers | `/cfp/[eventSlug]/[formSlug]` | Screenshot rows [3, 23, 27](SCREENSHOT-INDEX.md#shot-list) use `/cfp/forward-2026/call-for-speakers`. |
| Public program and speaker directory | `/schedule`, `/speakers` | These canonical pages share the public program read with the embeds below. |
| Embeddable schedule and speakers | `/embed/schedule`, `/embed/speakers` | Screenshot rows [18–20, 26](SCREENSHOT-INDEX.md#shot-list). |
| Sign-in, self-service account creation, recovery, and first-event welcome | `/login`, `/signup`, `/forgot`, `/reset`, `/welcome` | Screenshot row [1](SCREENSHOT-INDEX.md#shot-list) covers the sign-in entry. |
| Reviewer invite landing | `/reviewer-invite` | Route exists; invitation material is deliberately not shown in screenshot evidence. |

## Integration and verification surfaces

| Surface | Route or document | Notes |
| --- | --- | --- |
| Versioned read-only API | `/api/v1/submissions`, `/api/v1/speakers`, `/api/v1/schedule` | Key-gated and off unless configured; see [../API.md](../API.md). |
| Published API contract | `/api/v1/openapi`, `/docs/api` | The OpenAPI 3.1 document and its rendered page. Both are public: no key, no database read, no program data, and never the key itself. |
| Calendar export | `/api/comms/calendar?eventId=<eventId>` | Public export of the program according to its publication rules. |
| Foreign-origin schedule proof | [embed-schedule-proof.html](embed-schedule-proof.html) | Standalone embedding proof. |
| Reproducible verification | [INSTALL-REHEARSAL.md](INSTALL-REHEARSAL.md) and the [verification receipts](README.md#verification-receipts) | Receipt provenance and historical/current labels remain authoritative in those documents. |
