import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  acceleventsPushSummary,
  buildAcceleventsPushPayload,
  countUnpublishedExclusions,
  postAcceleventsPush,
  resolveAcceleventsPushMode,
  type AcceleventsSourceSession,
} from "./push";

const speaker = {
  id: "speaker-1",
  name: "Ada Lovelace",
  email: "ada@example.test",
  profile: { bio: "Mathematician", company: "Analytical Engines", jobTitle: "Programmer" },
};

const accepted: AcceleventsSourceSession = {
  id: "session-1", sourceAbstractId: "abstract-1", sourceAbstractStatus: "ACCEPTED",
  contentStatus: "PUBLISHED",
  title: "Analytical Engines", description: "A talk", format: "Talk", durationMinutes: 30,
  speakers: [{ user: speaker }],
  scheduleSlot: { id: "slot-1", startsAt: new Date("2026-05-12T09:00:00.000Z"), endsAt: new Date("2026-05-12T09:30:00.000Z"), roomName: "Hall A", trackName: "Engineering" },
};

test("projection includes accepted and guaranteed sessions, dedupes speakers, and preserves schedule", () => {
  const payload = buildAcceleventsPushPayload(
    { id: "event-1", name: "Forward 2026", slug: "forward-2026" },
    [accepted, { ...accepted, id: "session-2", sourceAbstractId: null, title: "Keynote" }, { ...accepted, id: "session-3", sourceAbstractStatus: "REJECTED" }],
  );
  assert.deepEqual(acceleventsPushSummary(payload), { sessions: 2, speakers: 1, scheduledSessions: 2 });
  assert.equal(payload.event.externalId, "event:event-1");
  assert.equal(payload.sessions[0].externalId, "session:session-1");
  assert.equal(payload.sessions[0].schedule?.externalId, "slot:slot-1");
  assert.deepEqual(payload.sessions[0].speakerExternalIds, ["speaker:speaker-1"]);
});

/**
 * GRA2-02. The push shipped whatever was accepted, regardless of the organizer's
 * publish decision — so a talk the public site withholds, and its speakers'
 * names, bios and email addresses, went to the configured endpoint anyway.
 */
test("an unpublished session is never pushed, however it reached the programme", () => {
  const payload = buildAcceleventsPushPayload(
    { id: "event-1", name: "Forward 2026", slug: "forward-2026" },
    [
      accepted,
      // Unpublished but ACCEPTED.
      { ...accepted, id: "session-2", contentStatus: "DRAFT", title: "Held back" },
      // Unpublished and source-less: the "guaranteed session" path, which the
      // acceptance check waved straight through.
      {
        ...accepted, id: "session-3", sourceAbstractId: null, sourceAbstractStatus: null,
        contentStatus: "DRAFT", title: "Unannounced keynote",
      },
    ],
  );

  assert.deepEqual(payload.sessions.map((session) => session.externalId), ["session:session-1"]);
  // Nothing about the withheld talks leaks through any other field.
  assert.doesNotMatch(JSON.stringify(payload), /Held back|Unannounced keynote/);
});

test("a speaker known only from an unpublished session is not disclosed", () => {
  const other = { ...speaker, id: "speaker-2", email: "grace@example.test" };
  const payload = buildAcceleventsPushPayload(
    { id: "event-1", name: "Forward 2026", slug: "forward-2026" },
    [accepted, { ...accepted, id: "session-2", contentStatus: "DRAFT", speakers: [{ user: other }] }],
  );
  assert.deepEqual(payload.speakers.map((entry) => entry.email), ["ada@example.test"]);
  assert.doesNotMatch(JSON.stringify(payload), /grace@example\.test/);
});

test("the dry-run summary discloses exactly what publishing would release", () => {
  const sessions: AcceleventsSourceSession[] = [
    accepted,
    { ...accepted, id: "session-2", contentStatus: "DRAFT" },
    { ...accepted, id: "session-3", sourceAbstractId: null, sourceAbstractStatus: null, contentStatus: "DRAFT" },
    // A rejected proposal is not publishable, so it is not an actionable
    // exclusion and is deliberately not counted.
    { ...accepted, id: "session-4", sourceAbstractStatus: "REJECTED", contentStatus: "DRAFT" },
  ];
  assert.equal(countUnpublishedExclusions(sessions), 2);
  assert.equal(countUnpublishedExclusions([accepted]), 0);

  const payload = buildAcceleventsPushPayload(
    { id: "event-1", name: "Forward 2026", slug: "forward-2026" },
    sessions,
  );
  // `summary` keeps its exact three fields — the operations panel renders every
  // numeric key of it as "<n> <fieldname>", so a fourth key would surface as
  // "2 excludedunpublishedsessions". The count ships as a sibling instead.
  assert.deepEqual(acceleventsPushSummary(payload), {
    sessions: 1,
    speakers: 1,
    scheduledSessions: 1,
  });
});

test("both integration routes disclose the exclusion the same way", () => {
  const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

  const PUSH = "app/api/integrations/accelevents/push/route.ts";
  const MIRROR = "app/api/comms/airtable/mirror/route.ts";

  for (const route of [PUSH, MIRROR]) {
    const text = source(route);
    // The column is selected, so the predicate has something to filter on — the
    // audit's finding was that neither query asked for it at all.
    assert.match(text, /contentStatus: true/, `${route} must select contentStatus`);
    // It is carried onto the projection input, not dropped in the mapping.
    assert.match(text, /contentStatus: session\.contentStatus/, `${route} must map contentStatus`);
    assert.match(
      text,
      /const excluded = \{ unpublishedSessions: countUnpublishedExclusions\(/,
      `${route} must compute the exclusion count`,
    );
  }

  // Disclosed on the preview/noop path AND the live path, in both routes.
  const push = source(PUSH);
  assert.match(push, /return ok\(\{ \.\.\.decision, summary, excluded \}\)/);
  assert.match(push, /return ok\(\{ mode: "live" as const, summary, excluded \}\)/);
  const mirror = source(MIRROR);
  assert.match(mirror, /return ok\(\{ \.\.\.decision, counts, excluded, report: null \}\)/);
  assert.match(mirror, /return ok\(\{ mode: "live" as const, counts, excluded, report \}\)/);
});

test("mock/default settings cannot enter live mode", () => {
  assert.deepEqual(resolveAcceleventsPushMode({ dryRun: true, mockExternalApis: false, endpoint: "https://x.test/push" }), { mode: "preview", reason: "dry_run" });
  assert.deepEqual(resolveAcceleventsPushMode({ dryRun: false, mockExternalApis: false }), { mode: "noop", reason: "missing_accelevents_endpoint" });
  assert.deepEqual(resolveAcceleventsPushMode({ dryRun: false, mockExternalApis: true, endpoint: "https://x.test/push" }), { mode: "noop", reason: "mock_external_apis_enabled" });
});

test("live request uses the configured endpoint and optional Authorization credential", async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ input, init });
    return new Response("{}", { status: 200 });
  };
  const payload = buildAcceleventsPushPayload({ id: "event-1", name: "Forward 2026", slug: "forward-2026" }, [accepted]);
  await postAcceleventsPush(fetcher, { endpoint: "https://relay.example.test/push", apiKey: "token" }, payload);
  assert.equal(requests[0].input, "https://relay.example.test/push");
  assert.equal(requests[0].init?.method, "POST");
  assert.equal((requests[0].init?.headers as Record<string, string>).Authorization, "token");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), payload);
});
