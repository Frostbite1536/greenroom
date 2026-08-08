import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAirtableProjection,
  projectionCounts,
  resolveAirtableMirrorMode,
  upsertAirtableTable,
  type MirrorSession,
} from "./mirror";

const speaker = {
  id: "speaker-1",
  name: "Ada Lovelace",
  email: "ada@example.test",
  profile: { bio: "Mathematician", company: "Analytical Engines", jobTitle: "Programmer" },
};

const accepted: MirrorSession = {
  id: "session-1", sourceAbstractId: "abstract-1", sourceAbstractStatus: "ACCEPTED",
  title: "Analytical Engines", description: "A talk", format: "Talk", durationMinutes: 30,
  speakers: [{ user: speaker }],
  scheduleSlot: { id: "slot-1", startsAt: new Date("2026-05-12T09:00:00.000Z"), endsAt: new Date("2026-05-12T09:30:00.000Z"), roomName: "Hall A", trackName: "Engineering" },
};

test("projection keeps accepted and guaranteed sessions while deduplicating speakers", () => {
  const projection = buildAirtableProjection(
    { id: "event-1", name: "Forward 2026" },
    [accepted, { ...accepted, id: "session-2", sourceAbstractId: null, title: "Keynote" }, { ...accepted, id: "session-3", sourceAbstractStatus: "REJECTED" }],
  );
  assert.deepEqual(projectionCounts(projection), { Sessions: 2, Speakers: 1, Schedule: 2 });
  assert.equal(projection.tables.Sessions[0].fields["External ID"], "session:session-1");
  assert.equal(projection.tables.Speakers[0].fields.Email, "ada@example.test");
  assert.equal(projection.tables.Schedule[0].fields["Session ID"], "session:session-1");
});

test("Airtable writes require explicit live-mode configuration", () => {
  assert.deepEqual(resolveAirtableMirrorMode({ dryRun: true, mockExternalApis: false, apiKey: "pat", baseId: "app" }), { mode: "preview", reason: "dry_run" });
  assert.deepEqual(resolveAirtableMirrorMode({ dryRun: false, mockExternalApis: false }), { mode: "noop", reason: "missing_airtable_configuration" });
  assert.deepEqual(resolveAirtableMirrorMode({ dryRun: false, mockExternalApis: true, apiKey: "pat", baseId: "app" }), { mode: "noop", reason: "mock_external_apis_enabled" });
  assert.deepEqual(resolveAirtableMirrorMode({ dryRun: false, mockExternalApis: false, apiKey: "pat", baseId: "app" }), { mode: "live" });
});

test("live upserts use stable merge keys and Airtable's ten-record batches", async () => {
  const bodies: unknown[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  };
  const records = Array.from({ length: 11 }, (_value, index) => ({ fields: { "External ID": `session:${index}` } }));

  const batches = await upsertAirtableTable(fetcher, { apiKey: "pat_test", baseId: "app_test" }, "Sessions", records);
  assert.equal(batches, 2);
  assert.equal((bodies[0] as { records: unknown[] }).records.length, 10);
  assert.equal((bodies[1] as { records: unknown[] }).records.length, 1);
  assert.deepEqual((bodies[0] as { performUpsert: unknown }).performUpsert, { fieldsToMergeOn: ["External ID"] });
});
