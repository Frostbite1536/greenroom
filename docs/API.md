# APIs

Greenroom exposes two separate API surfaces:

- **`/api/v1/*`** — the versioned, read-only, API-key-gated surface below. Intended for
  server-to-server integrations.
- **`/api/*`** — the application's own endpoints, used by the app's pages and authorized by
  the signed session cookie. They are **not** part of the v1 contract, are not reachable with
  an API key, and may change without a version bump. The speaker-facing ones are documented
  at the end of this file.

## Read-only REST API (v1)

The v1 API is a server-to-server, read-only surface. Two kinds of credential
reach it, and they differ in reach:

- **The deployment-wide key.** Set `GREENROOM_API_KEY` on the server to a random
  value of at least 32 characters; a shorter value is ignored entirely, as
  though unset. This key may address **any** event on the deployment.
- **Per-event keys.** An event's ADMIN issues these from **Event settings → API
  access**. They look like `grk_<id>_<secret>`, are stored only as a one-way
  hash, are revocable, and may address **that one event and nothing else**.

Either kind is sent the same way, and neither is ever safe to expose in browser
code.

A deployment can be fully configured with per-event keys alone, so there is no
separate "this server is not configured" answer. **Every request without an
accepted credential is `401 UNAUTHORIZED`**, including on a deployment that has
set no `GREENROOM_API_KEY` at all: such a deployment refuses every request it
cannot authenticate, and still exposes no program data.

The contract for these three routes is published in two forms, both public and
neither requiring a key: **`GET /api/v1/openapi.json`** serves a static
OpenAPI 3.1.1 document, and **`/docs/api`** renders that same document as a page.
They cannot disagree — the page is generated from the document, and
`lib/api/openapi.test.ts` fails when the document stops matching the routes.
Neither contains program data, and neither ever contains the key, and
`lib/api/openapi-purity.test.ts` pins the document's whole import graph away
from the environment, auth, and the database.

Authenticate with either `Authorization: Bearer <key>` or `X-API-Key: <key>`.
Every request must provide an explicit `event` query parameter containing the
event's slug or id.

With the deployment-wide key, an unknown event returns `404 EVENT_NOT_FOUND`.
With a per-event key, anything other than that key's own event returns
`401 UNAUTHORIZED` whether or not such an event exists — a per-event key cannot
be used to discover which other events a deployment hosts.

```bash
export BASE_URL="https://your-app.example"
export GREENROOM_API_KEY="replace-with-at-least-32-random-characters"

curl -H "Authorization: Bearer $GREENROOM_API_KEY" \
  "$BASE_URL/api/v1/submissions?event=forward-2026&limit=50&offset=0"

curl -H "X-API-Key: $GREENROOM_API_KEY" \
  "$BASE_URL/api/v1/speakers?event=forward-2026"

curl -H "Authorization: Bearer $GREENROOM_API_KEY" \
  "$BASE_URL/api/v1/schedule?event=forward-2026"
```

### Common response shape

Successful list responses use a stable versioned envelope. `limit` defaults to
50 and is bounded to 1–100; `offset` defaults to 0. Results are stable: list
records include an id tiebreaker after their primary ordering.

```json
{
  "version": "v1",
  "data": [],
  "error": null,
  "meta": {
    "event": { "id": "...", "name": "...", "slug": "...", "timezone": "UTC" },
    "pagination": { "limit": 50, "offset": 0, "total": 0, "hasMore": false, "nextOffset": null }
  }
}
```

Errors use the same `version`, `data`, `error`, and `meta` top-level fields.
Expected error codes are `UNAUTHORIZED` (401), `EVENT_REQUIRED` or
`INVALID_QUERY` (400), `EVENT_NOT_FOUND` (404), and `INTERNAL_ERROR` (500).

### Endpoints

| Endpoint | Data | Ordering |
| --- | --- | --- |
| `GET /api/v1/submissions` | Event-scoped proposals, form/category, speakers, and answer values. Review assignments, scores, and private comments are never returned. | `createdAt`, `id` ascending |
| `GET /api/v1/speakers` | People derived only from this event's abstract or session speaker relations, with their profile and event-local appearance counts. | `name`, `id` ascending |
| `GET /api/v1/schedule` | Only placed sessions, including their slot, room, optional track, and session speakers. | `startsAt`, `id` ascending |

All three endpoints accept `event=<slug|id>`, `limit=<1..100>`, and
`offset=<0..1000000>`.

## Planned v1 expansion — not shipped

This is an ordered design queue, not an available API contract.

The first item of this queue — the static OpenAPI document and its drift test —
has shipped and is described above; what remains is below.

1. The deployment-wide `GREENROOM_API_KEY` will **not** be published as a demo
   credential. It is not event-scoped, so exposing it would turn every event
   addressable by the current API into public data.
2. Event discovery and resource visibility come before new read endpoints. In
   particular, held-back or unplaced sessions must remain private unless a
   future scoped-read contract explicitly permits them; filters and incremental
   sync also need bounded, stable cursor semantics.
3. Hashed, revocable per-event credentials and a safely scoped demo-access path
   precede any broader discovery or data demonstrations.
4. Generic webhook delivery and any agent-writable API come last. A write must
   carry idempotency, per-token rate limits, auditability, and the same server
   authorization, abstract locks, and schedule locks used by the application
   routes. It must never reimplement or bypass those protections.

## In-app speaker submission endpoints (session-authenticated)

These back the speaker's "my submissions" surface (requirement R1: speakers may edit their
proposal after acceptance). They are authorized by the `sb_session` cookie and the caller's
`AbstractSpeaker` link — **an API key does nothing here**, and they are outside the v1
contract. They use the app envelope (`{ ok, data }` / `{ ok: false, error }`), not the v1
envelope.

| Endpoint | Who may call it | Returns |
| --- | --- | --- |
| `GET /api/cfp/submissions/mine` | any signed-in user, scoped to their active event | `{ submissions: [...] }`, the abstracts the caller is a speaker on, newest first, capped at 100 |
| `GET /api/cfp/submissions/{abstractId}` | a speaker on that abstract | `{ submission, answersByKey, form }` — the record, its answers keyed by form-field key, and the field spec to render |
| `PATCH /api/cfp/submissions/{abstractId}` | a speaker on that abstract | the same payload as `GET`, after the edit |

The `PATCH` body is a partial update; every key is optional and at least one is required:
`title`, `abstract`, `format`, `durationMinutes`, `categoryId`, `speakers`, `answers`
(keyed by form-field key; `null` clears an answer). Omitted keys are left untouched, and
unknown answer keys are ignored.

A content edit never changes `status`, `submittedAt`, `decidedAt`, or `submitterId`, and never
touches the linked `Session` (INV-DOMAIN-001).

**Self-withdraw (W1).** The same `PATCH` accepts `{ "status": "WITHDRAWN" }` — the only status
a speaker may set, and it must be sent on its own (any other key alongside it is `422`).
Allowed from `DRAFT`, `SUBMITTED`, `UNDER_REVIEW`, and `MAYBE`; `ACCEPTED` or any abstract with a
linked `Session` is refused with `409 WITHDRAW_NOT_ALLOWED`. `decidedAt` stays null.

Status codes:

| Code | When |
| --- | --- |
| `401 UNAUTHENTICATED` | no session, or the signed-in email has no membership in the event |
| `403 NOT_YOUR_SUBMISSION` | signed in, but not a speaker on that abstract |
| `404 ABSTRACT_NOT_FOUND` | no such abstract in the caller's event (checked before ownership, so it never confirms another event's records) |
| `409 ABSTRACT_LOCKED` | the abstract is `REJECTED` or `WITHDRAWN` |
| `409 SPEAKERS_LOCKED` | the roster was changed after a session exists (normally from acceptance) |
| `409 WITHDRAW_NOT_ALLOWED` | self-withdraw attempted on an accepted or Session-linked proposal |
| `422 VALIDATION_ERROR` | the body itself is malformed (field errors keyed by body path) |
| `422 FIELD_ERRORS` / `TOO_FEW_SPEAKERS` / `TOO_MANY_SPEAKERS` | the merged result fails the form's own content rules; `FIELD_ERRORS` carries `fieldErrors` keyed by form-field key |
| `422 NO_PRIMARY_SPEAKER` / `INVALID_CATEGORY` | a supplied roster has no primary speaker, or the category is not in this event |

### Public CFP write boundary

Unauthenticated `POST /api/cfp/submissions` accepts `saveDraft` and `submit`; **both** require
the selected form to be published and open. Its JSON body is capped at 128 KiB before parsing,
and its strict, bounded answers and speaker roster reject duplicate normalized speaker emails.
The durable, HMAC-fingerprinted limits run in this scope order: 20 public writes per IP per 10
minutes; 120 per event per hour across both drafts and submits; then, for a submit, 10 per primary
email per 24 hours and 60 submit attempts per event per hour. Those submit buckets are consumed
before later business validation or conflict checks. It still refuses any non-`DRAFT` `abstractId`
with `409 ABSTRACT_LOCKED`, so the anonymous route cannot rewrite a submitted or accepted proposal.

### Bounded admin proposal reads

The event-scoped in-app `GET /api/cfp/submissions` list, like `/admin/abstracts`, is **ADMIN-only**.
Evaluators use their own assignment-scoped `/admin/evaluations` workspace instead. The list returns
at most 100 proposals. It orders submitted proposals by `submittedAt` descending with nulls last,
then by `createdAt` and `id` descending, so drafts trail submitted work. Its envelope carries the
exact total for the applied status/form filters and `hasMore`; callers can narrow those filters
rather than treating a capped result as a complete event export.

The same response includes an organizer decision summary. An explicit `planId` selects an
event-owned review round; one available round is selected automatically, while multiple rounds
require that choice. Its weighted score includes only completed reviews with one valid score for
every current rubric criterion; malformed or partial reviews are excluded, and the response shows
included and completed-review counts.

### Related app endpoints worth knowing

- `POST /api/evaluations/decisions` (admin) atomically provisions the Session and the
  onboarding-task × session-speaker assignments when accepting. It returns the decided
  abstract plus additive `session`, `sessionCreated`, and `tasksAssigned` keys. `session` is
  `{ id, title, isScheduled, scheduledAt, roomName }` or `null`, so the UI can also warn when
  a later decline still leaves a talk on the program. Nothing is auto-deleted
  (INV-DOMAIN-001).
- `POST /api/evaluations/convert` (admin) is the idempotent compatibility/backfill path for
  an accepted abstract whose Session or speaker-task assignments are missing. It returns 201
  for a newly created Session and 200 for an existing one.
- `POST /api/comms/decision` (admin) defaults to preview and requires the signed proof of that
  exact preview before send. It refuses undecided proposals. Optional reviewer feedback
  contains written comments only—never scores or reviewer identities—and all listed speakers
  receive the result.
- With an event email template available, a successful public submit records and attempts one
  receipt to the persisted primary submitter after the abstract transaction commits. There is no
  co-speaker or event-admin notification fan-out. Delivery failure is non-throwing, so it cannot
  erase a saved proposal.
- `POST /api/evaluations/scores` refuses `409 ABSTRACT_WITHDRAWN` once a speaker has withdrawn.
- `PATCH /api/portal/tasks` accepts speaker-owned `TODO`, `IN_PROGRESS`, or `COMPLETED`
  updates and an optional `responses` map. Task-form answers merge with saved answers, run
  through the same conditional/type-aware validator as CFP answers, and block completion
  until every visible required answer is valid. Speakers cannot self-waive assignments.

Full transition rules — including which route performs each status change — are in
[`LIFECYCLE.md`](LIFECYCLE.md).
