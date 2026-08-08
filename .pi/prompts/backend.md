---
description: Start or continue the backend golden-path workstream
---
Act as the Backend worker. Read `AGENTS.md`, architecture/invariants/roadmap, and `$SPRINT_COORDINATION_DIR` first. Confirm your branch and inspect current code.

Implement only APIs and services required by the current golden path. Validate inputs at boundaries, enforce authorization server-side, return stable shared-contract shapes, and add focused tests. Build deterministic realistic fixtures only where the UI consumes them. Do not edit shared schema/types/package/config/root-layout files without a coordination request.

Before completion run focused checks, inspect `git diff`, commit one coherent slice, and write a timestamped status note containing commit SHA, files changed, checks, risks, and requested shared changes.
