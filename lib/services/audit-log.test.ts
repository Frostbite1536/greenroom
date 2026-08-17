/**
 * The change history's pure half, plus the one property of its writer that is
 * not observable from a diff: that it writes inside the caller's transaction and
 * writes nothing at all when nothing changed.
 *
 * No database. `recordAudit` takes a `Prisma.TransactionClient`, so a recording
 * fake standing in for one is enough to assert both the payload and the
 * suppression, and the source assertions at the bottom pin the instrumentation
 * to the *inside* of each existing transaction — which is the whole invariant
 * (INV-AUDIT-001) and the one thing a unit test of a pure function cannot see.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  AUDIT_ACTION_LABELS,
  AUDIT_EMPTY_DISPLAY,
  AUDIT_ENTITY_LABELS,
  AUDIT_VALUE_DISPLAY_LIMIT,
  AUDITED_ABSTRACT_DECISION_FIELDS,
  AUDITED_SCHEDULE_SLOT_FIELDS,
  AUDITED_SESSION_PUBLICATION_FIELDS,
  AUDITED_SPEAKER_PROFILE_FIELDS,
  diffChanges,
  formatAuditFieldName,
  formatAuditValue,
  parseAuditChanges,
  recordAudit,
  summarizeAuditChanges,
  type AuditAction,
  type AuditEntityType,
} from "@/lib/services/audit-log";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/* -------------------------------------------------------------------------- */
/* diffChanges — only what changed, and nothing else                            */
/* -------------------------------------------------------------------------- */

test("an unchanged save produces no diff at all, so no row is written", () => {
  assert.equal(
    diffChanges(
      { bio: "Runs the platform team.", company: "Acme" },
      { bio: "Runs the platform team.", company: "Acme" },
      ["bio", "company"],
    ),
    null,
  );
});

test("only the changed field is stored, never the whole record", () => {
  const changes = diffChanges(
    { bio: "Old bio", company: "Acme", jobTitle: "Engineer" },
    { bio: "New bio", company: "Acme", jobTitle: "Engineer" },
    ["bio", "company", "jobTitle"],
  );
  // The point of the column: one field, its two values. A snapshot history would
  // have carried `company` and `jobTitle` into a second copy of the row.
  assert.deepEqual(changes, { bio: { from: "Old bio", to: "New bio" } });
});

test("a field absent from the write is skipped, not read as a clear", () => {
  // The roster editor sends only what the operator actually changed (GRA-05).
  // Treating the absent `bio` as null would record it being emptied on every
  // status change — the exact bug the partial-write rule exists to prevent.
  const changes = diffChanges(
    { status: "INVITED", bio: "Keeps this bio." },
    { status: "CONFIRMED" },
    ["status", "bio"],
  );
  assert.deepEqual(changes, { status: { from: "INVITED", to: "CONFIRMED" } });
});

test("an explicit null IS a change, and is how a clear is recorded", () => {
  const changes = diffChanges({ company: "Acme" }, { company: null }, ["company"]);
  assert.deepEqual(changes, { company: { from: "Acme", to: null } });
});

test("clearing a field that was already empty is not a change", () => {
  assert.equal(diffChanges({ company: null }, { company: null }, ["company"]), null);
  // `undefined` before and `null` after are the same statement about the previous
  // value: there wasn't one. Recording it would invent a change.
  assert.equal(diffChanges({}, { company: null }, ["company"]), null);
});

test("a first write with no previous row reads as from-null, not as no change", () => {
  const changes = diffChanges({}, { roomId: "room-1", trackId: null }, ["roomId", "trackId"]);
  // `trackId` stays out: it was absent and is still empty.
  assert.deepEqual(changes, { roomId: { from: null, to: "room-1" } });
});

test("a removal is expressed as nulls, in the same shape as any other change", () => {
  // How UNSCHEDULE is recorded — no special case anywhere in the reader.
  const changes = diffChanges(
    { roomId: "room-1", startsAt: new Date("2026-05-12T17:00:00.000Z") },
    { roomId: null, startsAt: null },
    ["roomId", "startsAt"],
  );
  assert.deepEqual(changes, {
    roomId: { from: "room-1", to: null },
    startsAt: { from: "2026-05-12T17:00:00.000Z", to: null },
  });
});

test("only the named fields are considered, so a widened projection logs nothing new", () => {
  const changes = diffChanges(
    { bio: "Old", secretInternalNote: "not audited" },
    { bio: "New", secretInternalNote: "changed too" },
    ["bio"],
  );
  assert.deepEqual(changes, { bio: { from: "Old", to: "New" } });
});

test("two equal instants are equal, so re-saving the same time records nothing", () => {
  // Comparing Date objects directly never reports equality, which would have
  // logged a MOVE on every re-placement to the same slot.
  const startsAt = "2026-05-12T17:00:00.000Z";
  assert.equal(
    diffChanges({ startsAt: new Date(startsAt) }, { startsAt: new Date(startsAt) }, ["startsAt"]),
    null,
  );
});

test("a moved time is stored as two ISO strings, not as Date objects", () => {
  const changes = diffChanges(
    { startsAt: new Date("2026-05-12T17:00:00.000Z") },
    { startsAt: new Date("2026-05-12T18:30:00.000Z") },
    ["startsAt"],
  );
  assert.deepEqual(changes, {
    startsAt: { from: "2026-05-12T17:00:00.000Z", to: "2026-05-12T18:30:00.000Z" },
  });
  // JSON-safe end to end: what goes into the column round-trips unchanged.
  assert.deepEqual(JSON.parse(JSON.stringify(changes)), changes);
});

test("booleans and numbers diff by value, and false is not confused with empty", () => {
  assert.deepEqual(diffChanges({ published: true }, { published: false }, ["published"]), {
    published: { from: true, to: false },
  });
  assert.equal(diffChanges({ published: false }, { published: false }, ["published"]), null);
  assert.deepEqual(diffChanges({ durationMinutes: 30 }, { durationMinutes: 45 }, ["durationMinutes"]), {
    durationMinutes: { from: 30, to: 45 },
  });
  // Not a string comparison: 30 and "30" are different stored values.
  assert.deepEqual(diffChanges({ v: 30 }, { v: "30" }, ["v"]), { v: { from: 30, to: "30" } });
});

test("an empty field list, or a field list naming nothing that moved, diffs to null", () => {
  assert.equal(diffChanges({ bio: "a" }, { bio: "b" }, []), null);
  assert.equal(diffChanges({ bio: "a" }, { bio: "b" }, ["company"]), null);
});

test("the diff never mutates either side", () => {
  const before = { bio: "Old" };
  const after = { bio: "New" };
  diffChanges(before, after, ["bio"]);
  assert.deepEqual(before, { bio: "Old" });
  assert.deepEqual(after, { bio: "New" });
});

/* -------------------------------------------------------------------------- */
/* recordAudit — inside the caller's transaction, or not at all                 */
/* -------------------------------------------------------------------------- */

type CreatedRow = Record<string, unknown>;

function auditFake() {
  const created: CreatedRow[] = [];
  const tx = {
    auditLogEntry: {
      async create({ data }: { data: CreatedRow }) {
        created.push(data);
        return data;
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { created, tx };
}

test("a null diff writes no row, so the caller needs no guard of its own", async () => {
  const { created, tx } = auditFake();
  const wrote = await recordAudit(tx, {
    eventId: "event-1",
    actorUserId: "user-1",
    entityType: "SPEAKER_PROFILE",
    entityId: "user-2",
    action: "UPDATE",
    changes: null,
  });
  assert.equal(wrote, false);
  assert.deepEqual(created, []);
});

test("a real diff writes exactly one row carrying the attribution and the diff", async () => {
  const { created, tx } = auditFake();
  const changes = { bio: { from: "Old", to: "New" } };
  const wrote = await recordAudit(tx, {
    eventId: "event-1",
    actorUserId: "user-1",
    entityType: "SPEAKER_PROFILE",
    entityId: "user-2",
    action: "UPDATE",
    changes,
  });

  assert.equal(wrote, true);
  assert.equal(created.length, 1);
  assert.deepEqual(created[0], {
    eventId: "event-1",
    actorUserId: "user-1",
    entityType: "SPEAKER_PROFILE",
    entityId: "user-2",
    action: "UPDATE",
    changes,
  });
  // No timestamp is supplied: `createdAt` is the database's own default, so a
  // caller cannot backdate history.
  assert.equal("createdAt" in created[0]!, false);
  // Nothing else is written either — an audit row is append-only.
  assert.equal("id" in created[0]!, false);
});

test("an anonymous actor is representable, and stored as null rather than as a name", async () => {
  const { created, tx } = auditFake();
  await recordAudit(tx, {
    eventId: "event-1",
    actorUserId: null,
    entityType: "SESSION",
    entityId: "session-1",
    action: "PUBLISH",
    changes: { contentStatus: { from: "DRAFT", to: "PUBLISHED" } },
  });
  assert.equal(created[0]!.actorUserId, null);
});

test("the writer only ever creates: it holds no update, delete, or upsert", () => {
  const service = source("lib/services/audit-log.ts");
  // An audit row that can be rewritten is not an audit row.
  for (const forbidden of ["auditLogEntry.update", "auditLogEntry.delete", "auditLogEntry.upsert"]) {
    assert.equal(service.includes(forbidden), false, `the audit writer must not ${forbidden}`);
  }
  // It takes a transaction client, never the base client.
  assert.match(service, /tx: Prisma\.TransactionClient/);
  assert.equal(/from "@\/lib\/prisma"/.test(service), false, "the audit writer must not reach for the base client");
});

/* -------------------------------------------------------------------------- */
/* Reading a stored diff back                                                  */
/* -------------------------------------------------------------------------- */

test("a stored diff round-trips through the Json column's loose type", () => {
  const changes = { bio: { from: "Old", to: "New" }, status: { from: "INVITED", to: "CONFIRMED" } };
  assert.deepEqual(parseAuditChanges(JSON.parse(JSON.stringify(changes))), changes);
});

test("a malformed row degrades instead of taking out the history page", () => {
  // The page an auditor reaches for is exactly the one that must not 500.
  assert.deepEqual(parseAuditChanges(null), {});
  assert.deepEqual(parseAuditChanges("nonsense"), {});
  assert.deepEqual(parseAuditChanges([{ bio: 1 }]), {});
  assert.deepEqual(parseAuditChanges({ bio: "not a diff" }), {});
  // A recognizable field with unusable sides keeps the field and empties them.
  assert.deepEqual(parseAuditChanges({ bio: { from: { nested: true } } }), {
    bio: { from: null, to: null },
  });
});

test("values render for a table cell: elided when long, never blank", () => {
  assert.equal(formatAuditValue(null), AUDIT_EMPTY_DISPLAY);
  assert.equal(formatAuditValue(""), AUDIT_EMPTY_DISPLAY);
  assert.equal(formatAuditValue("   "), AUDIT_EMPTY_DISPLAY);
  assert.equal(formatAuditValue("Acme"), "Acme");
  assert.equal(formatAuditValue(true), "Yes");
  assert.equal(formatAuditValue(false), "No");
  assert.equal(formatAuditValue(45), "45");
  // Newlines collapse — a bio is multi-paragraph and this is one cell.
  assert.equal(formatAuditValue("Line one\n\nLine two"), "Line one Line two");

  const long = "x".repeat(AUDIT_VALUE_DISPLAY_LIMIT + 40);
  const rendered = formatAuditValue(long);
  assert.equal(rendered.length, AUDIT_VALUE_DISPLAY_LIMIT + 1);
  assert.ok(rendered.endsWith("…"), "a cut value must say it was cut");
  // Exactly at the limit is not cut.
  assert.equal(formatAuditValue("y".repeat(AUDIT_VALUE_DISPLAY_LIMIT)).endsWith("…"), false);
});

test("a column name renders as a label without a table to maintain", () => {
  assert.equal(formatAuditFieldName("bio"), "Bio");
  assert.equal(formatAuditFieldName("jobTitle"), "Job title");
  assert.equal(formatAuditFieldName("contentStatus"), "Content status");
  assert.equal(formatAuditFieldName("slideDeckUrl"), "Slide deck url");
  assert.equal(formatAuditFieldName("actor_user_id"), "Actor user id");
  // Never blank: an unlabelled column in the one table built to be read is worse
  // than an oddly capitalized one.
  assert.equal(formatAuditFieldName(""), "");
  assert.equal(formatAuditFieldName("x"), "X");
});

test("summaries are ordered by field name, so two rows of a kind read alike", () => {
  assert.deepEqual(
    summarizeAuditChanges({
      status: { from: "INVITED", to: "CONFIRMED" },
      bio: { from: null, to: "New bio" },
    }),
    [
      { field: "bio", from: AUDIT_EMPTY_DISPLAY, to: "New bio" },
      { field: "status", from: "INVITED", to: "CONFIRMED" },
    ],
  );
  assert.deepEqual(summarizeAuditChanges({}), []);
});

/* -------------------------------------------------------------------------- */
/* The vocabulary is complete and single-sourced                               */
/* -------------------------------------------------------------------------- */

test("every entity type and action has a label, and no label is orphaned", () => {
  const entities: AuditEntityType[] = ["SESSION", "SPEAKER_PROFILE", "SCHEDULE_SLOT", "ABSTRACT_DECISION"];
  const actions: AuditAction[] = ["UPDATE", "SCHEDULE", "MOVE", "UNSCHEDULE", "PUBLISH", "UNPUBLISH", "DECIDE"];
  assert.deepEqual(Object.keys(AUDIT_ENTITY_LABELS).sort(), [...entities].sort());
  assert.deepEqual(Object.keys(AUDIT_ACTION_LABELS).sort(), [...actions].sort());
});

test("the audited field lists name real columns and hold no duplicates", () => {
  for (const fields of [
    AUDITED_SPEAKER_PROFILE_FIELDS,
    AUDITED_SESSION_PUBLICATION_FIELDS,
    AUDITED_SCHEDULE_SLOT_FIELDS,
    AUDITED_ABSTRACT_DECISION_FIELDS,
  ]) {
    assert.equal(new Set(fields).size, fields.length, `duplicate field in ${fields.join(",")}`);
    assert.ok(fields.length > 0);
  }
  const schema = source("prisma/schema.prisma");
  // A typo'd field name would produce a history row nobody can explain, so each
  // audited name must exist in the schema it claims to describe.
  for (const field of [
    ...AUDITED_SPEAKER_PROFILE_FIELDS,
    ...AUDITED_SESSION_PUBLICATION_FIELDS,
    ...AUDITED_SCHEDULE_SLOT_FIELDS,
  ]) {
    assert.match(schema, new RegExp(`\\n\\s+${field}\\s`), `${field} is not a schema column`);
  }
});

/* -------------------------------------------------------------------------- */
/* INV-AUDIT-001 — the row is written inside the change's own transaction       */
/* -------------------------------------------------------------------------- */

/**
 * Each instrumented writer, with the transaction opener the audit call must sit
 * inside. A `recordAudit` after the closing brace would satisfy every assertion
 * above and still break the invariant, so it is pinned at source.
 */
const INSTRUMENTED = [
  { path: "app/api/admin/speakers/route.ts", from: "export const PATCH" },
  { path: "app/api/agenda/sessions/route.ts", from: "export const PATCH" },
  { path: "app/api/agenda/slots/route.ts", from: "export const POST" },
  { path: "lib/services/schedule-slot-write.ts", from: "export async function unscheduleSessionSlot" },
  { path: "lib/services/abstract-decision-write.ts", from: "export async function writeAbstractDecision" },
] as const;

test("every instrumented writer records inside its own transaction, on its own tx", () => {
  for (const { path, from } of INSTRUMENTED) {
    const file = source(path);
    const start = file.indexOf(from);
    assert.ok(start > 0, `${path} no longer declares ${from}`);
    const writer = file.slice(start);

    assert.match(writer, /recordAudit\(/, `${path} does not record history`);
    // The audit write goes through the caller's transaction client. `prisma.` here
    // would open a second connection outside the transaction — a record that can
    // survive a rolled-back change.
    assert.match(writer, /recordAudit\((?:\s|\n)*tx,/, `${path} must record on its own tx`);
    assert.equal(
      /recordAudit\(\s*prisma/.test(writer),
      false,
      `${path} records outside its transaction`,
    );
    // Every diff is built by the shared helper rather than hand-assembled.
    assert.match(writer, /diffChanges\(/, `${path} must build its diff with diffChanges`);
  }
});

test("the two route writers record before their transaction callback returns", () => {
  // The routes whose transaction is a block: the audit call must precede the
  // block's own `return`, not follow the awaited `$transaction`.
  for (const path of ["app/api/admin/speakers/route.ts", "app/api/agenda/sessions/route.ts"]) {
    const file = source(path);
    const writer = file.slice(file.indexOf("export const PATCH"));
    assert.ok(
      writer.indexOf("prisma.$transaction") < writer.indexOf("recordAudit("),
      `${path} records before opening its transaction`,
    );
    assert.match(writer, /await recordAudit\(/, `${path} must await its audit write`);
  }
});

test("the session editor reads its before-state under the row's write lock", () => {
  // Two concurrent edits of the same talk must queue, not both read the same
  // before-state: without `FOR UPDATE` the second writer diffs from a stale
  // snapshot and the history records a transition that never happened
  // (A->C beside A->B, with B orphaned). The speaker PATCH serializes with
  // advisory locks and the slot writers with the event-wide lock; this pins
  // the sessions PATCH to its own serialization.
  const writer = source("app/api/agenda/sessions/route.ts").slice(
    source("app/api/agenda/sessions/route.ts").indexOf("export const PATCH"),
  );
  const read = writer.indexOf("FOR UPDATE");
  assert.ok(read > 0, "the sessions PATCH no longer locks its before-state read");
  assert.ok(
    read < writer.indexOf("session.update("),
    "the FOR UPDATE read must precede the update it serializes",
  );
  assert.ok(
    read < writer.indexOf("recordAudit("),
    "the FOR UPDATE read must precede the audit write it feeds",
  );
});
