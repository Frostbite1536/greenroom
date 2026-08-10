import assert from "node:assert/strict";
import test from "node:test";
import { bulkAssignNotice, taskFanOutNotice } from "@/lib/speakers/task-notices";

test("an optional task never claims speakers already have it", () => {
  // The regression this function exists for: the route deliberately skips the
  // fan-out for an optional template and reports `assigned: 0`, which read
  // identically to "everyone already had it" and told an organizer their
  // speakers could see a task that had been assigned to nobody.
  const notice = taskFanOutNotice({ verb: "Added", title: "Send your slides", required: false, assigned: 0 });
  assert.doesNotMatch(notice, /already ha[sd]/i);
  assert.match(notice, /not assigned automatically/i);
  assert.match(notice, /Added “Send your slides”/);
});

test("an optional task names both ways it can still reach speakers", () => {
  const notice = taskFanOutNotice({ verb: "Saved", title: "Hotel form", required: false, assigned: 0 });
  assert.match(notice, /required/i);
  assert.match(notice, /Assign checklist to all confirmed speakers/);
});

test("a required task reporting nothing new means everyone already has it", () => {
  const notice = taskFanOutNotice({ verb: "Saved", title: "Hotel form", required: true, assigned: 0 });
  assert.equal(notice, "Saved “Hotel form”. Every confirmed speaker already has it.");
});

test("a real fan-out is reported as checklist-wide, not as this task's share", () => {
  // `assigned` is the whole reconciliation: the backfill fixes every template,
  // so a create can return rows belonging to other tasks that were missing.
  // "assigned it to 7" would attribute those to the task just written.
  const notice = taskFanOutNotice({ verb: "Added", title: "Send your slides", required: true, assigned: 7 });
  assert.match(notice, /7 missing tasks across the checklist/);
  assert.doesNotMatch(notice, /assigned it to/i);
});

test("the single-assignment case reads as one task, not one tasks", () => {
  const notice = taskFanOutNotice({ verb: "Added", title: "Bio", required: true, assigned: 1 });
  assert.match(notice, /1 missing task across the checklist/);
  assert.doesNotMatch(notice, /1 missing tasks/);
});

test("the verb and title come through for every branch", () => {
  for (const required of [true, false]) {
    for (const assigned of [0, 3]) {
      const notice = taskFanOutNotice({ verb: "Added", title: "A/V check", required, assigned });
      assert.match(notice, /^Added “A\/V check”/, `required=${required} assigned=${assigned}`);
    }
  }
});

test("an event with no confirmed sessions is not told everyone is covered", () => {
  const notice = bulkAssignNotice(0, 0);
  assert.doesNotMatch(notice, /already has/i);
  assert.match(notice, /nobody to assign/i);
});

test("the bulk action reports a genuine no-op and a genuine reconciliation apart", () => {
  assert.equal(bulkAssignNotice(0, 3), "Every speaker across 3 confirmed sessions already has the full checklist.");
  assert.equal(bulkAssignNotice(5, 3), "Assigned 5 missing tasks across 3 confirmed sessions.");
});

test("the bulk action reads correctly for a single session and a single task", () => {
  assert.match(bulkAssignNotice(0, 1), /1 confirmed session already/);
  assert.doesNotMatch(bulkAssignNotice(0, 1), /sessions/);
  assert.match(bulkAssignNotice(1, 1), /1 missing task across 1 confirmed session\./);
});

test("an optional task says the same thing whether or not the checklist moved", () => {
  // An optional write runs no fan-out, so a non-zero count here would mean the
  // route changed behavior. The sentence must not start claiming this task was
  // assigned if that ever happens.
  const quiet = taskFanOutNotice({ verb: "Added", title: "Bio", required: false, assigned: 0 });
  const noisy = taskFanOutNotice({ verb: "Added", title: "Bio", required: false, assigned: 4 });
  assert.equal(quiet, noisy);
});
