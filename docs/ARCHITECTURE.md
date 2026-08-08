# Architecture

## Status

Pre-reveal sprint scaffold. The target SaaS, core entities, routes, and stack are intentionally TBD until the Architect receives the product brief.

## Decision rules

- Prefer a boring, conventional stack already present in the repository.
- Establish one complete golden path before secondary features.
- Shared contracts are locked by the Architect and changed centrally.
- External integrations must have a mockable adapter and a demo-safe fallback.
- Keep server-only credentials and privileged operations server-side.

## Target brief

- **Target SaaS:** [TBD]
- **Primary user:** [TBD]
- **Golden path:** [TBD]
- **Top judged screens:** [TBD]
- **Explicit non-goals:** [TBD]

## Contract lock

The Architect should record model names, route signatures, validation schemas, ownership, and known limitations here after reveal. Do not invent a production-scale schema before the target is known.
