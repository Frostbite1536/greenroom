# Sprint Agent Constitution

## Mission
Build a convincing, runnable clone of the revealed target SaaS in 48 hours. Optimize for the judged golden path and fidelity, not speculative completeness.

## Before coding
1. Read `README.md`, `docs/ARCHITECTURE.md`, `docs/INVARIANTS.md`, `docs/ROADMAP.md`, and `REVIEW.md`.
2. Read the current coordination files under `$SPRINT_COORDINATION_DIR`.
3. Inspect existing code and tests before adding abstractions.

## Operating rules
- Keep `main` runnable and deployable.
- Whoever prompts an agent owns its output and must understand and verify it.
- Make small, focused commits. Never commit unrelated files.
- Run `git status --short` before committing and after merges.
- Do not reset, checkout, clean, or amend another agent's work.
- Do not edit secrets or commit `.env` files.
- Prefer the simplest conventional implementation that supports the golden path.
- Ask questions in `JEREMY-INBOX.md`, but include a recommendation and continue with a reasonable default.

## Ownership
- Architect/main: shared contracts, schema, package/config files, root layout, merges.
- Backend: API routes and server services required by the golden path.
- Frontend: dashboard views, components, styles, and client interactions.
- Ops: auth, environment validation, deployment, mock integrations, demo reset.

Ownership is a coordination rule, not a security sandbox. If a shared-file change is essential, record it in coordination first and keep the diff minimal.

## Shared files
The live coordination directory is provided by `$SPRINT_COORDINATION_DIR`. It is outside Git worktrees and is intentionally not merged. Treat status notes as potentially stale; include timestamps and commit SHAs.

## Friction logging
Frog is optional. If installed, run `frog list` before `frog log`; record only reproducible project/tooling papercuts and never secrets. See `docs/FRICTION_LOGGING.md`. Do not add automation or change repository permissions during the sprint without Jeremy's approval.

## Verification gate
Before reporting work complete: run the narrowest relevant tests, typecheck/lint/build when available, inspect the diff, and write a status note with files changed, checks run, risks, and next action.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
