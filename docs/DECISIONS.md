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

## Rename: source product → Greenroom
The sprint cloned the revealed target's Program workflow; shipping with the
source name implied affiliation with a real company. Renamed atomically in
commit `20976f8` — brand strings, metadata, ICS PRODID/UIDs, package name,
demo email domain (`@greenroom.demo`), and docs — with the demo DB reseeded
under the new persona emails. (The three persona addresses moved again in
Cycle 5 — see *Persona addresses on a deliverable domain* below; the rest of
the seeded cast still uses the non-routable domain this entry describes.)

## Persona addresses on a deliverable domain
The three one-click personas moved from `@greenroom.demo`, which cannot receive
mail, to `maya|ravi|sofia@greenroom-hq.com`, which a catch-all forwards — so the
demo's email features can be proven with a real delivery instead of a mocked
one. Deliberately limited to those three: the 40-strong speaker pool
(`@speakers.demo`) and the two supporting evaluators stay undeliverable, because
pointing bulk fiction at a live mailbox turns any future broadcast into real
mail.

`User.email` is unique and a signed session resolves to a `User` by email, so
changing the constant alone would have made the seed's upsert create a second
row and strand the original — which owns the persona's id and therefore its
global, `userId`-keyed `SpeakerProfile`. The seed instead renames the surviving
pre-move row in place before the upserts (idempotent; a no-op on a fresh or
already-migrated database). If both addresses somehow exist it leaves the old
row alone rather than deleting it: this seed never removes a `User`, and an
orphan is inert because the reset wipes every demo-event `EventMember` and
re-adds only the migrated ids.

## Abstract vs Session are distinct models
An `Abstract` is an evaluated CFP proposal; a `Session` is a confirmed,
schedulable talk (linked via `sourceAbstractId`, or created directly for e.g.
invited keynotes). Keeping them separate lets acceptance atomically create a
confirmed-but-unscheduled record, lets sessions exist without CFP provenance,
and keeps evaluation data (scores, assignments) off the schedulable entity.
`POST /api/evaluations/convert` remains an idempotent compatibility/backfill
path for accepted records created before automatic provisioning.

## Demo auth: signed, fixed personas with persisted authorization
`sb_session` is an HMAC-signed, seven-day cookie for the three fixed seeded
personas (Admin/Evaluator/Speaker). Every protected page, action, and API
resolves the current `EventMember` role from Postgres; public CFP input can
create speaker data but never grants membership or authorization. This keeps
the judged demo's role switching frictionless without treating an email address
as authentication. Public routes (`/cfp/*`, `/embed/*`) work with a null
session. A random server-only `SESSION_SECRET` of at least 32 characters is
required in production. Neon Auth was evaluated and declined as unneeded
complexity for the fixed demo-persona boundary.

## Single-writer DB discipline
All agents share one `DATABASE_URL`; concurrent seeds/smokes caused P2002
collisions and Postgres deadlocks. Rule: `demo-event` is read-only for workers;
smoke tests write only to per-worker scratch events (`scratch-backend` etc.)
with signed scratch-only session cookies; only the Architect seeds/resets
`demo-event`, announced in coordination first.

## Deploy: GitHub + Vercel integration
Private repo `Frostbite1536/greenroom`; Vercel imports it via the GitHub
integration so every push to `main` auto-deploys — no agent needs Vercel
credentials. `vercel.json` pins the build to `prisma generate && next build`.
`DATABASE_URL` and `SESSION_SECRET` are required in the dashboard;
`ALLOW_DEMO_RESET` stays unset in production so the reset endpoint is inert.

## Process: no repo automation without approval
Repository automation (GitHub workflows, issue templates, third-party Apps)
requires Jeremy's approval during the sprint. The frog CLI's `init` side effect
(`.github/ISSUE_TEMPLATE/`) was reverted under this rule; friction is logged in
`docs/FRICTION.md` instead.
