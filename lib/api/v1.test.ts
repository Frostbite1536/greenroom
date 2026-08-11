import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeV1Request,
  getV1PaginationMeta,
  handleV1,
  keysMatch,
  parseV1ListQuery,
} from "@/lib/api/v1";
import {
  serializeV1ScheduleSlot,
  serializeV1Speaker,
  serializeV1Submission,
} from "@/lib/api/v1-serialize";

/**
 * No per-event credential resolves for any of these cases, so this file
 * exercises the deployment-wide key path in isolation — which is what makes it
 * the regression test for "the global key behaves exactly as it always did".
 * The per-event half lives in `lib/services/api-credential.test.ts`.
 */
const noCredentials = async () => null;

test("v1 auth accepts Bearer and X-API-Key without exposing key differences", async () => {
  assert.equal(keysMatch("secret", "secret"), true);
  assert.equal(keysMatch("secret", "different"), false);
  assert.deepEqual(
    await authorizeV1Request(new Headers({ authorization: "Bearer secret" }), "secret", noCredentials),
    { ok: true, scope: { kind: "global" } },
  );
  assert.deepEqual(
    await authorizeV1Request(new Headers({ "x-api-key": "secret" }), "secret", noCredentials),
    { ok: true, scope: { kind: "global" } },
  );
  assert.equal(
    (await authorizeV1Request(
      new Headers({ authorization: "Basic not-a-bearer-key", "x-api-key": "secret" }),
      "secret",
      noCredentials,
    )).ok,
    false,
  );

  const wrong = await authorizeV1Request(new Headers({ authorization: "Bearer wrong" }), "secret", noCredentials);
  assert.deepEqual(wrong, {
    ok: false,
    error: { status: 401, code: "UNAUTHORIZED", message: "A valid API key is required." },
  });

  // Nothing presented and nothing configured: still the fail-closed 503 that
  // tells an operator this surface was never switched on.
  const unavailable = await authorizeV1Request(new Headers(), undefined, noCredentials);
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.error.status, 503);

  // Presenting a credential against a deployment with no deployment-wide key is
  // NOT the unconfigured case any more: per-event credentials have to work
  // without one, so the presented value is resolved and an unresolvable one is
  // a plain refusal. This is the one behaviour change scoped credentials make
  // in the neighbourhood of the global path, and it is deliberate.
  const rejected = await authorizeV1Request(
    new Headers({ authorization: "Bearer anything" }),
    undefined,
    noCredentials,
  );
  assert.deepEqual(rejected, {
    ok: false,
    error: { status: 401, code: "UNAUTHORIZED", message: "A valid API key is required." },
  });
});

test("v1 query requires an event and bounds offset pagination", () => {
  const missing = parseV1ListQuery(new URLSearchParams());
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, "EVENT_REQUIRED");

  assert.deepEqual(parseV1ListQuery(new URLSearchParams("event=event-1&limit=2&offset=4")), {
    ok: true,
    value: { event: "event-1", limit: 2, offset: 4 },
  });
  const invalid = parseV1ListQuery(new URLSearchParams("event=event-1&limit=101&offset=-1"));
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, "INVALID_QUERY");

  assert.deepEqual(
    getV1PaginationMeta({ event: "event-1", limit: 2, offset: 2 }, 5),
    { limit: 2, offset: 2, total: 5, hasMore: true, nextOffset: 4 },
  );
});

test("v1 handler preserves the versioned error envelope for unexpected failures", async () => {
  const route = handleV1(async () => {
    throw new Error("database connection details must not reach clients");
  });
  const response = await route(new Request("http://localhost/api/v1/submissions"));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    version: "v1",
    data: null,
    error: { code: "INTERNAL_ERROR", message: "Something went wrong." },
    meta: null,
  });
});

test("v1 serializers expose scoped public records without review data", () => {
  const now = new Date("2026-01-02T03:04:05.000Z");
  const submission = serializeV1Submission({
    id: "abstract-1", title: "Proposal", abstract: "Description", format: "TALK", durationMinutes: 30,
    status: "SUBMITTED", submittedAt: now, createdAt: now, updatedAt: now,
    formConfig: { id: "form-1", name: "CFP", slug: "cfp" },
    category: { id: "category-1", name: "Platform" },
    speakers: [{ isPrimary: true, user: { id: "user-1", name: "Ava", email: "ava@example.test" } }],
    answers: [{ formField: { key: "experience" }, value: "advanced" }],
  });
  assert.deepEqual(submission.answers, { experience: "advanced" });
  assert.equal("reviews" in submission, false);
  assert.equal("scores" in submission, false);

  const speaker = serializeV1Speaker({
    id: "user-1", name: "Ava", email: "ava@example.test", avatarUrl: null,
    speakerProfile: { bio: "Bio", company: null, jobTitle: null, headshotUrl: null, slideDeckUrl: null, socialLinks: null },
    appearances: { submissions: 1, sessions: 2 },
  });
  assert.deepEqual(speaker.appearances, { submissions: 1, sessions: 2 });

  const slot = serializeV1ScheduleSlot({
    id: "slot-1", startsAt: now, endsAt: new Date("2026-01-02T03:34:05.000Z"),
    room: { id: "room-1", name: "Main", capacity: 100 }, track: null,
    session: {
      id: "session-1", title: "Session", description: null, format: "TALK", durationMinutes: 30,
      speakers: [{ isPrimary: true, user: { id: "user-1", name: "Ava", email: "ava@example.test" } }],
    },
  });
  assert.equal(slot.session.speakers[0]?.isPrimary, true);
  assert.equal(slot.startsAt, "2026-01-02T03:04:05.000Z");
});
