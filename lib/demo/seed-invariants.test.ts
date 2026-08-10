import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { unknownTemplateVariables } from "@/lib/comms/template-edit";
import { CFP_SUBMITTED_TEMPLATE_KEY } from "@/lib/comms/notifications";
import {
  DEMO_EMAIL_TEMPLATES,
  DEMO_EVENT,
  DEMO_EVENT_DATES,
  DEMO_SEED_PERSONAS,
  DEMO_TASK_SCHEDULE,
} from "./seed";
import { DEMO_PERSONAS } from "@/lib/auth";
import { zonedParts, zonedToUtcIso } from "@/lib/tz";

const seedSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "seed.ts"),
  "utf8",
);

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

test("the seeded persona identities are exactly the auth personas, on the deliverable domain", () => {
  // A signed session resolves to a `User` by email (lib/auth.ts
  // getResolvedSession), so the seed and the cookie must agree byte for byte or
  // every one-click button bounces back to /login with no visible error. Asserted
  // in BOTH directions: an address added on either side alone fails here.
  const seeded = Object.entries(DEMO_SEED_PERSONAS)
    .map(([key, persona]) => [key, persona.email, persona.name] as const)
    .sort();
  const signedIn = Object.entries(DEMO_PERSONAS)
    .map(([key, persona]) => [key, persona.user.email, persona.user.name] as const)
    .sort();
  assert.deepEqual(seeded, signedIn);

  for (const [key, email] of seeded) {
    assert.equal(email, email.toLowerCase(), `${key} must already be normalized`);
    // C5: personas moved off the non-routable `@greenroom.demo` so a live send
    // reaches a real inbox. Every other seeded address stays undeliverable.
    assert.ok(email.endsWith("@greenroom-hq.com"), `${key} must use the deliverable demo domain`);
  }
});

test("the persona address migration renames the pre-C5 rows rather than orphaning them", () => {
  // `User.email` is unique, so changing the constant without this rename would
  // create a second row and strand the original with the persona's
  // SpeakerProfile. The rename must therefore stay wired to the live constants.
  assert.match(seedSource, /const PERSONA_EMAIL_MIGRATIONS = \[/);
  for (const [key, email] of Object.entries(DEMO_SEED_PERSONAS).map(([k, p]) => [k, p.email] as const)) {
    const local = email.split("@")[0];
    assert.match(
      seedSource,
      new RegExp(`from: "${local}@greenroom\\.demo", to: PERSONAS\\.\\w+\\.email`),
      `${key} needs a migration off its pre-C5 address`,
    );
  }
  // It runs before the upserts, or the upsert would already have created the
  // duplicate the rename exists to prevent.
  assert.ok(
    seedSource.indexOf("for (const { from, to } of PERSONA_EMAIL_MIGRATIONS)") <
      seedSource.indexOf("const adminId = await upsertUser("),
    "the migration must run before the persona upserts",
  );
  // And it never deletes an identity to resolve a collision.
  assert.doesNotMatch(seedSource, /db\.user\.delete/);
});
