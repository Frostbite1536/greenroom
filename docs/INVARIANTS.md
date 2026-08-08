# Sprint Invariants

These are the baseline constraints. The Architect should add target-specific invariants after reveal.

- **INV-SCOPE-001:** The golden path is prioritized over speculative completeness. — Review against `docs/ROADMAP.md`.
- **INV-GIT-001:** Every agent works in its own worktree/branch and commits before handoff. — `git status`, branch review.
- **INV-SHARED-001:** Shared contracts and schema have one owner: Architect/main. — Coordination request plus central merge.
- **INV-DATA-001:** User/workspace data cannot cross authorization boundaries. — Server-side authorization tests.
- **INV-SECRET-001:** Secrets never enter client bundles, logs, or Git. — env review and network inspection.
- **INV-RESET-001:** Demo reset is explicit, idempotent, and unavailable to unauthorized users. — focused route test/manual check.
- **INV-DEMO-001:** `main` remains runnable after every accepted merge. — typecheck/build and golden-path smoke test.
