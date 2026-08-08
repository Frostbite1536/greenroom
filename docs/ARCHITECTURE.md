# Sessionboard Program Manager Architecture

## Product boundary

A fast program-management workspace for event admins, evaluators, and speakers. It covers CFP intake, abstract evaluation, confirmed sessions, speaker onboarding, agenda scheduling, public embeds, communications, and imports.

Explicit non-goals: CRM, marketing automation, payments, multi-language support, and AI evaluation workflows.

## Golden path

1. Admin publishes a configured CFP form.
2. Speaker saves and submits an `Abstract` with one or more speakers.
3. Admin assigns the abstract through an `EvaluationPlan`; evaluators score rubric criteria.
4. Admin accepts the abstract and converts it into one confirmed `Session` (or creates a guaranteed session directly).
5. Speaker completes profile and onboarding tasks.
6. Admin schedules the session; room and speaker overlap checks must pass.
7. Public schedule embed exposes the session and an `.ics` download.

## Stack

- Next.js 16 App Router, React 19, TypeScript strict mode
- PostgreSQL via Prisma 6
- Zod contracts at `types/api.ts`
- Server components by default; client components only for interactive builders
- Mock auth boundary at `lib/auth.ts`

## Domain model

All program data is event-scoped. `EventMember` assigns admin, evaluator, or speaker roles.

- `FormConfig` owns submission windows, limits, messaging, speaker constraints, and `FormField` definitions.
- `Abstract` is a proposal submitted through a form. It owns custom answers, speakers, assignments, and scores.
- `EvaluationPlan` owns a versioned rubric JSON and evaluator/team assignments.
- An accepted `Abstract` may produce exactly one `Session`; guaranteed/sponsor sessions have no source abstract.
- `Session` is the schedulable confirmed-talk record and has one optional `ScheduleSlot`.
- `ScheduleSlot` references a room and optional track. Services must detect room and speaker interval overlaps transactionally.
- `OnboardingTask` templates produce per-speaker `SpeakerTask` status/artifact records.
- Email, import, and resource records support the demo integration surfaces.

Primary keys are CUID strings. Unique/index constraints are documented in `prisma/schema.prisma`.

## Locked routes and contracts

Shell routes:

- `/admin/forms`
- `/admin/evaluations`
- `/admin/agenda`
- `/cfp/[formId]`
- `/portal`
- `/embed/schedule`

Backend ownership routes:

- `/api/cfp/*`: form config, public form, draft/submit abstract
- `/api/evaluations/*`: plans, assignments, scores, decisions, abstract-to-session conversion
- `/api/agenda/*`: sessions, slots, conflict checks
- `/api/integrations/*`: Accelevents webhook and CSV/JSON import

Ops ownership routes:

- `/api/portal/*`: profile and task updates
- `/api/comms/*`: email dispatch and calendar downloads

Request schemas and API envelope types are locked in `types/api.ts`. Workers must request shared changes through coordination rather than redefining contracts.

## Security and performance

- Every API verifies event membership and role server-side; mock auth is development-only.
- Public form reads/submissions are scoped to a published form and its event.
- Resource HTML must be sanitized before persistence or rendering.
- Uploads use validated server-side storage adapters; URLs are not trusted as authorization.
- Schedule conflict checks and writes happen in one transaction.
- Keep interactive client islands narrow and avoid serial data waterfalls.

## Environment status

PostgreSQL 16 is running and accepts connections on port 5432, but password authentication is required. `.env` is currently absent, so `prisma db push` remains blocked until a valid `DATABASE_URL` is supplied. Prisma client generation and schema validation succeed independently.
