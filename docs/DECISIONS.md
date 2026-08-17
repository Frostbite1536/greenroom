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

## Bulk decisions: one transaction per abstract, and no email
Deciding a selection on `/admin/abstracts` loops the existing locked
per-abstract write (`lib/services/abstract-decision-write.ts`, extracted
unchanged from `POST /api/evaluations/decisions` so both routes run one code
path) with a separate transaction for each item, bounded at 100 per request.
A batch-wide transaction was rejected: it would hold every selected abstract's
advisory lock against concurrent speaker edits for the length of the slowest
provisioning, and would discard every correct write to report one refusal.
Ineligible items — already decided, withdrawn, still a draft, `MAYBE` on a
confirmed talk, or an id outside the caller's event — are skipped and named
per item rather than failing the batch.

Bulk will not reverse an existing decision. The drawer gates a re-decision
behind an explicit "Change decision" click on one named proposal; a tick box
carries no such evidence, so a selection containing a declined proposal must
not silently accept it. The single-row route's reversible-decision contract is
unchanged — the gate is a bulk-only parameter.

Bulk sends no mail, which is what "preview-safe" in the roadmap item means.
`POST /api/comms/decision` remains the only path to a speaker's inbox and is
bound by an HMAC proof to the exact content and recipients an admin previewed;
a batch cannot satisfy that proof and must not bypass it. The confirm dialog
and the result both say so in words, and a source contract test asserts the
absence of any email import across the whole bulk path.

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

## Event team: the add resolves an account, it never creates one
`POST /api/admin/team` takes an email and a role, and **refuses an address with
no `User` row** (422 `NO_ACCOUNT_FOR_EMAIL`). It is the one provisioning
surface that must not upsert a shell account, because a shell created here
would be a trap rather than a convenience:

- It could never be signed in to. The reset token is signed over a digest of
  the credential a user currently stores, so an account holding none has
  nothing to sign against and `/api/auth/forgot` sends no mail.
- It would take away that person's own way in. `/api/auth/signup` answers an
  address that already has a `User` row with a 409 — precisely the row the add
  would have created. Nothing in this codebase deletes a `User`, so the trap
  would be permanent.

The speaker and reviewer-invite paths legitimately still upsert a shell,
because each can reach the person afterwards (the organizer directly; a signed
bearer link that signs a reviewer in without a password). A team member has
neither. Refusing costs an organizer one message to the person they are adding;
provisioning would cost that person their account.

The refusal names the order that works, which is the one `/welcome` and
`/api/auth/continue` were built for: the person signs up first, then the
organizer adds the same address. The add body therefore carries **no `name`** —
there is no row it could land in — and the response reports the resolved
account's stored name so the organizer can confirm they matched the right
person. No notification mail is sent either: a "you were added" message has no
door to point at that the recipient cannot already open themselves.

Widening `/api/auth/forgot` to mint tokens for credential-less accounts was
considered and declined: it would weaken the redeem path's
use-once-by-construction property, and that is an auth decision, not a
team-screen one.

## Event team: removing a speaker is refused, never cascaded
`/admin/speakers` renders a *union* of `EventMember(role=SPEAKER)` and
`SessionSpeaker`, and `SpeakerTask` is keyed on `(taskId, userId)` with no
membership involved. Deleting a speaker's membership therefore leaves their
sessions on the schedule, their tasks in the checklist, and the person still on
the roster. Rather than cascade (destroying program data from a team screen)
or half-remove, a speaker with sessions or tasks on this event is refused with
a 422 naming the counts. A role *change* away from speaker is not gated the
same way: nothing is deleted by one, and the rows stay keyed to the same user.

## Direct session creation names speakers by roster id, not by email
`guaranteedSessionInputSchema` existed unused and reused `coSpeakerInputSchema`
for its roster, so a guaranteed session (keynote, sponsor slot) would have been
created from email/name pairs. `POST /api/agenda/sessions` changes that field to
`{ userId, isPrimary }[]` drawn from this event's roster, and makes it optional.
Two reasons. Minting a global `User` from an email is `POST /api/admin/speakers`'
job and takes that route's C17 identity lock order; a program surface that
created accounts as a side effect of scheduling a keynote would be doing identity
work under the wrong lock, and `User.email` uniqueness (S10) plus recipient
derivation (C26) hang off it. And `coSpeakerInputSchema` is `.min(1)` because a
proposal without a submitter does not exist — a sponsor slot blocked out before
the line-up is known routinely does. The schema had no consumers when it changed,
so nothing spoke the old contract. Adding a speaker who is not yet on the roster
is therefore a trip to `/admin/speakers` first, which is where identity already
lives; the alternative (accepting emails here and duplicating the C17 sequence)
was declined as a second identity writer.

## Resource/wiki pages are authored in the product, sanitized at write
The speaker portal always rendered `ResourceWiki` pages, but the only writer was
the demo seed, so INV-HTML-001's "before storage" half had nothing to enforce
and an organizer could not create a resource page at all. `/admin/resources` and
`POST|PATCH|DELETE /api/admin/resources` are that writer: ADMIN-only,
event-scoped from the session on create and from the row's own `FOR UPDATE` read
on edit and delete, with `@@unique([eventId, slug])` surfaced as a named 409.

Every authored body passes through the existing `lib/sanitize-html.ts` — the
same sanitizer the reader uses — before it is stored, and the reader keeps
sanitizing on render. That duplication is deliberate: rows still arrive from the
seed and could arrive from a future importer, so neither end may assume the
other cleaned the bytes. A body where nothing survives sanitizing is a 422
rather than a silently blank published page, because an organizer who pasted an
embed needs to be told, not left with an empty page.

The published-only rule both portal surfaces read by lives in one helper
(`portalResourceWhere`), so an unpublished draft cannot be listed on one surface
and reachable on the other. No new dependency: the conservative in-repo
sanitizer stands, and swapping in `sanitize-html`/DOMPurify remains the recorded
follow-up rather than something this surface forced.

## Session provisioning joins the onboarding fan-out lock class (C33)
Two writers maintain the onboarding-task x session-speaker cross-product
(INV-TASK-001) from opposite ends: the template writers create a required task
and fan it out across the event's confirmed sessions, and provisioning creates a
confirmed session and fans the event's templates out across its speakers. Only
the first half took `lockEventTaskFanOut`, so under READ COMMITTED an overlapping
pair each read a snapshot without the other's row, both committed, and the new
confirmed speaker was left without the new required task - an absence, so
`skipDuplicates` could not catch it. Both entry points,
`provisionGuaranteedSession` and `provisionAcceptedAbstract`, now take that same
existing per-event lock as their first awaited operation.

Placement was the decision. Not in the routes: four call sites would each have to
remember, and a forgotten one is invisible until a speaker is silently missing a
task. Not in `assignOnboardingTasks`: it is the low-level fan-out the C33
backfill already calls once per session inside a transaction holding this lock,
so acquiring there is re-entrant noise and would self-deadlock if the lock ever
stopped being transaction-scoped. At the entry points it is taken before any row
is written, so no writer in the class holds row locks while waiting for it.

The graph gains an edge, not a cycle: the accept paths take the per-abstract lock
before provisioning (abstract -> fan-out), and none of the four writers on the
other side of the fan-out lock takes an abstract lock at all. Proved two ways -
`session-provisioning-lock.source.test.ts` pins the placement and the absent
reverse edge on every run, and `session-provisioning-fanout-race.test.ts` drives
two PrismaClients through both interleavings against a real Postgres, gated
behind `RACE_PROOF=1` plus a disposable `DATABASE_URL` so `npm test` needs no
database. Pre-fix, both orders end with zero assignments; post-fix, both end with
exactly one.

## Assistant: one provider, closed projections, and explicit human control
Greenroom's two assisted-authoring actions share one server-only Responses API
client and one durable assistant-rate service. They are not a chat system or an
agent: requests have no tools, memory, history, storage, streaming, or write
capability, and provider retention is disabled. A missing or failing provider
must leave the deterministic workflow usable rather than fabricate a fallback.

Each route owns a strict structured-output schema and a closed input projection.
Resource drafting sends only a code-owned static template structure plus the
administrator's bounded title, optional summary, and notes; it reads no roster,
proposal, reviewer, schedule, or contact data. Decision-note drafting may send
the event name, proposal title, current decision, and bounded excerpts of review
comments only when the administrator opts in. Those free-text excerpts can
themselves contain identifying or score-like text, so the UI says so instead of
claiming that names or addresses can never leave. Neither route logs prompts,
outputs, provider bodies, or raw provider errors.

The outputs remain suggestions. Decision notes must be plain text. Resource HTML
is sanitized before preview and then sanitized again by the existing authoritative
save route. Applying a suggestion never saves, publishes, sends email, or changes
a decision; replacing non-empty organizer content requires confirmation. This
keeps provider output outside the domain's write and locking contracts and makes
human review a product invariant rather than prompt wording.

## The email log filters in the database, and still states no total (EML-01)
`/admin/emails` read the newest 100 dispatches with no filter, search or way
past that cap. Four GET narrowings were added - status chips, a template
select, a bounded recipient search and a 50-row page - and the decision was
where they apply. In the query, not over an already-read page: a chip layered
on a capped read would mean "failed among the newest 50", which is a different
and quieter claim than the one the chip makes. That is also why the page size
became its own limit (`adminEmailDispatchPage`) rather than a slice of the old
`adminEmailDispatches` cap.

The dropped `count()` stays dropped, and pagination did not smuggle a total
back in as a page count. The pager offers newer/older from the page-plus-one
probe and the copy describes only what is on screen; "page 3 of 9" would need a
second, differently-snapshotted read - the exact contradiction this panel
removed when it gave up its event-wide total.

Paging is keyset, not offset, and that was a correctness fix rather than a
preference (found in review of PR #97). The first cut derived Prisma `skip`
from a `?page=` number, which is only sound over a set that holds still. This
one does not: `EmailDispatch` grows while it is read, and a status chip's
subset changes as rows resolve. One dispatch inserted between two page requests
shifts every later offset by one, so page 2 repeats page 1's last row; one
`queued` row resolving into `sent` under the queued chip shifts them the other
way, so a row is never rendered at all. Neither failure announces itself.

Each page is now anchored to a row the operator actually saw, using the
`(createdAt, id)` total order the read already had. The predicate is the
row-value comparison written the long way - `createdAt < a OR (createdAt = a
AND id < b)` - because Prisma has no tuple operator, and its own `cursor:`
wants the sort key to be a unique index, which `(createdAt, id)` is not. The
`id` half is load-bearing rather than defensive: a bulk send writes many rows
inside one millisecond, so a bare `createdAt <` skips every tied row after the
anchor and `<=` repeats all of them. `email-history-stability.test.ts` proves
all three cases against an in-memory store that executes the emitted clause
literally, and it fails if the tie-break is removed.

The cursor is base64url of `createdAt|id` - opaque, not secret. Both halves are
already visible on the page that issued it; encoding exists so callers do not
hand-assemble positions, which is how offset arithmetic creeps back in. It is
length-bounded, its instant must round-trip through `toISOString` rather than
merely parse, and any malformed token resolves to the newest page instead of
throwing, because a stale link is a bad anchor and not a broken panel.

The cost is absolute positions: no "showing 51-100" and no page numbers. That
is the honest trade rather than a regression - a row number over a live log was
never a stable address, and the earlier copy stating one was quietly wrong the
moment a dispatch landed. The pager always offers "Newest" beside the
directional links, so a page emptied by a stale anchor is never a dead end.

The chips deliberately carry no counts. The speaker roster counts its chips
from rows it already loaded, which is free and consistent; here a count per
chip is four more queries against four more snapshots, and numbers that can
disagree with the rows underneath them are worse than no numbers.

`EmailDispatch.status` is a `String`, not an enum, so nothing in the schema
fails when a new outcome appears. The chip list is therefore derived from one
`EMAIL_DISPATCH_STATUS_META` record and pinned by a source contract that reads
`DeliveryMode` out of `send.ts` and the column default out of the schema. That
gave `queued` the filter it never had - stored, rendered, and reachable by no
chip, the same gap the abstracts chips closed for `WITHDRAWN`. A row carrying
some other status is still rendered honestly under the unfiltered chip; a
filter is an equality test, and there is no name to test against.

Empty states are per combination because "no failed dispatches" and "no emails
yet" are different facts and a filtered query cannot establish the second. Only
the unfiltered first page may say the log itself is empty.

## Proposal attachments are a join table, not a column on `StoredFile`
The obvious shape for "a supporting document on a proposal" is a nullable
`abstractId` on `StoredFile`. It does not work here, and the reason is dedupe.
`StoredFile` is unique on `(uploaderUserId, kind, sha256)`, and for every private
kind the `sha256` is an event-scoped fingerprint, so a speaker who attaches the
same PDF to two of their proposals in one event gets back **one** row —
`POST /api/files` returns the existing id with `deduped: true` rather than
inserting. A single owning column could only ever name one of those proposals;
the second attach would silently point at the first, or would have to defeat the
dedupe that makes private bytes event-scoped in the first place.

`AbstractAttachment` also turned out to be the right thing to count and the right
thing to delete. The "max 3 per proposal" cap counts links, and removal deletes a
link while the bytes stay — which is not a shortcut but the behaviour the product
already had, since clearing `slideDeckUrl` has never deleted the uploaded deck
either. The row is still the uploader's dedupe target for their next identical
upload. Orphaned bytes therefore accumulate; a reaper is a named follow-up rather
than something this change smuggled in.

The upload pipeline was extended, never forked. `SUPPORTING_DOCUMENT` is an enum
value with the same 5 MiB/PDF limits as `SLIDE_DECK`, and it lands on the private
branch of `canReadStoredFile` by being not-`HEADSHOT` — which is why no
authorization logic changed at all. Attaching is a second call that links an
already-stored id, so `POST /api/files` gained no proposal-authorization surface.

The consequence worth stating: reading is the unwidened deck rule, so a
**co-speaker may list a document they cannot open**. Widening it to "any speaker
on the proposal" was the alternative and was rejected — it would have made the
attachment rule differ from the deck rule for no stated reason. Instead
`viewAttachments` returns `canOpen` from the same matrix the serving route
enforces, and the row says so rather than rendering a link that answers 404.

## The per-event deck is a URL column, and the global one stays
`EventSpeakerDeck(eventId, userId, deckUrl)` closes the roadmap's own words:
"one global profile URL cannot provide per-event-private deck access."
`SpeakerProfile` is one row per person for the whole instance, so it can be
neither two decks nor private to one event's organizers.

`deckUrl` is a string rather than a `storedFileId` foreign key because the deck
field has always accepted **either** an uploaded `/api/files/<id>` path **or** a
pasted absolute link, validated by one schema. An FK cannot represent the pasted
link, so it would either drop that capability or need two columns to say one
thing. One column with the same validator as the global column it falls back to
keeps the two comparable and the precedence rule trivial.

Two things were deliberately not done. `speakerProfileUpdateSchema` was not given
a sixth key: its keys are `SpeakerProfile` COLUMNS, the organizer roster editor
`.pick()`s from it, and the v1 API's published object describes exactly those —
so `eventSlideDeckUrl` lives on a separate `portalProfileUpdateSchema` that only
the portal route parses. And the global field was not made read-only in the
portal: it is what every event without an association resolves to, so removing
the speaker's ability to set it would have replaced one gap with another. The
form relabels it as the fallback and names which event the primary control is
for.

`SpeakerStatusRow` was not widened either. It is a pure projection shared with
the `/admin` dashboard card, the CSV export and the report metrics, none of which
asked for a deck, so the resolution rides beside the rows as `decks` on
`SpeakerRosterView`. The global column is also kept out of the roster's
`profileSelect`, because that projection is what profile-completeness counts and
adding a fifth field would have quietly restated every percentage on the screen.

## v1 read scope precedes read breadth

The v1 API has two credential authorities, and neither turns private organizer
data into public data. The deployment-wide key may select any event. A
per-event `grk_` key may select only its own event; a selector for anything else
is the same opaque `401` as an invalid key, so it cannot enumerate tenants.
There is no anonymous event-discovery route.

The existing `/submissions` projection is integration-private: it includes
proposal text, answers, and speaker contact fields. A current per-event key can
therefore be shared with a trusted integration, but it is **not** a safe public
demo credential. Publishing the global key would be worse because it reaches
every event. A future demo mechanism must expose a separately constrained
public projection or add a capability and durable-rate model; documentation
alone cannot narrow a credential.

Read breadth follows this visibility matrix:

- a status filter may only narrow the existing event-scoped submissions read;
- a single proposal may reuse exactly that existing submissions projection when
  its id and the selected, authenticated event match. A missing, cross-event,
  or inaccessible proposal is the same opaque `404`, so ids cannot become an
  event-enumeration shortcut;
- held-back sessions and accepted-but-unplaced sessions remain absent from the
  schedule API. A single-resource route must preserve that same visibility and
  return an opaque event-scoped refusal rather than becoming an enumeration
  shortcut;
- only published resource pages may enter a future integration read. Draft
  resources remain ADMIN/speaker-session surfaces;
- review assignments, scores, reviewer comments, assistant prompts, and
  private file bytes never enter v1 responses.

Offset pagination remains the stable browse contract. Incremental sync remains
**unshipped**: a fixed application-time watermark alone cannot prove that a
transaction with an earlier `updatedAt` has committed before every page query.
It needs a database-level snapshot/visibility design before it can truthfully
promise a complete delta. A future cursor must include a server-fixed upper
watermark and an `(updatedAt, id)` tiebreaker, reject future caller watermarks,
and reapply the authenticated event predicate on every continuation; none of
those requirements authorizes it today.

Event discovery, resource visibility, held/unplaced sessions, generic webhooks,
and agent writes remain explicitly held by the post-release roadmap. In
particular, no single-session read has been added: a placed-and-published
schedule entry continues to be the only way a held or unplaced talk is exposed.

## Admins may edit a confirmed talk's content; the speaker roster stays locked
`PATCH /api/agenda/sessions` used to write one column, `contentStatus`. A
committee that accepted a proposal therefore had no way to fix the resulting
talk's title, summary, format, length, or topic: the speaker owned the source
`Abstract` (INV-EDIT-001) and a speaker edit deliberately never touches the
`Session`, so the confirmed programme's own text had no editor anywhere in the
product. The route now takes `title`, `description`, `format`,
`durationMinutes`, and `categoryId` as a sparse patch — an absent key is left
alone, so every request the publication toggle ever sent still means exactly what
it meant, and `sessionUpdateSchema` is `sessionPublicationSchema` extended so the
two cannot drift.

What was deliberately left out. The **speaker roster** is not a field on a
content form: naming who presents a confirmed talk is
`POST /api/admin/speakers`' write under the C17 identity locks, with the
onboarding-task fan-out that hangs off it (INV-TASK-001), and INV-EDIT-001 locks
the roster once a `Session` exists. **Placement** stays with `/api/agenda/slots`
and **status** stays with decisions. A `categoryId` is authorized against the
event inside the write transaction and refused with the same indistinguishable
404 (`CATEGORY_NOT_FOUND`) an unknown id gets, so another event's taxonomy can
neither be attached to this programme nor enumerated through it.

`durationMinutes` on a scheduled talk does **not** re-derive its slot.
`ScheduleSlot` stores `startsAt`/`endsAt` outright and nothing derives them from
a session's length: the slot writer takes both timestamps from its request, and
conflict detection compares slot intervals only. Editing the length therefore
leaves the event's overlap predicate untouched — it can neither create nor clear
a conflict, so it needs no S3 schedule lock and no re-check to satisfy
INV-SCHEDULE-001. Re-deriving `endsAt` here is the alternative that was
rejected: that is a placement, and a placement made outside a conflict check is
exactly what the invariant forbids. A placed talk keeps its slot, as it already
did when an organizer dragged the block instead, and the dialog says so —
resizing on the grid stays the schedule editor's job, where the server re-checks
overlap and can refuse.
