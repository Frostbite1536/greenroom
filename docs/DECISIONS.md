# Architectural Decisions

Durable record of sprint decisions with rationale. Synced from the live
coordination directory at each merge cycle (`$SPRINT_COORDINATION_DIR` is
outside Git and is discarded when the sprint ends).

## Database: Neon Postgres 17 (pooled)
Zero-friction fit with Prisma on Vercel (pooled connection string, no driver
adapters needed), instant provisioning during a 48-hour sprint, and a free tier
adequate for demo scale. Cloudflare Workers hosting was declined partly because
of Prisma/Workers incompatibility risk late in the sprint.

## License: AGPL-3.0-only
Jeremy's explicit choice for the open-source release (as **Greenroom**,
github.com/Frostbite1536/greenroom): the AGPL's network-use clause prevents a
competitor from running a closed hosted fork without sharing source.
`LICENSE` holds the verbatim text; `package.json` declares `AGPL-3.0-only`.

## Rename: Sessionboard → Greenroom
The sprint cloned Sessionboard's Program side; shipping with that name implied
affiliation with a real company (worst on the public CFP page's "Powered by"
footer). Renamed atomically in commit `20976f8` — brand strings, metadata,
ICS PRODID/UIDs, package name, demo email domain (`@greenroom.demo`), docs —
with the demo DB reseeded under the new persona emails.

## Abstract vs Session are distinct models
An `Abstract` is an evaluated CFP proposal; a `Session` is a confirmed,
schedulable talk (linked via `sourceAbstractId`, or created directly for e.g.
invited keynotes). Keeping them separate makes the accept→convert step an
explicit state transition, lets sessions exist without CFP provenance, and
keeps evaluation data (scores, assignments) off the schedulable entity.

## Demo auth: signed-free cookie personas
`sb_session` cookie carrying `{user, event, role}`, with one-click personas
(Admin/Evaluator/Speaker) plus login-as-any-email (SPEAKER). Chosen over a real
auth provider because the judged demo needs frictionless role switching, not
account security. Users are resolved by lowercased email (not id) so sessions
survive reseeds. Public routes (`/cfp/*`, `/embed/*`) work with a null session.
Neon Auth was evaluated and declined as unneeded complexity.

## Single-writer DB discipline
All agents share one `DATABASE_URL`; concurrent seeds/smokes caused P2002
collisions and Postgres deadlocks. Rule: `demo-event` is read-only for workers;
smoke tests write only to per-worker scratch events (`scratch-backend` etc.)
with forged scratch-scoped session cookies; only the Architect seeds/resets
`demo-event`, announced in coordination first.

## Deploy: GitHub + Vercel integration
Private repo `Frostbite1536/greenroom`; Vercel imports it via the GitHub
integration so every push to `main` auto-deploys — no agent needs Vercel
credentials. `vercel.json` pins the build to `prisma generate && next build`.
Only `DATABASE_URL` is required in the dashboard; `ALLOW_DEMO_RESET` stays
unset in production so the reset endpoint is inert.

## Process: no repo automation without approval
Repository automation (GitHub workflows, issue templates, third-party Apps)
requires Jeremy's approval during the sprint. The frog CLI's `init` side effect
(`.github/ISSUE_TEMPLATE/`) was reverted under this rule; friction is logged in
`docs/FRICTION.md` instead.
