import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  assignOnboardingTasks,
  DEFAULT_SESSION_MINUTES,
  newSessionData,
  planTaskAssignments,
  provisionSessionForAbstract,
  reconciledSessionFields,
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

/** An existing Session already carrying everything this proposal would push. */
const alignedSession = {
  id: "session-1",
  categoryId: "category-devex",
  description: "How we grew the platform.",
};

test("a topic that moved on the proposal is reconciled onto the talk", () => {
  const summary = { abstract: "How we grew the platform.", description: "How we grew the platform." };
  assert.deepEqual(
    reconciledSessionFields(
      { categoryId: "category-devex", abstract: summary.abstract },
      { categoryId: "category-ai", description: summary.description },
    ),
    { categoryId: "category-devex" },
  );
  // Clearing the proposal's topic really does clear the talk's.
  assert.deepEqual(
    reconciledSessionFields(
      { categoryId: null, abstract: summary.abstract },
      { categoryId: "category-ai", description: summary.description },
    ),
    { categoryId: null },
  );
  // ...and a talk that never had one picks the proposal's up.
  assert.deepEqual(
    reconciledSessionFields(
      { categoryId: "category-ai", abstract: summary.abstract },
      { categoryId: null, description: summary.description },
    ),
    { categoryId: "category-ai" },
  );
});

test("the proposal's attendee-facing summary is reconciled onto the talk", () => {
  // The §5-4 defect: a Session created before `description` was on the copy
  // list carries no public prose, so the programme page had nothing honest to
  // print. An organizer's re-run is the repair.
  assert.deepEqual(
    reconciledSessionFields(
      { categoryId: "category-devex", abstract: "A rewritten, attendee-facing summary." },
      { categoryId: "category-devex", description: null },
    ),
    { description: "A rewritten, attendee-facing summary." },
  );
  // A summary that moved on the proposal replaces the stale one.
  assert.deepEqual(
    reconciledSessionFields(
      { categoryId: null, abstract: "Version two." },
      { categoryId: null, description: "Version one." },
    ),
    { description: "Version two." },
  );
});

test("a blank proposal summary never blanks an admin-authored description", () => {
  // One-way on purpose. A keynote has no source abstract at all, and the public
  // description is the field an organizer plausibly hand-writes on the Session;
  // a re-run must not wipe it because the proposal's field is empty.
  for (const empty of [null, "", "   \n "]) {
    assert.equal(
      reconciledSessionFields(
        { categoryId: "category-devex", abstract: empty },
        { categoryId: "category-devex", description: "Hand-written programme copy." },
      ),
      null,
      JSON.stringify(empty),
    );
  }
});

test("an unchanged talk produces no write at all", () => {
  // Not an optimization: a re-run that writes nothing leaves `updatedAt` alone,
  // so "reconvened this talk" and "changed this talk" stay distinguishable.
  assert.equal(
    reconciledSessionFields(
      { categoryId: "category-ai", abstract: "Same words." },
      { categoryId: "category-ai", description: "Same words." },
    ),
    null,
  );
  assert.equal(
    reconciledSessionFields({ categoryId: null, abstract: null }, { categoryId: null, description: null }),
    null,
  );
  // Whitespace-only drift is not a change either.
  assert.equal(
    reconciledSessionFields(
      { categoryId: null, abstract: "  Same words.  " },
      { categoryId: null, description: "Same words." },
    ),
    null,
  );
});

test("re-running provisioning reconciles topic and summary, and touches nothing else", async () => {
  const updates: { where: { id: string }; data: Record<string, unknown> }[] = [];
  const tx = {
    session: {
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(args);
        return { id: args.where.id };
      },
      create: async () => { throw new Error("must not create a second session"); },
    },
  } as unknown as Prisma.TransactionClient;
  const result = await provisionSessionForAbstract(
    tx,
    {
      ...proposal,
      categoryId: "category-devex",
      session: { id: "session-1", categoryId: "category-ai", description: null },
    },
  );
  assert.deepEqual(result, {
    sessionId: "session-1",
    created: false,
    topicReconciled: true,
    summaryReconciled: true,
  });
  assert.deepEqual(updates, [{
    where: { id: "session-1" },
    data: { categoryId: "category-devex", description: "How we grew the platform." },
  }]);
  // Title, format and duration remain the convert route's documented
  // non-mutations; a reconciliation that quietly widened would break them.
  for (const field of ["title", "format", "durationMinutes", "eventId", "contentStatus"]) {
    assert.ok(!(field in updates[0].data), `reconciliation must not write ${field}`);
  }
});

test("a moved topic alone is reported as a topic reconciliation only", async () => {
  const tx = {
    session: {
      update: async (args: { where: { id: string } }) => ({ id: args.where.id }),
      create: async () => { throw new Error("must not create a second session"); },
    },
  } as unknown as Prisma.TransactionClient;
  assert.deepEqual(
    await provisionSessionForAbstract(tx, {
      ...proposal,
      categoryId: "category-devex",
      session: { ...alignedSession, categoryId: "category-ai" },
    }),
    { sessionId: "session-1", created: false, topicReconciled: true, summaryReconciled: false },
  );
});

test("re-running an already-aligned talk issues no session write", async () => {
  const tx = {
    session: {
      update: async () => { throw new Error("must not write an unchanged session"); },
      create: async () => { throw new Error("must not create a second session"); },
    },
  } as unknown as Prisma.TransactionClient;
  assert.deepEqual(
    await provisionSessionForAbstract(tx, { ...proposal, session: alignedSession }),
    { sessionId: "session-1", created: false, topicReconciled: false, summaryReconciled: false },
  );
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

/**
 * Source-level contract for the reconciliation boundary (INV-EDIT-001).
 *
 * Which authority may move the public programme is not observable from a pure
 * function: it is a property of *which routes call what*. A well-meaning
 * refactor that "fixes the stale topic properly" by propagating from the
 * speaker's edit would look like an improvement and would quietly let a speaker
 * rewrite the published agenda.
 */
const routeSource = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("only ADMIN-authorized routes reconcile a Session's topic and summary", () => {
  for (const path of ["app/api/evaluations/decisions/route.ts", "app/api/evaluations/convert/route.ts"]) {
    const route = routeSource(path);
    assert.match(route, /requireContext\(\["ADMIN"\]\)/, `${path} is ADMIN-only`);
    // Both reach reconciliation through the shared provisioning helper rather
    // than writing Session.categoryId or Session.description themselves. Either
    // may appear in a `select` — that read is what makes reconciliation
    // possible — but never inside a `data:` payload.
    assert.match(route, /provisionAcceptedAbstract\(tx, /, `${path} goes through provisioning`);
    for (const payload of route.match(/data: \{[^}]*\}/g) ?? []) {
      assert.doesNotMatch(payload, /categoryId/, `${path} writes no category directly`);
      assert.doesNotMatch(payload, /description/, `${path} writes no description directly`);
    }
  }
});

test("the decisions route reads the session fields reconciliation needs", () => {
  // The reconcile compares against the stored Session; a select that omits
  // `description` would make every re-accept look like a summary change and
  // rewrite the row on every run.
  assert.match(
    routeSource("app/api/evaluations/decisions/route.ts"),
    /session: \{ select: \{ id: true, categoryId: true, description: true \} \}/,
  );
});

test("INV-EDIT-001: the speaker's edit never mutates its linked Session", () => {
  const speakerEdit = routeSource("app/api/cfp/submissions/[abstractId]/route.ts");
  // It is authorized as a speaker, not an organizer...
  assert.match(speakerEdit, /isAbstractSpeaker\(/);
  assert.doesNotMatch(speakerEdit, /requireContext\(\["ADMIN"\]\)/);
  // ...so it may write the Abstract and must never write a Session.
  assert.match(speakerEdit, /\.\.\.\(patch\.categoryId !== undefined \? \{ categoryId: patch\.categoryId \} : \{\}\)/);
  assert.doesNotMatch(speakerEdit, /tx\.session\.(update|create|delete)/);
  // Asserted on the imports rather than the whole file: the invariant comment
  // below names `provisionSessionForAbstract` on purpose, so a bare text search
  // would match the very documentation that explains the rule.
  const imports = speakerEdit.slice(0, speakerEdit.indexOf("export const"));
  assert.doesNotMatch(imports, /session-provisioning/);
  // And the invariant is stated where the next reader will be tempted.
  assert.match(speakerEdit, /INV-EDIT-001/);
});

test("the anonymous and import writers can never face a Session to reconcile", () => {
  // A Session exists only after acceptance. Both of these refuse to touch an
  // abstract that has got that far, which is why neither needs a handoff.
  assert.match(routeSource("app/api/cfp/submissions/route.ts"), /status !== "DRAFT"/);
  assert.match(
    routeSource("app/api/integrations/import/route.ts"),
    /\["DRAFT", "SUBMITTED"\]\.includes\(current\.status\)/,
  );
});
