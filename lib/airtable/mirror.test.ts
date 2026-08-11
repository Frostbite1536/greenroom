import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAirtableProjection,
  countUnpublishedExclusions,
  mirrorAirtableTable,
  mirrorAirtableTables,
  projectionCounts,
  resolveAirtableMirrorMode,
  summarizeMirrorReport,
  type AirtableRecord,
  type MirrorSession,
} from "./mirror";

const noSleep = async () => {};
const config = { apiKey: "pat_test", baseId: "app_test" };

function records(count: number, prefix = "session"): AirtableRecord[] {
  return Array.from({ length: count }, (_value, index) => ({ fields: { "External ID": `${prefix}:${index}` } }));
}

function batchIds(body: unknown): string[] {
  return (body as { records: AirtableRecord[] }).records.map((record) => String(record.fields["External ID"]));
}

const speaker = {
  id: "speaker-1",
  name: "Ada Lovelace",
  email: "ada@example.test",
  profile: { bio: "Mathematician", company: "Analytical Engines", jobTitle: "Programmer" },
};

const accepted: MirrorSession = {
  id: "session-1", sourceAbstractId: "abstract-1", sourceAbstractStatus: "ACCEPTED",
  contentStatus: "PUBLISHED",
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

/**
 * GRA2-02. Every public read has filtered on `contentStatus: "PUBLISHED"` since
 * the Tier-3 bundle; this projection did not, so a talk withheld from the public
 * site — and its speakers' names, bios and email addresses — was still exported
 * to a third-party base.
 */
test("an unpublished session is never mirrored, however it reached the programme", () => {
  const unpublishedAccepted: MirrorSession = { ...accepted, id: "session-2", contentStatus: "DRAFT" };
  const unpublishedGuaranteed: MirrorSession = {
    ...accepted, id: "session-3", sourceAbstractId: null, sourceAbstractStatus: null,
    contentStatus: "DRAFT", title: "Unannounced keynote",
  };

  const projection = buildAirtableProjection(
    { id: "event-1", name: "Forward 2026" },
    [accepted, unpublishedAccepted, unpublishedGuaranteed],
  );

  // Only the published one survives — in every table, not just Sessions.
  assert.deepEqual(projectionCounts(projection), { Sessions: 1, Speakers: 1, Schedule: 1 });
  assert.deepEqual(
    projection.tables.Sessions.map((record) => record.fields["External ID"]),
    ["session:session-1"],
  );
  assert.deepEqual(
    projection.tables.Schedule.map((record) => record.fields["Session ID"]),
    ["session:session-1"],
  );
  // The withheld titles are nowhere in the payload at all.
  assert.doesNotMatch(JSON.stringify(projection), /Unannounced keynote/);
  assert.doesNotMatch(JSON.stringify(projection), /session:session-2|session:session-3/);
});

test("a published session still flows, and the speaker survives its unpublished sibling", () => {
  // The speaker table is deduplicated across sessions, so an unpublished
  // session must not be the reason a speaker appears — nor the reason one
  // disappears when they also hold a published talk.
  const projection = buildAirtableProjection(
    { id: "event-1", name: "Forward 2026" },
    [accepted, { ...accepted, id: "session-2", contentStatus: "DRAFT" }],
  );
  assert.deepEqual(projectionCounts(projection), { Sessions: 1, Speakers: 1, Schedule: 1 });
  assert.equal(projection.tables.Speakers[0].fields.Email, "ada@example.test");

  // ...and a speaker who appears ONLY on an unpublished session is not exported.
  const other = { ...speaker, id: "speaker-2", email: "grace@example.test" };
  const draftOnly = buildAirtableProjection(
    { id: "event-1", name: "Forward 2026" },
    [accepted, { ...accepted, id: "session-2", contentStatus: "DRAFT", speakers: [{ user: other }] }],
  );
  assert.deepEqual(
    draftOnly.tables.Speakers.map((record) => record.fields.Email),
    ["ada@example.test"],
  );
});

test("the preview count discloses exactly what publishing would release", () => {
  const sessions: MirrorSession[] = [
    accepted,
    { ...accepted, id: "session-2", contentStatus: "DRAFT" },
    { ...accepted, id: "session-3", sourceAbstractId: null, sourceAbstractStatus: null, contentStatus: "DRAFT" },
    // Rejected: not something an operator can publish, so not counted here —
    // counting it would turn an actionable number into noise.
    { ...accepted, id: "session-4", sourceAbstractStatus: "REJECTED", contentStatus: "DRAFT" },
  ];
  assert.equal(countUnpublishedExclusions(sessions), 2);
  // Non-vacuous the other way: an all-published programme reports zero.
  assert.equal(countUnpublishedExclusions([accepted]), 0);
  // And the count agrees with what the projection actually dropped.
  const projection = buildAirtableProjection({ id: "event-1", name: "Forward 2026" }, sessions);
  assert.equal(projectionCounts(projection).Sessions, 1);
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

  const report = await mirrorAirtableTable(fetcher, config, "Sessions", records(11), { sleep: noSleep });
  assert.deepEqual(
    { upserted: report.upserted, failed: report.failed, requests: report.requests, status: "ok" },
    { upserted: 11, failed: 0, requests: 2, status: "ok" },
  );
  assert.equal(batchIds(bodies[0]).length, 10);
  assert.equal(batchIds(bodies[1]).length, 1);
  assert.deepEqual((bodies[0] as { performUpsert: unknown }).performUpsert, { fieldsToMergeOn: ["External ID"] });
});

test("one unmappable row cannot discard the nine valid rows batched with it", async () => {
  const attempts: string[][] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const ids = batchIds(JSON.parse(String(init?.body)));
    attempts.push(ids);
    if (ids.includes("session:3")) {
      return new Response(JSON.stringify({ error: { type: "INVALID_VALUE_FOR_COLUMN", message: "Field 'Track' cannot accept the value." } }), { status: 422 });
    }
    return new Response("{}", { status: 200 });
  };

  const report = await mirrorAirtableTable(fetcher, config, "Sessions", records(10), { sleep: noSleep });
  assert.equal(report.upserted, 9);
  assert.equal(report.failed, 1);
  assert.deepEqual(report.failures, [{
    externalId: "session:3",
    status: 422,
    message: "INVALID_VALUE_FOR_COLUMN: Field 'Track' cannot accept the value.",
  }]);
  // 1 rejected batch + 10 single-record retries; 4xx rows are not retried twice.
  assert.equal(report.requests, 11);
  assert.equal(attempts[0].length, 10);
  assert.deepEqual(attempts.slice(1).map((ids) => ids[0]), records(10).map((record) => String(record.fields["External ID"])));
});

test("transient failures are retried, then recovered per record", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return calls === 1 ? new Response("", { status: 429 }) : new Response("{}", { status: 200 });
  };

  const report = await mirrorAirtableTable(fetcher, config, "Speakers", records(2, "speaker"), { sleep: noSleep });
  assert.deepEqual({ upserted: report.upserted, failed: report.failed, requests: report.requests }, { upserted: 2, failed: 0, requests: 2 });
});

test("network faults are reported per row instead of throwing", async () => {
  const fetcher: typeof fetch = async () => {
    throw new Error("fetch failed");
  };

  const report = await mirrorAirtableTable(fetcher, config, "Schedule", records(1, "slot"), { sleep: noSleep, maxAttempts: 2 });
  assert.equal(report.upserted, 0);
  assert.deepEqual(report.failures, [{ externalId: "slot:0", status: 0, message: "fetch failed" }]);
  // 2 attempts on the batch + 2 on the single-record recovery.
  assert.equal(report.requests, 4);
});

test("a fatal status during per-record recovery stops the table immediately", async () => {
  const singles: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const ids = batchIds(JSON.parse(String(init?.body)));
    if (ids.length > 1) {
      return new Response(JSON.stringify({ error: { type: "INVALID_VALUE_FOR_COLUMN", message: "Bad value." } }), { status: 422 });
    }
    singles.push(ids[0]);
    if (ids[0] === "session:0") return new Response("{}", { status: 200 });
    return new Response(JSON.stringify({ error: { type: "AUTHENTICATION_REQUIRED", message: "Invalid token" } }), { status: 401 });
  };

  const report = await mirrorAirtableTable(fetcher, config, "Sessions", records(12), { sleep: noSleep });
  // 10-record batch rejected → recovery upserts session:0, hits 401 on
  // session:1, and must NOT issue requests for the remaining 10 records.
  assert.deepEqual(singles, ["session:0", "session:1"]);
  assert.deepEqual(
    { upserted: report.upserted, failed: report.failed, requests: report.requests },
    { upserted: 1, failed: 11, requests: 3 },
  );
  const statuses = new Set(report.failures.slice(1).map((failure) => failure.status));
  assert.deepEqual([...statuses], [401]);
});

test("a missing table stops that table instead of amplifying requests", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: { type: "TABLE_NOT_FOUND", message: "Table not found" } }), { status: 404 });
  };

  const report = await mirrorAirtableTable(fetcher, config, "Sessions", records(25), { sleep: noSleep });
  assert.equal(calls, 1);
  assert.deepEqual({ upserted: report.upserted, failed: report.failed, requests: report.requests }, { upserted: 0, failed: 25, requests: 1 });
  assert.equal(report.failures[0].message, "TABLE_NOT_FOUND: Table not found");
});

test("a failing table never aborts the others and the report stays exact", async () => {
  const fetcher: typeof fetch = async (input) => {
    if (String(input).endsWith("/Speakers")) return new Response(JSON.stringify({ error: { type: "NOT_AUTHORIZED", message: "Insufficient permissions" } }), { status: 403 });
    return new Response("{}", { status: 200 });
  };
  const projection = buildAirtableProjection({ id: "event-1", name: "Forward 2026" }, [accepted]);

  const report = await mirrorAirtableTables(fetcher, config, projection, { sleep: noSleep });
  assert.equal(report.status, "partial");
  assert.deepEqual({ attempted: report.attempted, upserted: report.upserted, failed: report.failed }, { attempted: 3, upserted: 2, failed: 1 });
  assert.deepEqual(report.tables.map((table) => [table.table, table.upserted, table.failed]), [["Sessions", 1, 0], ["Speakers", 0, 1], ["Schedule", 1, 0]]);
  assert.match(summarizeMirrorReport(report), /^2\/3 records upserted, 1 failed \(first failure — Speakers\/speaker:speaker-1: 403 NOT_AUTHORIZED/);
});

test("a mirror that writes nothing reports failed, and a clean one reports complete", async () => {
  const projection = buildAirtableProjection({ id: "event-1", name: "Forward 2026" }, [accepted]);
  const dead: typeof fetch = async () => new Response("", { status: 403 });
  const healthy: typeof fetch = async () => new Response("{}", { status: 200 });

  assert.equal((await mirrorAirtableTables(dead, config, projection, { sleep: noSleep })).status, "failed");
  const clean = await mirrorAirtableTables(healthy, config, projection, { sleep: noSleep });
  assert.equal(clean.status, "complete");
  assert.equal(summarizeMirrorReport(clean), "3/3 records upserted, 0 failed");
});
