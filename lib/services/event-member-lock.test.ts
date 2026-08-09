import assert from "node:assert/strict";
import test from "node:test";
import { eventMemberAuthorityLockKeys, sortEventMemberUserIds } from "./event-member-lock";

test("event-member authority advisory keys are bytewise tuple-sorted and de-duplicated", () => {
  assert.deepEqual(
    eventMemberAuthorityLockKeys([
      { eventId: "event-b", userId: "user-a" },
      { eventId: "event-a", userId: "user-z" },
      { eventId: "event-a", userId: "user-a" },
      { eventId: "event-a", userId: "user-a" },
    ]),
    [
      "event-member-authority:event-a:user-a",
      "event-member-authority:event-a:user-z",
      "event-member-authority:event-b:user-a",
    ],
  );
  assert.deepEqual(sortEventMemberUserIds(["user-z", "user-a", "user-z"]), ["user-a", "user-z"]);
});
