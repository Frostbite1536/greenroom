import assert from "node:assert/strict";
import test from "node:test";
import { eventSettingsUpdateSchema, roomCreateSchema, roomUpdateSchema } from "@/types/api";
import { planEventSettingsUpdate, serializeSettingsEvent, type SettingsEvent } from "@/lib/services/event-settings";
import { decideRoomDeletion } from "@/lib/services/room-deletion";

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
