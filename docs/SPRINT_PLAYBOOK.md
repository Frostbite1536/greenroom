# 48-Hour Sprint Playbook

## Phase 0 — Reconnaissance

Identify the target's primary user, the 3–5 judged screens, the single golden path, required data, and explicit non-goals. Capture this in `docs/ARCHITECTURE.md` and `docs/ROADMAP.md`.

## Phase 1 — Contract lock

The Architect owns shared types, schema, package configuration, root shell, and route map. Lock only what the golden path needs. Commit a runnable baseline before workers begin.

## Phase 2 — Parallel vertical slices

- Backend: APIs/services required by the golden path, deterministic fixtures, focused tests.
- Frontend: high-fidelity screens, navigation, populated/loading/empty/error/responsive states.
- Ops: demo auth, env validation, mock external services, deploy and reset path.

Do not repeatedly merge main while actively editing. Finish a small slice, commit it, then rebase/merge deliberately.

## Merge gate

For each branch: inspect `git diff`, run relevant tests and typecheck/build, manually exercise the golden path, review with Croak if available, and use Greptile at milestone checkpoints rather than every tiny commit.

## Final six hours

Freeze schema and architecture. Stop risky refactors. Seed realistic data, rehearse the demo from a clean environment, test deployment, and fix only user-visible or release-blocking issues.
