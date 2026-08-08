# APIs

Greenroom exposes two separate API surfaces:

- **`/api/v1/*`** — the versioned, read-only, API-key-gated surface below. Intended for
  server-to-server integrations.
- **`/api/*`** — the application's own endpoints, used by the app's pages and authorized by
  the signed session cookie. They are **not** part of the v1 contract, are not reachable with
  an API key, and may change without a version bump. The speaker-facing ones are documented
  at the end of this file.

## Read-only REST API (v1)

The v1 API is an optional server-to-server, read-only surface. Set
`GREENROOM_API_KEY` on the server to enable it. Use a random value of at least
32 characters. When the variable is unset or too short, all v1 routes return
`503 API_KEY_NOT_CONFIGURED`; the key is never safe to expose in browser code.

Authenticate with either `Authorization: Bearer <key>` or `X-API-Key: <key>`.
Every request must provide an explicit `event` query parameter containing the
event's slug or id. Unknown events return `404 EVENT_NOT_FOUND`.

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
`INVALID_QUERY` (400), `EVENT_NOT_FOUND` (404), and `API_KEY_NOT_CONFIGURED`
(503).

### Endpoints

| Endpoint | Data | Ordering |
| --- | --- | --- |
| `GET /api/v1/submissions` | Event-scoped proposals, form/category, speakers, and answer values. Review assignments, scores, and private comments are never returned. | `createdAt`, `id` ascending |
| `GET /api/v1/speakers` | People derived only from this event's abstract or session speaker relations, with their profile and event-local appearance counts. | `name`, `id` ascending |
| `GET /api/v1/schedule` | Only placed sessions, including their slot, room, optional track, and session speakers. | `startsAt`, `id` ascending |

All three endpoints accept `event=<slug|id>`, `limit=<1..100>`, and
`offset=<0..1000000>`.

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
Allowed from `DRAFT`, `SUBMITTED`, and `UNDER_REVIEW`; `ACCEPTED` or any abstract with a
linked `Session` is refused with `409 WITHDRAW_NOT_ALLOWED`. `decidedAt` stays null.

Status codes:

| Code | When |
| --- | --- |
| `401 UNAUTHENTICATED` | no session, or the signed-in email has no membership in the event |
| `403 NOT_YOUR_SUBMISSION` | signed in, but not a speaker on that abstract |
| `404 ABSTRACT_NOT_FOUND` | no such abstract in the caller's event (checked before ownership, so it never confirms another event's records) |
| `409 ABSTRACT_LOCKED` | the abstract is `REJECTED` or `WITHDRAWN` |
| `409 SPEAKERS_LOCKED` | the roster was changed after the abstract was converted to a session |
| `409 WITHDRAW_NOT_ALLOWED` | self-withdraw attempted on an accepted or already-converted proposal |
| `422 VALIDATION_ERROR` | the body itself is malformed (field errors keyed by body path) |
| `422 FIELD_ERRORS` / `TOO_FEW_SPEAKERS` / `TOO_MANY_SPEAKERS` | the merged result fails the form's own content rules; `FIELD_ERRORS` carries `fieldErrors` keyed by form-field key |
| `422 NO_PRIMARY_SPEAKER` / `INVALID_CATEGORY` | a supplied roster has no primary speaker, or the category is not in this event |

The **public** `POST /api/cfp/submissions` path is unchanged and still refuses any non-`DRAFT`
abstract with `409 ABSTRACT_LOCKED`: it is unauthenticated, so it must never be a way to
rewrite a submitted or accepted proposal.

### Related app endpoints worth knowing

- `POST /api/evaluations/decisions` (admin) returns the decided abstract plus an additive
  `session` key — `{ id, title, isScheduled, scheduledAt, roomName }` or `null` — so the UI
  can warn when a declined or withdrawn proposal still has a talk on the programme (W2).
  Nothing is auto-deleted (INV-DOMAIN-001).
- `POST /api/evaluations/scores` refuses `409 ABSTRACT_WITHDRAWN` once a speaker has withdrawn.

Full transition rules — including which route performs each status change — are in
[`LIFECYCLE.md`](LIFECYCLE.md).
