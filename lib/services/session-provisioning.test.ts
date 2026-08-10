import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  assignOnboardingTasks,
  DEFAULT_SESSION_MINUTES,
  newSessionData,
  planTaskAssignments,
  resolveSessionDuration,
  TASK_ASSIGNMENT_PAGE_SIZE,
} from "@/lib/services/session-provisioning";

const proposal = {
  id: "abstract-1",
  eventId: "event-1",
  title: "Scaling to 10M requests",
  abstract: "How we grew the platform.",
  format: "Keynote",
  durationMinutes: 45,
  categoryId: "category-devex",
  speakers: [{ userId: "user-1", isPrimary: true }],
  session: null,
};

test("an accepted proposal's topic is carried onto the talk it becomes", () => {
  assert.equal(newSessionData(proposal).categoryId, "category-devex");
});

test("a proposal submitted without a topic creates a talk with none", () => {
  assert.equal(newSessionData({ ...proposal, categoryId: null }).categoryId, null);
});

test("the new talk copies exactly the proposal fields it is meant to", () => {
  assert.deepEqual(newSessionData(proposal, 60), {
    eventId: "event-1",
    sourceAbstractId: "abstract-1",
    title: "Scaling to 10M requests",
    description: "How we grew the platform.",
    format: "Keynote",
    durationMinutes: 60,
    categoryId: "category-devex",
  });
});

test("an explicit duration wins over the proposal", () => {
  assert.equal(resolveSessionDuration(45, 60), 60);
});

test("the proposal's duration is used when the caller does not ask for one", () => {
  assert.equal(resolveSessionDuration(45), 45);
  assert.equal(resolveSessionDuration(45, null), 45);
});

test("accepting never fails because the proposal omitted a duration", () => {
  assert.equal(resolveSessionDuration(null), DEFAULT_SESSION_MINUTES);
  assert.equal(resolveSessionDuration(undefined, null), DEFAULT_SESSION_MINUTES);
});

test("zero is a real requested duration, not a missing one", () => {
  // Guards against a `||` fallback creeping in: the schema floor is 5, so 0
  // should surface as itself and be rejected upstream rather than silently
  // becoming 30.
  assert.equal(resolveSessionDuration(45, 0), 0);
});

test("every speaker gets every task", () => {
  const pairs = planTaskAssignments(["task-1", "task-2"], ["user-a", "user-b"]);
  assert.equal(pairs.length, 4);
  assert.deepEqual(pairs, [
    { taskId: "task-1", userId: "user-a" },
    { taskId: "task-1", userId: "user-b" },
    { taskId: "task-2", userId: "user-a" },
    { taskId: "task-2", userId: "user-b" },
  ]);
});

test("a speaker listed twice is only assigned once", () => {
  const pairs = planTaskAssignments(["task-1"], ["user-a", "user-a"]);
  assert.deepEqual(pairs, [{ taskId: "task-1", userId: "user-a" }]);
});

test("an event with no checklist, or a talk with no speakers, assigns nothing", () => {
  assert.deepEqual(planTaskAssignments([], ["user-a"]), []);
  assert.deepEqual(planTaskAssignments(["task-1"], []), []);
});

test("the plan is stable across retries", () => {
  const once = planTaskAssignments(["t1", "t2"], ["u1", "u2"]);
  const twice = planTaskAssignments(["t1", "t2"], ["u1", "u2"]);
  assert.deepEqual(once, twice);
});

test("task assignment pages through a large checklist without truncating it", async () => {
  const tasks = Array.from({ length: 101 }, (_, index) => ({
    id: `task-${index.toString().padStart(3, "0")}`,
  }));
  const speakers = [{ userId: "speaker-a" }, { userId: "speaker-b" }];
  const inserts: { taskId: string; userId: string }[][] = [];
  const tx = {
    onboardingTask: {
      findMany: async (args: { where: { id?: { gt: string } }; take: number }) => {
        assert.equal(args.take, TASK_ASSIGNMENT_PAGE_SIZE);
        const start = args.where.id
          ? tasks.findIndex((task) => task.id === args.where.id?.gt) + 1
          : 0;
        return tasks.slice(start, start + args.take);
      },
    },
    sessionSpeaker: {
      findMany: async (args: { where: { userId?: { gt: string } }; take: number }) => {
        assert.equal(args.take, TASK_ASSIGNMENT_PAGE_SIZE);
        const start = args.where.userId
          ? speakers.findIndex((speaker) => speaker.userId === args.where.userId?.gt) + 1
          : 0;
        return speakers.slice(start, start + args.take);
      },
    },
    speakerTask: {
      createMany: async ({ data }: { data: { taskId: string; userId: string }[] }) => {
        inserts.push(data);
        return { count: data.length };
      },
    },
  } as unknown as Prisma.TransactionClient;

  assert.equal(await assignOnboardingTasks(tx, "event-1", "session-1"), 202);
  assert.deepEqual(inserts.map((batch) => batch.length), [100, 100, 2]);
  assert.equal(new Set(inserts.flat().map(({ taskId, userId }) => `${taskId}:${userId}`)).size, 202);
});
