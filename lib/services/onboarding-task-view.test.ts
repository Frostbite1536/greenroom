import assert from "node:assert/strict";
import test from "node:test";
import {
  compareOnboardingTasks,
  serializeOnboardingTask,
  TASK_DUE_TIME,
  taskDueAtFromDateKey,
  taskDueOnFromInstant,
  type OnboardingTaskView,
} from "@/lib/services/onboarding-task-view";

const LA = "America/Los_Angeles";

test("a deadline means the end of that day where the event is", () => {
  const due = taskDueAtFromDateKey("2026-05-12", LA);
  assert.ok(due);
  // 23:59 PDT on 12 May is 06:59 UTC on 13 May. The stored instant is later
  // than the calendar day it belongs to, which is exactly why the round trip
  // below has to go back through the event zone rather than through UTC.
  assert.equal(due.toISOString(), "2026-05-13T06:59:00.000Z");
  assert.equal(TASK_DUE_TIME, "23:59");
});

test("the day an organizer picks is the day they get back", () => {
  for (const dateKey of ["2026-01-15", "2026-03-08", "2026-05-12", "2026-11-01", "2026-12-31"]) {
    const stored = taskDueAtFromDateKey(dateKey, LA);
    assert.equal(taskDueOnFromInstant(stored, LA), dateKey, dateKey);
  }
});

test("the round trip survives the daylight-saving boundaries in both directions", () => {
  // 8 Mar 2026 is spring-forward and 1 Nov 2026 is fall-back in Los Angeles.
  // A naive UTC conversion drifts a day on one side of each.
  for (const dateKey of ["2026-03-07", "2026-03-08", "2026-10-31", "2026-11-01"]) {
    assert.equal(taskDueOnFromInstant(taskDueAtFromDateKey(dateKey, LA), LA), dateKey, dateKey);
  }
});

test("a task with no deadline stays without one", () => {
  assert.equal(taskDueAtFromDateKey(null, LA), null);
  assert.equal(taskDueAtFromDateKey(undefined, LA), null);
  assert.equal(taskDueOnFromInstant(null, LA), null);
  assert.equal(taskDueOnFromInstant(undefined, LA), null);
});

test("the same instant is a different calendar day in a different event zone", () => {
  // Guards against anyone replacing the event zone with the server's: the
  // deadline an organizer typed is only reproducible through the event's own.
  const stored = taskDueAtFromDateKey("2026-05-12", LA);
  assert.equal(taskDueOnFromInstant(stored, LA), "2026-05-12");
  assert.equal(taskDueOnFromInstant(stored, "UTC"), "2026-05-13");
});

test("serialization carries both the instant and the authored day", () => {
  const view = serializeOnboardingTask(
    {
      id: "task-1",
      title: "Send your headshot",
      description: null,
      dueAt: new Date("2026-05-13T06:59:00.000Z"),
      required: true,
      formConfigId: null,
      sortOrder: 2,
    },
    LA,
    { assigned: 7, settled: 3 },
  );
  assert.equal(view.dueAt, "2026-05-13T06:59:00.000Z");
  assert.equal(view.dueOn, "2026-05-12");
  assert.equal(view.assignedCount, 7);
  assert.equal(view.settledCount, 3);
  assert.equal(view.required, true);
});

test("counts default to zero rather than undefined for an unassigned template", () => {
  const view = serializeOnboardingTask(
    { id: "t", title: "New task", description: null, dueAt: null, required: false, formConfigId: null, sortOrder: 0 },
    LA,
  );
  assert.equal(view.assignedCount, 0);
  assert.equal(view.settledCount, 0);
  assert.equal(view.dueAt, null);
  assert.equal(view.dueOn, null);
});

test("templates order by the organizer's own order, then title, then id", () => {
  const make = (id: string, title: string, sortOrder: number): OnboardingTaskView => ({
    id, title, description: null, dueAt: null, dueOn: null, required: true,
    formConfigId: null, sortOrder, assignedCount: 0, settledCount: 0,
  });
  const sorted = [
    make("c", "Beta", 1),
    make("a", "Alpha", 1),
    make("b", "Alpha", 0),
  ].sort(compareOnboardingTasks);
  assert.deepEqual(sorted.map((task) => task.id), ["b", "a", "c"]);
});
