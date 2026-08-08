---
description: Review current branch against main with sprint-focused severity
argument-hint: "[extra focus]"
---
Review the current branch against main. Read `AGENTS.md`, `REVIEW.md`, `docs/ARCHITECTURE.md`, and `docs/INVARIANTS.md`. Inspect changed files in full, not only the diff. Run cheap relevant checks when safe.

Focus on correctness, security, authorization, data integrity, API/UI mismatches, deployment failures, and golden-path regressions. Search for the same bug pattern elsewhere when a real issue is found. Extra focus: $ARGUMENTS

Report only actionable findings as `SEVERITY — path:line — issue — failure scenario — minimal fix`. Separate pre-existing findings. If none, say so and list checks performed. Do not modify code during this review.
