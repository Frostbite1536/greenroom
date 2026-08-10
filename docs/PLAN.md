# Sprint Plan — Greenroom

Deadline: **Wed Aug 12, 10 PM PT**. Human availability is front-loaded (next ~48h);
agents are fast, so phases are scoped to *merge-and-verify cycles*, not days.
Requirement videos land Saturday and Sunday, then requirements FREEZE.

Judging: deployed site walked through by the AIE team. Tiebreaker: product
judgment they would actually use. Explicit bonuses: speed/performance, an API,
Cloudflare infra (mild), Airtable persistence.

## Standing rules
- `main` stays deployable; workers merge early and often (target: every 2–4 hours of agent work).
- After every merge: `tsc`, build, and click the golden path on the deployed URL.
- Golden path (from STATE.md) outranks any other feature at all times.
- Screenshot references: `$SPRINT_COORDINATION_DIR/reference/screenshots/` with
  `brief-with-screenshot-markers.txt` mapping images to the reference product's pages.
  Match the *job to be done*, not pixel fidelity. Fast > faithful.

## Phase 1 — Golden path, end to end (now)
Goal: a demo-able vertical slice on a deployed URL.
- **Ops (first 30 min):** deploy current main to Vercel (Neon env vars), confirm
  `/login` works in production. From then on, every merge auto-deploys.
- **Backend:** CFP submit (shell-user upsert by email), form CRUD, evaluation
  plans/assignments/scores, accept→Session conversion, schedule slots with
  conflict detection (room overlap + speaker overlap), category→teamKey routing.
- **Frontend:** form builder (fields, conditional logic, welcome/thank-you,
  limits), public CFP renderer at `/cfp/[formId]`, abstracts table with status
  pipeline, evaluator scoring queue, agenda builder (day/room grid + list).
- **Ops:** speaker portal (status, profile, task checklist incl. form-in-task),
  admin speaker-status dashboard, `.ics` generation, email dispatch (log-only
  behind `MOCK_EXTERNAL_APIS=true`), seed script (`prisma/seed.ts`): 1 event,
  4 categories, 3 tracks, 4 rooms, ~40 abstracts across all states, 3 evaluators
  with scores, a conflict-free three-day schedule, demo personas as Users.

Exit: judge-persona can do the full walkthrough on the deployed URL.

## Phase 2 — Breadth + Saturday video
- Frontend: week/track schedule views, drag-and-drop polish, embeds
  (`/embed/schedule`, `/embed/speakers`) + copyable iframe snippet page.
- Backend: Accelevents one-way push (real POST, configurable base URL, delivery
  log; mock target when unset), CSV import with field mapping.
- Ops: resource wiki (sanitized HTML embeds), email templates UI, reminder
  triggers, real send via Resend if key present, `.ics` attachment with
  `METHOD:REQUEST`.
- Architect: fold in Saturday-video deltas (additive schema changes only),
  re-sync worktrees.

## Phase 3 — Bonuses + Sunday video (requirement freeze)
- Public REST API (`/api/v1/*`: read submissions/speakers/schedule, API-key
  auth) mirroring the reference product's public docs surface — bonus points.
- Airtable one-way mirror (accepted sessions/speakers/schedule → base via
  `AIRTABLE_API_KEY`; no-op when unset) — bonus points.
- Performance pass: no N+1 queries, server-render list pages, measure the
  five hottest pages; "we do not want slow SaaS."
- Optional dashboard (counts, funnel) — best effort only.

## Phase 4 — Freeze + judging package (low human availability)
Self-imposed feature freeze Tuesday evening.
- README: demo credentials, golden-path script, architecture summary, env setup.
- Demo-reset script; verify seed from scratch on a clean DB.
- Static HTML page proving the embed snippet works from an external origin.
- Record fallback walkthrough video/screenshots in case the deploy misbehaves.
- Submission form + token-cost receipts.

## Deploy decision
Vercel + Neon (chosen for zero Prisma friction). Cloudflare is only a *mild*
bonus and risks Workers/Prisma incompatibility late in the sprint; revisit only
if Phases 1–3 finish early. Airtable bonus is captured via the Phase 3 mirror.

## Out of scope (locked)
CRM, marketing, payments, multi-language, AI evaluation, pixel-perfect cloning.
