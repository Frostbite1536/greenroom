# Review Guidelines

## Sprint review priorities

1. Broken golden-path behavior and runtime crashes
2. Authentication and authorization failures
3. Data loss, destructive resets, and cross-workspace leakage
4. API/UI contract mismatches
5. Secrets exposure and unsafe external integrations
6. Build, typecheck, lint, and deployment regressions

## Always check

- Changed files in full, not only the diff
- New routes validate input at the boundary
- Server-only secrets never reach client code
- Tenant/workspace access is enforced server-side
- New data fields are persisted, serialized, and consumed consistently
- Loading, empty, error, and responsive states exist for user-facing flows
- Tests or a reproducible manual verification path cover the feature

## Severity

- **CRITICAL**: blocks merge or demo; security, data loss, build failure, or golden-path breakage
- **IMPORTANT**: should fix before merge; likely correctness or UX regression
- **NIT**: worthwhile but non-blocking
- **PRE-EXISTING**: not introduced by the reviewed change

## Skip during sprint

Do not block on formatting-only changes, speculative refactors, or production-scale optimizations that do not affect the demo.
