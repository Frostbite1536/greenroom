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

## Event team: an event-wide key, not a per-member one
`/admin/team` is the first surface that *changes* and *deletes* `EventMember`
rows; before it, the three provisioning paths only ever created them. The
last-organizer rule is a predicate over the whole event, so the C17 per-member
authority keys cannot hold it — two concurrent demotions of two different
admins each lock only their own target, each read "2 admins", and between them
leave zero. `eventTeamLockKey(eventId)` therefore serializes every team write
for one event and is taken *first*, ahead of the identity and member keys, so
the order stays narrowing and cycle-free. Nothing outside the team routes takes
it. All guard counts are read after the member rows are locked and inside the
transaction that writes; every refusal is a named 422.

## Event team: a provisioned account cannot let itself in
Adding an unknown address creates a `User` shell plus a membership, under the
same C17 identity order `/api/admin/speakers` uses. That shell **cannot sign
in, and cannot obtain a way in by itself**: the reset token is signed over a
digest of the credential a user currently stores, so an account holding none
has nothing to sign against and `/api/auth/forgot` sends no mail; and
`/api/auth/signup` answers an address that already has a `User` row with a 409,
which is precisely the row the add just created. Deliberately not fixed here —
minting reset tokens for credential-less accounts would weaken the redeem
path's use-once-by-construction property, and that is an auth decision, not a
team-screen one. The working order is the reverse one, and it is the one
`/welcome` and `/api/auth/continue` were built for: the person signs up first,
then an organizer adds that address. The UI states this rather than implying a
reset email is coming, and no notification mail is sent at all — a "you were
added" message would point somebody at a door that does not open for them.

## Event team: removing a speaker is refused, never cascaded
`/admin/speakers` renders a *union* of `EventMember(role=SPEAKER)` and
`SessionSpeaker`, and `SpeakerTask` is keyed on `(taskId, userId)` with no
membership involved. Deleting a speaker's membership therefore leaves their
sessions on the schedule, their tasks in the checklist, and the person still on
the roster. Rather than cascade (destroying programme data from a team screen)
or half-remove, a speaker with sessions or tasks on this event is refused with
a 422 naming the counts. A role *change* away from speaker is not gated the
same way: nothing is deleted by one, and the rows stay keyed to the same user.
