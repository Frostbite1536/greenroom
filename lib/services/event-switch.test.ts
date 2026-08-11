import assert from "node:assert/strict";
import test from "node:test";
import {
  EVENT_ID_MAX_LENGTH,
  normalizeSwitchEventId,
  resolveEventSwitch,
  type SwitchMembership,
} from "@/lib/services/event-switch";

/**
 * D-C5-16 item 1, S1 event-scoping. The property under test throughout is that
 * an `EventMember` row for the CALLER'S OWN user id is the only thing that can
 * move a session, and that every way of not having one produces the identical
 * refusal.
 */

const user = { id: "user-1", name: "Maya Chen", email: "maya@greenroom-hq.com" };

/** A membership table keyed exactly as the real composite primary key is. */
function membershipStore(rows: { userId: string; membership: SwitchMembership }[]) {
  const calls: { userId: string; eventId: string }[] = [];
  return {
    calls,
    findMembership: async (query: { userId: string; eventId: string }) => {
      calls.push(query);
      const hit = rows.find(
        (row) => row.userId === query.userId && row.membership.event.id === query.eventId,
      );
      return hit ? hit.membership : null;
    },
  };
}

const homeEvent: SwitchMembership = {
  role: "ADMIN",
  event: { id: "demo-event", name: "Forward 2026", slug: "forward-2026" },
};
const otherEvent: SwitchMembership = {
  role: "SPEAKER",
  event: { id: "other-event", name: "Sidetrack 2027", slug: "sidetrack-2027" },
};

test("a membership on the target event switches the session to that event", async () => {
  const store = membershipStore([
    { userId: user.id, membership: homeEvent },
    { userId: user.id, membership: otherEvent },
  ]);
  const next = await resolveEventSwitch({
    user,
    eventId: "other-event",
    findMembership: store.findMembership,
  });
  assert.deepEqual(next, {
    user,
    event: { id: "other-event", name: "Sidetrack 2027", slug: "sidetrack-2027" },
    role: "SPEAKER",
  });
});

test("the role comes from the target membership, not from the session being replaced", async () => {
  // The same identity is ADMIN on one event and SPEAKER on the other. Switching
  // must carry the role held THERE — this is what makes the cookie's event the
  // thing that decides authority.
  const store = membershipStore([
    { userId: user.id, membership: homeEvent },
    { userId: user.id, membership: otherEvent },
  ]);
  const toOther = await resolveEventSwitch({ user, eventId: "other-event", findMembership: store.findMembership });
  const backHome = await resolveEventSwitch({ user, eventId: "demo-event", findMembership: store.findMembership });
  assert.equal(toOther?.role, "SPEAKER");
  assert.equal(backHome?.role, "ADMIN");
});

test("an event the caller is not a member of is refused exactly as a nonexistent one is", async () => {
  // `foreign-event` is a REAL event in this fixture — someone else's. It must be
  // indistinguishable from `no-such-event`, which is nobody's.
  const store = membershipStore([
    { userId: user.id, membership: homeEvent },
    {
      userId: "someone-else",
      membership: { role: "ADMIN", event: { id: "foreign-event", name: "Not Yours", slug: "not-yours" } },
    },
  ]);
  const foreign = await resolveEventSwitch({ user, eventId: "foreign-event", findMembership: store.findMembership });
  const unknown = await resolveEventSwitch({ user, eventId: "no-such-event", findMembership: store.findMembership });
  assert.equal(foreign, null);
  assert.equal(unknown, null);
  // Both took the same single (userId, eventId) probe. There is no second query
  // asking whether the event exists, so there is nothing to time or compare.
  assert.deepEqual(store.calls, [
    { userId: user.id, eventId: "foreign-event" },
    { userId: user.id, eventId: "no-such-event" },
  ]);
});

test("the probe is always keyed on the caller's own user id", async () => {
  const store = membershipStore([{ userId: "someone-else", membership: otherEvent }]);
  const next = await resolveEventSwitch({ user, eventId: "other-event", findMembership: store.findMembership });
  assert.equal(next, null);
  assert.deepEqual(store.calls, [{ userId: user.id, eventId: "other-event" }]);
});

test("an unusable event id is refused without a query at all", async () => {
  const store = membershipStore([{ userId: user.id, membership: homeEvent }]);
  for (const value of ["", "   ", null, undefined, 7, {}, ["demo-event"], "x".repeat(EVENT_ID_MAX_LENGTH + 1)]) {
    assert.equal(
      await resolveEventSwitch({ user, eventId: value, findMembership: store.findMembership }),
      null,
      `${JSON.stringify(value)} must be refused`,
    );
  }
  assert.deepEqual(store.calls, [], "no unusable id may reach the database");
});

test("normalizeSwitchEventId trims but never truncates", () => {
  assert.equal(normalizeSwitchEventId("  demo-event  "), "demo-event");
  assert.equal(normalizeSwitchEventId("demo-event"), "demo-event");
  // At the bound it survives; one past it becomes "" rather than a prefix that
  // could match a different row.
  assert.equal(normalizeSwitchEventId("y".repeat(EVENT_ID_MAX_LENGTH)).length, EVENT_ID_MAX_LENGTH);
  assert.equal(normalizeSwitchEventId("y".repeat(EVENT_ID_MAX_LENGTH + 1)), "");
});

test("switching never widens or rewrites who the session is for", async () => {
  const store = membershipStore([{ userId: user.id, membership: otherEvent }]);
  const next = await resolveEventSwitch({ user, eventId: "other-event", findMembership: store.findMembership });
  assert.deepEqual(next?.user, user);
});
