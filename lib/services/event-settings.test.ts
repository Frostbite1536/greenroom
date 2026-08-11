import assert from "node:assert/strict";
import test from "node:test";
import {
  categoryUpdateSchema,
  eventSettingsUpdateSchema,
  roomCreateSchema,
  roomUpdateSchema,
  trackCreateSchema,
  trackUpdateSchema,
} from "@/types/api";
import { planEventSettingsUpdate, serializeSettingsEvent, type SettingsEvent } from "@/lib/services/event-settings";
import { decideRoomDeletion } from "@/lib/services/room-deletion";
import { classifyRoomMutationError } from "@/lib/services/room-mutation-errors";
import { decideTrackDeletion } from "@/lib/services/track-deletion";
import { classifyTrackMutationError } from "@/lib/services/track-mutation-errors";
import { decideCategoryDeletion } from "@/lib/services/category-deletion";
import { normalizeHex } from "@/lib/color-contrast";
import { isIanaTimeZone } from "@/lib/tz";
import { Prisma } from "@prisma/client";

const event: SettingsEvent = {
  id: "event-1",
  name: "Forward",
  slug: "forward",
  timezone: "America/Los_Angeles",
  startsAt: new Date("2026-05-12T07:00:00.000Z"),
  endsAt: new Date("2026-05-15T06:59:00.000Z"),
};

test("settings serialize event boundaries as event-local calendar dates", () => {
  assert.deepEqual(serializeSettingsEvent(event), {
    id: "event-1",
    name: "Forward",
    slug: "forward",
    timezone: "America/Los_Angeles",
    startsOn: "2026-05-12",
    endsOn: "2026-05-14",
  });
});

test("timezone-only updates preserve local event dates and rederive UTC boundaries", () => {
  const update = planEventSettingsUpdate(event, { timezone: "America/New_York" });
  assert.equal(update.timezone, "America/New_York");
  assert.ok(update.startsAt && update.endsAt);
  assert.equal(update.startsAt.toISOString(), "2026-05-12T04:00:00.000Z");
  assert.equal(update.endsAt.toISOString(), "2026-05-15T03:59:00.000Z");
});

test("partial settings plans only update supplied fields from the locked current snapshot", () => {
  const currentAtLock: SettingsEvent = {
    ...event,
    name: "Name changed by another request",
    startsAt: new Date("2026-06-10T07:00:00.000Z"),
    endsAt: new Date("2026-06-13T06:59:00.000Z"),
  };
  const update = planEventSettingsUpdate(currentAtLock, { timezone: "America/New_York" });

  assert.equal("name" in update, false);
  assert.equal(update.timezone, "America/New_York");
  assert.equal(update.startsAt?.toISOString(), "2026-06-10T04:00:00.000Z");
  assert.equal(update.endsAt?.toISOString(), "2026-06-13T03:59:00.000Z");
  assert.deepEqual(planEventSettingsUpdate(currentAtLock, { name: "Rename only" }), { name: "Rename only" });
});

test("explicit date updates use the submitted timezone and include the complete final local day", () => {
  const update = planEventSettingsUpdate(event, {
    timezone: "UTC",
    startsOn: "2026-02-28",
    endsOn: "2026-03-01",
  });
  assert.ok(update.startsAt && update.endsAt);
  assert.equal(update.startsAt.toISOString(), "2026-02-28T00:00:00.000Z");
  assert.equal(update.endsAt.toISOString(), "2026-03-01T23:59:00.000Z");
});

test("event settings require real ordered date pairs and a valid IANA timezone", () => {
  for (const body of [
    { startsOn: "2026-02-29", endsOn: "2026-03-01" },
    { startsOn: "2026-05-14", endsOn: "2026-05-12" },
    { startsOn: "2026-05-12" },
    { startsOn: null, endsOn: "2026-05-12" },
    { timezone: "Mars/Olympus_Mons" },
    {},
  ]) {
    assert.equal(eventSettingsUpdateSchema.safeParse(body).success, false, JSON.stringify(body));
  }
  assert.equal(eventSettingsUpdateSchema.safeParse({ eventId: "another-event", name: "No cross-event body" }).success, false);
  assert.equal(eventSettingsUpdateSchema.safeParse({ startsOn: null, endsOn: null }).success, true);
  assert.equal(eventSettingsUpdateSchema.safeParse({ timezone: "America/Chicago" }).success, true);
});

test("IANA validation treats only RangeError as invalid input", () => {
  assert.equal(isIanaTimeZone("America/Chicago"), true);
  assert.equal(isIanaTimeZone("Mars/Olympus_Mons"), false);
  assert.equal(isIanaTimeZone("UTC", () => { throw new RangeError("invalid zone"); }), false);
  assert.throws(() => isIanaTimeZone("UTC", () => { throw new Error("formatter unavailable"); }), /formatter unavailable/);
});

test("room contracts reject blank names, invalid capacity, and empty updates", () => {
  assert.equal(roomCreateSchema.safeParse({ name: "Main Hall", capacity: 300, sortOrder: 2 }).success, true);
  assert.equal(roomCreateSchema.safeParse({ name: "", capacity: 300 }).success, false);
  assert.equal(roomCreateSchema.safeParse({ name: "Main Hall", capacity: 0 }).success, false);
  assert.equal(roomCreateSchema.safeParse({ eventId: "another-event", name: "Main Hall" }).success, false);
  assert.equal(roomUpdateSchema.safeParse({ id: "room-1" }).success, false);
  assert.equal(roomUpdateSchema.safeParse({ id: "room-1", capacity: null }).success, true);
});

test("room deletion policy permits unused rooms and refuses scheduled rooms before cascade", () => {
  assert.deepEqual(decideRoomDeletion(false), { allowed: true });
  assert.deepEqual(decideRoomDeletion(true), {
    allowed: false,
    code: "ROOM_IN_USE",
    message: "This room is scheduled. Move or unschedule its sessions before removing it.",
  });
});

test("room update/delete races classify Prisma P2025 as the scoped not-found response", () => {
  const missing = new Prisma.PrismaClientKnownRequestError("record vanished", {
    code: "P2025",
    clientVersion: "test",
  });
  const duplicate = new Prisma.PrismaClientKnownRequestError("duplicate room", {
    code: "P2002",
    clientVersion: "test",
  });
  assert.equal(classifyRoomMutationError(missing), "ROOM_NOT_FOUND");
  assert.equal(classifyRoomMutationError(duplicate), "ROOM_NAME_TAKEN");
  assert.equal(classifyRoomMutationError(new Error("database offline")), null);
});

test("track contracts require a readable colour and reject blank names and empty updates", () => {
  assert.equal(trackCreateSchema.safeParse({ name: "Mainstage", color: "#6366f1", sortOrder: 2 }).success, true);
  // Every form `parseHex` reads is accepted, because those are the forms the
  // schedule chip can actually render.
  assert.equal(trackCreateSchema.safeParse({ name: "Mainstage", color: "abc" }).success, true);
  assert.equal(trackCreateSchema.safeParse({ name: "", color: "#6366f1" }).success, false);
  assert.equal(trackCreateSchema.safeParse({ name: "Mainstage" }).success, false);
  assert.equal(trackCreateSchema.safeParse({ name: "Mainstage", color: "rebeccapurple" }).success, false);
  assert.equal(trackCreateSchema.safeParse({ name: "Mainstage", color: "#12345" }).success, false);
  // Event scope is the session's, never the body's.
  assert.equal(trackCreateSchema.safeParse({ eventId: "another-event", name: "Mainstage", color: "#6366f1" }).success, false);
  assert.equal(trackUpdateSchema.safeParse({ id: "track-1" }).success, false);
  assert.equal(trackUpdateSchema.safeParse({ id: "track-1", name: "Deep Dives" }).success, true);
  assert.equal(trackUpdateSchema.safeParse({ id: "track-1", color: "#0ea5e9" }).success, true);
  assert.equal(trackUpdateSchema.safeParse({ id: "track-1", eventId: "another-event", name: "Deep Dives" }).success, false);
});

test("track deletion policy permits unused tracks and refuses scheduled ones by name", () => {
  assert.deepEqual(decideTrackDeletion(false), { allowed: true });
  assert.deepEqual(decideTrackDeletion(true), {
    allowed: false,
    code: "TRACK_IN_USE",
    message: "This track is on the schedule. Move its sessions to another track before removing it.",
  });
});

test("track update/delete races classify Prisma P2025 as the scoped not-found response", () => {
  const missing = new Prisma.PrismaClientKnownRequestError("record vanished", {
    code: "P2025",
    clientVersion: "test",
  });
  const duplicate = new Prisma.PrismaClientKnownRequestError("duplicate track", {
    code: "P2002",
    clientVersion: "test",
  });
  assert.equal(classifyTrackMutationError(missing), "TRACK_NOT_FOUND");
  assert.equal(classifyTrackMutationError(duplicate), "TRACK_NAME_TAKEN");
  assert.equal(classifyTrackMutationError(new Error("database offline")), null);
});

test("a category edit names the row and only the fields it actually changes", () => {
  assert.equal(categoryUpdateSchema.safeParse({ id: "category-1" }).success, false);
  assert.equal(categoryUpdateSchema.safeParse({ id: "category-1", name: "Platform" }).success, true);
  // Clearing is explicit; omitting leaves the stored value alone. This is the
  // whole reason a rename cannot silently drop review routing.
  assert.equal(categoryUpdateSchema.safeParse({ id: "category-1", defaultTeamKey: null }).success, true);
  assert.equal(categoryUpdateSchema.safeParse({ id: "category-1", description: null }).success, true);
  assert.equal(categoryUpdateSchema.safeParse({ id: "category-1", name: "" }).success, false);
  assert.equal(categoryUpdateSchema.safeParse({ id: "category-1", eventId: "another-event", name: "Platform" }).success, false);
  const renameOnly = categoryUpdateSchema.safeParse({ id: "category-1", name: "Platform" });
  assert.equal(renameOnly.success && "defaultTeamKey" in renameOnly.data, false);
  assert.equal(renameOnly.success && "description" in renameOnly.data, false);
});

test("category deletion refuses each reference on its own and names what is in the way", () => {
  assert.deepEqual(decideCategoryDeletion({ hasAbstract: false, hasSession: false }), { allowed: true });

  const withAbstract = decideCategoryDeletion({ hasAbstract: true, hasSession: false });
  assert.equal(withAbstract.allowed, false);
  assert.equal(withAbstract.allowed === false && withAbstract.code, "CATEGORY_IN_USE");
  assert.match(withAbstract.allowed === false ? withAbstract.message : "", /Proposals still use this category/);
  assert.match(withAbstract.allowed === false ? withAbstract.message : "", /review routing/);

  // A Session may carry a category with no Abstract behind it (an invited
  // keynote), so the session reference has to refuse on its own or a live
  // programme loses its topics with nothing said.
  const withSession = decideCategoryDeletion({ hasAbstract: false, hasSession: true });
  assert.equal(withSession.allowed, false);
  assert.match(withSession.allowed === false ? withSession.message : "", /Sessions on the program still use this category/);

  const withBoth = decideCategoryDeletion({ hasAbstract: true, hasSession: true });
  assert.equal(withBoth.allowed, false);
  assert.match(withBoth.allowed === false ? withBoth.message : "", /Proposals and scheduled sessions/);

  // Every refusal says what to do instead; renaming is always safe.
  for (const usage of [
    { hasAbstract: true, hasSession: false },
    { hasAbstract: false, hasSession: true },
    { hasAbstract: true, hasSession: true },
  ]) {
    const decision = decideCategoryDeletion(usage);
    assert.match(decision.allowed === false ? decision.message : "", /rename this one instead of removing it/);
  }
});

test("a stored track colour reaches the settings colour input in the form it can display", () => {
  assert.equal(normalizeHex("#6366f1", "#000000"), "#6366f1");
  assert.equal(normalizeHex("abc", "#000000"), "#aabbcc");
  assert.equal(normalizeHex("#ABC", "#000000"), "#aabbcc");
  // Without the fallback an unreadable stored value would show as black and a
  // save would then write black over a colour the operator never touched.
  assert.equal(normalizeHex("rebeccapurple", "#6366f1"), "#6366f1");
  assert.equal(normalizeHex(null, "#6366f1"), "#6366f1");
});
