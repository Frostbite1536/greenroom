import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { eventCreateSchema, eventSettingsUpdateSchema } from "../../types/api";
import { classifyEventCreateError, normalizeEventSlug, planEventCreate } from "./event-create";
import { planEventSettingsUpdate } from "./event-settings";

const BASE = { name: "Forward 2027", slug: "forward-2027", timezone: "America/Los_Angeles" };

function created(body: Record<string, unknown>) {
  return eventCreateSchema.safeParse({ ...BASE, ...body });
}

function messages(result: ReturnType<typeof eventCreateSchema.safeParse>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

test("event creation accepts the minimal identity and both event dates together", () => {
  assert.equal(created({}).success, true);
  assert.equal(created({ startsOn: "2027-05-12", endsOn: "2027-05-14" }).success, true);
  assert.equal(created({ startsOn: null, endsOn: null }).success, true);
});

test("event creation refuses a half-supplied or inverted date pair", () => {
  assert.ok(messages(created({ startsOn: "2027-05-12" })).includes("Provide both event dates together."));
  assert.ok(messages(created({ startsOn: "2027-05-12", endsOn: null })).includes("Clear both event dates together."));
  assert.ok(
    messages(created({ startsOn: "2027-05-14", endsOn: "2027-05-12" }))
      .includes("The event must end on or after its start date."),
  );
});

test("the create and update schemas give the same answer on the shared date pair", () => {
  const cases: { startsOn: string | null; endsOn: string | null }[] = [
    { startsOn: "2027-05-12", endsOn: "2027-05-14" },
    { startsOn: "2027-05-14", endsOn: "2027-05-12" },
    { startsOn: "2027-05-12", endsOn: null },
    { startsOn: null, endsOn: null },
  ];
  for (const dates of cases) {
    assert.equal(
      created(dates).success,
      eventSettingsUpdateSchema.safeParse(dates).success,
      `create and update disagreed on ${JSON.stringify(dates)}`,
    );
  }
});

test("the slug is bounded, pattern-checked and normalized to its stored form", () => {
  const upper = created({ slug: "Forward-2027" });
  assert.equal(upper.success && upper.data.slug, "forward-2027");
  const padded = created({ slug: "  forward-2027  " });
  assert.equal(padded.success && padded.data.slug, "forward-2027");

  assert.equal(created({ slug: "" }).success, false);
  assert.equal(created({ slug: "a".repeat(61) }).success, false);
  assert.equal(created({ slug: "forward 2027" }).success, false);
  assert.equal(created({ slug: "forward--2027" }).success, false);
  assert.equal(created({ slug: "-forward" }).success, false);
  assert.equal(created({ slug: "forward/2027" }).success, false);
  assert.equal(normalizeEventSlug("  Forward-2027 "), "forward-2027");
});

test("the name and timezone are bounded and the timezone must be a real IANA zone", () => {
  assert.equal(created({ name: "" }).success, false);
  assert.equal(created({ name: "n".repeat(161) }).success, false);
  assert.equal(created({ timezone: "Mars/Olympus" }).success, false);
  assert.equal(created({ timezone: "UTC" }).success, true);
});

test("unknown keys are refused so creation can never smuggle in another field", () => {
  assert.equal(created({ id: "chosen-id" }).success, false);
  assert.equal(created({ copyFromEventId: "demo-event" }).success, false);
});

test("event-local day boundaries match the settings writer exactly", () => {
  const plan = planEventCreate({ ...BASE, startsOn: "2027-05-12", endsOn: "2027-05-14" });
  const update = planEventSettingsUpdate(
    { id: "e", name: BASE.name, slug: BASE.slug, timezone: BASE.timezone, startsAt: null, endsAt: null },
    { startsOn: "2027-05-12", endsOn: "2027-05-14", timezone: BASE.timezone },
  );
  assert.deepEqual(plan.startsAt, update.startsAt);
  assert.deepEqual(plan.endsAt, update.endsAt);
  // Pinned rather than merely self-consistent: 00:00 PDT is 07:00 UTC.
  assert.equal(plan.startsAt?.toISOString(), "2027-05-12T07:00:00.000Z");
  assert.equal(plan.endsAt?.toISOString(), "2027-05-15T06:59:00.000Z");
});

test("a dateless event is planned with both instants null", () => {
  const plan = planEventCreate(BASE);
  assert.equal(plan.startsAt, null);
  assert.equal(plan.endsAt, null);
  assert.equal(plan.slug, "forward-2027");
});

test("the planner refuses an inverted pair with the same message the settings writer uses", () => {
  assert.throws(
    () => planEventCreate({ ...BASE, startsOn: "2027-05-14", endsOn: "2027-05-12" }),
    (error: unknown) =>
      error instanceof RangeError && error.message === "The event must end on or after its start date.",
  );
});

test("a duplicate slug is classified as the stable conflict, and nothing else is", () => {
  const duplicate = new Prisma.PrismaClientKnownRequestError("duplicate slug", {
    code: "P2002",
    clientVersion: "test",
  });
  assert.equal(classifyEventCreateError(duplicate), "EVENT_SLUG_TAKEN");
  assert.equal(
    classifyEventCreateError(
      new Prisma.PrismaClientKnownRequestError("gone", { code: "P2025", clientVersion: "test" }),
    ),
    null,
  );
  assert.equal(classifyEventCreateError(new Error("database offline")), null);
});
