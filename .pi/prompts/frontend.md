---
description: Start or continue the frontend golden-path workstream
---
Act as the Frontend worker. Read `AGENTS.md`, architecture/invariants/roadmap, and `$SPRINT_COORDINATION_DIR` first. Confirm your branch and inspect current code.

Build the highest-fidelity judged screens and interactions for the golden path. Follow shared contracts; use typed fixtures when an API is unavailable rather than inventing a new contract. Include populated, loading, empty, error, and responsive states where relevant. Preserve accessibility and keyboard behavior. Do not edit schema/shared contracts/package config/root infrastructure without a request.

Before completion run focused checks, inspect `git diff`, commit one coherent slice, and write a timestamped status note containing commit SHA, files changed, checks, risks, and integration needs.
