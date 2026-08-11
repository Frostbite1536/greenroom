# Engineering rules

## Mission
Build and maintain a convincing, runnable open-source conference programme platform. Optimize for the supported organizer, evaluator, speaker, and attendee workflows; preserve correctness at domain boundaries; and keep the application deployable.

## Before coding
1. Read `README.md`, `docs/ARCHITECTURE.md`, `docs/INVARIANTS.md`, `docs/ROADMAP.md`, and `REVIEW.md`.
2. Inspect existing code and tests before adding abstractions.

## Operating rules
- Keep `main` runnable and deployable.
- Whoever authors or prompts a change owns its output and must understand and verify it.
- Make small, focused commits. Never commit unrelated files.
- Run `git status --short` before committing and after merges.
- Do not reset, checkout, clean, or amend someone else's in-flight work.
- Do not edit secrets or commit `.env` files.
- Prefer the simplest conventional implementation that supports the workflow.
- When a decision affects product behavior, architecture, data, or security, record it in `docs/DECISIONS.md` with its rationale.

## Change surfaces
Shared contracts (`types/api.ts`), the Prisma schema, package/config files, and the root layout are load-bearing across every surface. Changing one is legitimate, but keep the diff minimal, state why in the pull request, and check the consumers that still speak the old contract. This is a review convention, not a security sandbox — authorization is enforced server-side per `docs/INVARIANTS.md`.

## Verification gate
Before reporting work complete: run the narrowest relevant tests plus `npm test`, run typecheck/lint/build when available, inspect the diff, and summarize files changed, checks run, risks, and next action.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
