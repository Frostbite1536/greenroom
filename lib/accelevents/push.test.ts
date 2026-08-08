import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceleventsPushSummary,
  buildAcceleventsPushPayload,
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
