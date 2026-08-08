import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSpeakerStatusRows,
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
  });
});

test("an unknown filter value falls back to the full list", () => {
  assert.equal(parseSpeakerStatusFilter("incomplete-profile"), "incomplete-profile");
  assert.equal(parseSpeakerStatusFilter("drop-table"), "all");
  assert.equal(parseSpeakerStatusFilter(undefined), "all");
});
