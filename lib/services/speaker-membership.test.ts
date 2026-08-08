import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureSpeakerMemberships, type EventMemberUpserter } from "./speaker-membership";

test("public submission provisions missing speakers without downgrading existing roles", async () => {
  const calls: Parameters<EventMemberUpserter["eventMember"]["upsert"]>[0][] = [];
  const memberships = new Map([["event-1:admin-1", "ADMIN"]]);
  const client: EventMemberUpserter = {
    eventMember: {
      upsert: async (input) => {
        calls.push(input);
        const key = `${input.where.eventId_userId.eventId}:${input.where.eventId_userId.userId}`;
        if (!memberships.has(key)) memberships.set(key, input.create.role);
      },
    },
  };

  await ensureSpeakerMemberships(client, "event-1", ["speaker-1", "speaker-1", "admin-1"]);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    where: { eventId_userId: { eventId: "event-1", userId: "speaker-1" } },
    update: {},
    create: { eventId: "event-1", userId: "speaker-1", role: "SPEAKER" },
  });
  assert.deepEqual(calls[1]?.update, {});
  assert.equal(calls[1]?.create.role, "SPEAKER");
  assert.equal(memberships.get("event-1:speaker-1"), "SPEAKER");
  assert.equal(memberships.get("event-1:admin-1"), "ADMIN");
});
