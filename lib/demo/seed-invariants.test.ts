import assert from "node:assert/strict";
import { test } from "node:test";
import { unknownTemplateVariables } from "@/lib/comms/template-edit";
import { CFP_SUBMITTED_TEMPLATE_KEY } from "@/lib/comms/notifications";
import {
  DEMO_EMAIL_TEMPLATES,
  DEMO_EVENT,
  DEMO_EVENT_DATES,
  DEMO_TASK_SCHEDULE,
} from "./seed";
import { zonedParts, zonedToUtcIso } from "@/lib/tz";

test("the seeded task schedule is ordered and completes before the May 12–14 event", () => {
  assert.deepEqual(DEMO_EVENT_DATES, { startsOn: "2026-05-12", endsOn: "2026-05-14" });
  assert.equal(DEMO_TASK_SCHEDULE.length, 6);
  assert.deepEqual(
    DEMO_TASK_SCHEDULE.map((task) => task.dueDate),
    ["2026-04-17", "2026-04-24", "2026-05-01", "2026-05-04", "2026-05-06", "2026-05-11"],
  );
  assert.ok(DEMO_TASK_SCHEDULE.every((task) => task.dueDate < DEMO_EVENT_DATES.startsOn));

  const eventStart = zonedParts(zonedToUtcIso(DEMO_EVENT_DATES.startsOn, "00:00", DEMO_EVENT.timezone), DEMO_EVENT.timezone);
  const eventEnd = zonedParts(zonedToUtcIso(DEMO_EVENT_DATES.endsOn, "23:59", DEMO_EVENT.timezone), DEMO_EVENT.timezone);
  assert.deepEqual(eventStart, { dateKey: DEMO_EVENT_DATES.startsOn, hour: 0, minute: 0, minutesOfDay: 0 });
  assert.deepEqual(eventEnd, { dateKey: DEMO_EVENT_DATES.endsOn, hour: 23, minute: 59, minutesOfDay: 23 * 60 + 59 });

  for (const task of DEMO_TASK_SCHEDULE) {
    const local = zonedParts(zonedToUtcIso(task.dueDate, "23:59", DEMO_EVENT.timezone), DEMO_EVENT.timezone);
    assert.equal(local.dateKey, task.dueDate);
    assert.equal(local.minutesOfDay, 23 * 60 + 59);
  }
});

test("the seeded communications include a dedicated submission record and no false global task deadline", () => {
  assert.deepEqual(
    DEMO_EMAIL_TEMPLATES.map((template) => template.key),
    [CFP_SUBMITTED_TEMPLATE_KEY, "cfp-accepted", "cfp-rejected", "task-reminder", "session-scheduled"],
  );
  assert.equal(new Set(DEMO_EMAIL_TEMPLATES.map((template) => template.key)).size, DEMO_EMAIL_TEMPLATES.length);

  for (const template of DEMO_EMAIL_TEMPLATES) {
    assert.deepEqual(unknownTemplateVariables(template.subject, template.htmlBody), [], template.key);
  }
  const reminder = DEMO_EMAIL_TEMPLATES.find((template) => template.key === "task-reminder");
  assert.ok(reminder);
  assert.doesNotMatch(reminder.htmlBody, /{{\s*dueDate\s*}}/);
  assert.match(reminder.htmlBody, /individual deadline/i);
});
