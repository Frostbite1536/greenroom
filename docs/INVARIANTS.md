# Sprint Invariants

- **INV-DOMAIN-001:** `Abstract` is an evaluated proposal; `Session` is a confirmed schedulable talk. Acceptance/conversion creates at most one session per abstract.
- **INV-EVENT-001:** Every protected read/write is scoped to an event membership and authorized role server-side.
- **INV-FORM-001:** Public submissions enforce publication/window, submission, speaker-count, required-field, and bio-length constraints on the server.
- **INV-EVAL-001:** A score must reference a rubric key in its evaluation plan and fall within that criterion's range.
- **INV-SCHEDULE-001:** A room or speaker cannot occupy overlapping schedule intervals. Conflict detection and slot write are transactional.
- **INV-TASK-001:** Speaker completion state is derived from per-speaker assignments, not task-template state.
- **INV-HTML-001:** Embedded resource HTML is sanitized before storage or rendering.
- **INV-SECRET-001:** Secrets never enter client bundles, logs, or Git.
- **INV-RESET-001:** Demo reset is explicit, idempotent, environment-gated, and unauthorized in production.
- **INV-GIT-001:** Shared schema/contracts/configuration are Architect-owned; workers request changes through coordination.
- **INV-DEMO-001:** `main` remains buildable and the golden path remains runnable after every accepted merge.
