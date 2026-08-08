# Read-only REST API (v1)

The v1 API is an optional server-to-server, read-only surface. Set
`GREENROOM_API_KEY` on the server to enable it. Use a random value of at least
32 characters. When the variable is unset or too short, all v1 routes return
`503 API_KEY_NOT_CONFIGURED`; the key is never safe to expose in browser code.

Authenticate with either `Authorization: Bearer <key>` or `X-API-Key: <key>`.
Every request must provide an explicit `event` query parameter containing the
event's slug or id. Unknown events return `404 EVENT_NOT_FOUND`.

```bash
export BASE_URL="https://your-app.example"
export GREENROOM_API_KEY="your-server-api-key"

curl -H "Authorization: Bearer $GREENROOM_API_KEY" \
  "$BASE_URL/api/v1/submissions?event=forward-2026&limit=50&offset=0"

curl -H "X-API-Key: $GREENROOM_API_KEY" \
  "$BASE_URL/api/v1/speakers?event=forward-2026"

curl -H "Authorization: Bearer $GREENROOM_API_KEY" \
  "$BASE_URL/api/v1/schedule?event=forward-2026"
```

## Common response shape

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

## Endpoints

| Endpoint | Data | Ordering |
| --- | --- | --- |
| `GET /api/v1/submissions` | Event-scoped proposals, form/category, speakers, and answer values. Review assignments, scores, and private comments are never returned. | `createdAt`, `id` ascending |
| `GET /api/v1/speakers` | People derived only from this event's abstract or session speaker relations, with their profile and event-local appearance counts. | `name`, `id` ascending |
| `GET /api/v1/schedule` | Only placed sessions, including their slot, room, optional track, and session speakers. | `startsAt`, `id` ascending |

All three endpoints accept `event=<slug|id>`, `limit=<1..100>`, and
`offset=<0..1000000>`.
