import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSpeakerStatusRows,
  completeUserBoundary,
  filterSpeakerStatusRows,
  parseSpeakerStatusFilter,
  profileCompletion,
  summarizeSpeakerStatus,
  type SpeakerAssignment,
  type SpeakerTaskAssignment,
} from "./status";

const fullProfile = { bio: "Builds things", company: "Acme", jobTitle: "Staff Engineer", headshotUrl: "https://x.test/a.png" };

function assignment(overrides: Partial<SpeakerAssignment> = {}): SpeakerAssignment {
  return {
    userId: "user-1",
    name: "Ada Lovelace",
    email: "ada@example.test",
    profile: fullProfile,
    sessionId: "session-1",
    sessionTitle: "Analytical Engines",
    scheduled: true,
    ...overrides,
  };
}

function task(overrides: Partial<SpeakerTaskAssignment> = {}): SpeakerTaskAssignment {
  return { userId: "user-1", taskId: "task-1", taskTitle: "Complete your speaker profile", status: "COMPLETED", required: true, ...overrides };
}

test("profile completeness counts only the fields the public program renders", () => {
  assert.deepEqual(profileCompletion(fullProfile), { percent: 100, missing: [] });
  assert.deepEqual(profileCompletion({ ...fullProfile, headshotUrl: "   ", bio: null }), { percent: 50, missing: ["Bio", "Headshot"] });
  assert.deepEqual(profileCompletion(null), { percent: 0, missing: ["Bio", "Company", "Job title", "Headshot"] });
  // A slide deck is optional, so it never moves the percentage.
  assert.equal(profileCompletion({ ...fullProfile }).percent, 100);
});

test("one row per speaker aggregates every session they are on", () => {
  const rows = buildSpeakerStatusRows(
    [
      assignment(),
      assignment({ sessionId: "session-2", sessionTitle: "Punch Cards", scheduled: false }),
    ],
    [task()],
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { sessions: rows[0].sessionCount, scheduled: rows[0].scheduledCount, titles: rows[0].sessionTitles },
    { sessions: 2, scheduled: 1, titles: ["Analytical Engines", "Punch Cards"] },
  );
  // An unscheduled session is an admin action item even with onboarding done.
  assert.equal(rows[0].onboardingComplete, true);
  assert.equal(rows[0].needsAttention, true);
});

test("waived tasks count as settled and only required tasks block a speaker", () => {
  const rows = buildSpeakerStatusRows(
    [assignment()],
    [
      task({ taskId: "t1", status: "WAIVED" }),
      task({ taskId: "t2", taskTitle: "Upload slides", status: "TODO", required: false }),
      task({ taskId: "t3", taskTitle: "Sign the speaker agreement", status: "IN_PROGRESS", required: true }),
    ],
  );
  assert.deepEqual(
    { done: rows[0].tasksDone, total: rows[0].tasksTotal, outstanding: rows[0].requiredOutstanding, complete: rows[0].onboardingComplete },
    { done: 1, total: 3, outstanding: ["Sign the speaker agreement"], complete: false },
  );
});

test("the list is ordered so the operator works it top-down", () => {
  const behind = assignment({ userId: "u-behind", name: "Behind", email: "b@example.test", sessionId: "s-b" });
  const done = assignment({ userId: "u-done", name: "Done", email: "d@example.test", sessionId: "s-d" });
  const partial = assignment({ userId: "u-partial", name: "Partial", email: "p@example.test", sessionId: "s-p" });

  const rows = buildSpeakerStatusRows([done, partial, behind], [
    task({ userId: "u-done", taskId: "t1" }),
    task({ userId: "u-partial", taskId: "t1" }),
    task({ userId: "u-partial", taskId: "t2", taskTitle: "Slides", status: "TODO" }),
    task({ userId: "u-behind", taskId: "t1", taskTitle: "Profile", status: "TODO" }),
    task({ userId: "u-behind", taskId: "t2", taskTitle: "Slides", status: "TODO" }),
  ]);
  assert.deepEqual(rows.map((row) => row.name), ["Behind", "Partial", "Done"]);
  assert.equal(rows[2].needsAttention, false);
});

test("filters isolate each chase list and the summary stays exact", () => {
  const rows = buildSpeakerStatusRows(
    [
      assignment(),
      assignment({ userId: "u-2", name: "Grace Hopper", email: "grace@example.test", profile: { company: "Navy" }, sessionId: "s-2", scheduled: false }),
    ],
    [task({ status: "TODO", taskTitle: "Profile" }), task({ userId: "u-2", taskId: "t2", taskTitle: "Slides", status: "COMPLETED" })],
  );

  assert.deepEqual(filterSpeakerStatusRows(rows, "incomplete-onboarding").map((row) => row.name), ["Ada Lovelace"]);
  assert.deepEqual(filterSpeakerStatusRows(rows, "incomplete-profile").map((row) => row.name), ["Grace Hopper"]);
  assert.deepEqual(filterSpeakerStatusRows(rows, "unscheduled").map((row) => row.name), ["Grace Hopper"]);
  assert.equal(filterSpeakerStatusRows(rows, "all").length, 2);
  assert.deepEqual(summarizeSpeakerStatus(rows), {
    speakers: 2,
    onboardingComplete: 0,
    requiredOutstanding: 1,
    unscheduledSessions: 1,
    // No task in this fixture carries a deadline, so nothing can be overdue.
    speakersOverdue: 0,
  });
});

const NOW = new Date("2026-05-10T12:00:00.000Z");

test("the next deadline is the earliest one still owed, not the earliest assigned", () => {
  const rows = buildSpeakerStatusRows(
    [assignment()],
    [
      // Already done: its deadline must not be what the operator chases.
      task({ taskId: "t-done", taskTitle: "Headshot", status: "COMPLETED", dueAt: "2026-05-01T06:59:00.000Z" }),
      task({ taskId: "t-late", taskTitle: "Hotel", status: "TODO", dueAt: "2026-05-20T06:59:00.000Z" }),
      task({ taskId: "t-soon", taskTitle: "Slides", status: "IN_PROGRESS", dueAt: "2026-05-14T06:59:00.000Z" }),
    ],
    NOW,
  );
  assert.equal(rows[0].nextRequiredDueAt, "2026-05-14T06:59:00.000Z");
  assert.equal(rows[0].overdueRequired, 0);
});

test("an organizer-waived task stops counting as a deadline to chase", () => {
  const rows = buildSpeakerStatusRows(
    [assignment()],
    [task({ taskId: "t-waived", status: "WAIVED", dueAt: "2026-05-01T06:59:00.000Z" })],
    NOW,
  );
  assert.equal(rows[0].nextRequiredDueAt, null);
  assert.equal(rows[0].overdueRequired, 0);
});

test("only past deadlines on open required tasks count as overdue", () => {
  const rows = buildSpeakerStatusRows(
    [assignment()],
    [
      task({ taskId: "t-1", status: "TODO", dueAt: "2026-05-01T06:59:00.000Z" }),
      task({ taskId: "t-2", status: "TODO", dueAt: "2026-05-05T06:59:00.000Z" }),
      task({ taskId: "t-3", status: "TODO", dueAt: "2026-05-30T06:59:00.000Z" }),
      // Optional tasks never block a speaker, so they never read as overdue.
      task({ taskId: "t-4", status: "TODO", required: false, dueAt: "2026-01-01T06:59:00.000Z" }),
    ],
    NOW,
  );
  assert.equal(rows[0].overdueRequired, 2);
  assert.equal(rows[0].nextRequiredDueAt, "2026-05-01T06:59:00.000Z");
  assert.equal(summarizeSpeakerStatus(rows).speakersOverdue, 1);
});

test("a task with no deadline is never reported as overdue", () => {
  const rows = buildSpeakerStatusRows(
    [assignment()],
    [
      task({ taskId: "t-none", status: "TODO" }),
      task({ taskId: "t-null", status: "TODO", dueAt: null }),
      // A malformed stored value must be ignored, not silently become epoch 0
      // and mark a speaker fifty-six years late.
      task({ taskId: "t-bad", status: "TODO", dueAt: "not-a-date" }),
    ],
    NOW,
  );
  assert.equal(rows[0].nextRequiredDueAt, null);
  assert.equal(rows[0].overdueRequired, 0);
  assert.equal(rows[0].requiredOutstanding.length, 3);
});

test("the overdue summary counts speakers to chase, not late tasks", () => {
  const rows = buildSpeakerStatusRows(
    [
      assignment(),
      assignment({ userId: "u-2", name: "Grace Hopper", email: "grace@example.test", sessionId: "s-2" }),
    ],
    [
      task({ taskId: "t-1", status: "TODO", dueAt: "2026-05-01T06:59:00.000Z" }),
      task({ taskId: "t-2", status: "TODO", dueAt: "2026-05-02T06:59:00.000Z" }),
      task({ userId: "u-2", taskId: "t-3", status: "TODO", dueAt: "2026-05-30T06:59:00.000Z" }),
    ],
    NOW,
  );
  assert.equal(summarizeSpeakerStatus(rows).speakersOverdue, 1);
});

test("an unknown filter value falls back to the full list", () => {
  assert.equal(parseSpeakerStatusFilter("incomplete-profile"), "incomplete-profile");
  assert.equal(parseSpeakerStatusFilter("drop-table"), "all");
  assert.equal(parseSpeakerStatusFilter(undefined), "all");
});

test("completeUserBoundary is null when nothing truncated", () => {
  assert.equal(
    completeUserBoundary([
      { truncated: false, lastUserId: "user-z" },
      { truncated: false, lastUserId: null },
    ]),
    null,
  );
});

test("completeUserBoundary takes the smallest truncated boundary", () => {
  assert.equal(
    completeUserBoundary([
      { truncated: true, lastUserId: "user-m" },
      { truncated: true, lastUserId: "user-c" },
      { truncated: false, lastUserId: "user-a" },
    ]),
    "user-c",
  );
});
