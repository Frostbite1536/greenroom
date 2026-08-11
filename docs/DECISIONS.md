# Architectural Decisions

Durable record of architectural decisions and their rationale. Each entry says
what was chosen and why the alternatives were not, so a later contributor can
tell a deliberate constraint from an accident.

## Database: Neon Postgres 17 (pooled)
Zero-friction fit with Prisma on Vercel (pooled connection string, no driver
adapters needed), instant provisioning, and a free tier adequate for demo scale.
Cloudflare Workers hosting was declined partly because of Prisma/Workers
incompatibility risk.

## License: AGPL-3.0-only
Jeremy's explicit choice for the open-source release (as **Greenroom**,
github.com/Frostbite1536/greenroom): the AGPL's network-use clause prevents a
competitor from running a closed hosted fork without sharing source.
`LICENSE` holds the verbatim text; `package.json` declares `AGPL-3.0-only`.

## Product name: Greenroom
The project's original working name was borrowed from an existing commercial
product, which would have implied an affiliation that does not exist. Renamed
atomically in commit `20976f8` — brand strings, metadata, ICS PRODID/UIDs,
package name, demo email domain (`@greenroom.demo`), and docs — with the demo
DB reseeded under the new persona emails. (The three persona addresses moved
again in
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
the demo's role switching frictionless without treating an email address
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
requires the maintainer's approval. A developer CLI that created
`.github/ISSUE_TEMPLATE/` as an install side effect was reverted under this
rule.

## Direct session creation names speakers by roster id, not by email
`guaranteedSessionInputSchema` existed unused and reused `coSpeakerInputSchema`
for its roster, so a guaranteed session (keynote, sponsor slot) would have been
created from email/name pairs. `POST /api/agenda/sessions` changes that field to
`{ userId, isPrimary }[]` drawn from this event's roster, and makes it optional.
Two reasons. Minting a global `User` from an email is `POST /api/admin/speakers`'
job and takes that route's C17 identity lock order; a programme surface that
created accounts as a side effect of scheduling a keynote would be doing identity
work under the wrong lock, and `User.email` uniqueness (S10) plus recipient
derivation (C26) hang off it. And `coSpeakerInputSchema` is `.min(1)` because a
proposal without a submitter does not exist — a sponsor slot blocked out before
the line-up is known routinely does. The schema had no consumers when it changed,
so nothing spoke the old contract. Adding a speaker who is not yet on the roster
is therefore a trip to `/admin/speakers` first, which is where identity already
lives; the alternative (accepting emails here and duplicating the C17 sequence)
was declined as a second identity writer.
