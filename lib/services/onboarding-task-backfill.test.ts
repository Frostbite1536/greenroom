import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  backfillConfirmedSpeakerTasks,
  CONFIRMED_SESSION_PAGE_SIZE,
} from "@/lib/services/onboarding-task-backfill";

type SessionRow = { id: string };

function txWithSessions(sessions: SessionRow[], seen: { take: number[] }): Prisma.TransactionClient {
  return {
    session: {
      findMany: async (args: { where: { eventId: string; id?: { gt: string } }; take: number }) => {
        seen.take.push(args.take);
        const start = args.where.id
          ? sessions.findIndex((session) => session.id === args.where.id?.gt) + 1
          : 0;
        return sessions.slice(start, start + args.take);
      },
    },
  } as unknown as Prisma.TransactionClient;
}

test("the backfill reaches every confirmed session, paging past the first page", async () => {
  const sessions = Array.from({ length: 120 }, (_, index) => ({
    id: `session-${index.toString().padStart(3, "0")}`,
  }));
  const seen = { take: [] as number[] };
  const assigned: string[] = [];

  const result = await backfillConfirmedSpeakerTasks(
    txWithSessions(sessions, seen),
    "event-1",
    async (_tx, eventId, sessionId) => {
      assert.equal(eventId, "event-1");
      assigned.push(sessionId);
      return 2;
    },
  );

  assert.equal(result.sessions, 120);
  assert.equal(result.assigned, 240);
  assert.deepEqual(assigned, sessions.map((session) => session.id));
  assert.ok(seen.take.every((take) => take === CONFIRMED_SESSION_PAGE_SIZE));
});

test("an event with no confirmed sessions assigns nothing and does not loop", async () => {
  const seen = { take: [] as number[] };
  let calls = 0;
  const result = await backfillConfirmedSpeakerTasks(txWithSessions([], seen), "event-1", async () => {
    calls++;
    return 1;
  });
  assert.deepEqual(result, { sessions: 0, assigned: 0 });
  assert.equal(calls, 0);
  assert.equal(seen.take.length, 1);
});

test("re-running reports zero newly assigned once the shared fan-out is a no-op", async () => {
  // `assignOnboardingTasks` returns how many rows were actually new, so an
  // idempotent second run must surface 0 rather than re-counting the cohort.
  const seen = { take: [] as number[] };
  const tx = txWithSessions([{ id: "session-a" }, { id: "session-b" }], seen);
  const result = await backfillConfirmedSpeakerTasks(tx, "event-1", async () => 0);
  assert.deepEqual(result, { sessions: 2, assigned: 0 });
});

test("the backfill delegates rather than reimplementing assignment", async () => {
  // Guards the C33 contract: this service must stay a loop over the shared
  // helper. If a future edit inlines its own createMany here, the accept path
  // and the template path can drift and a required task can miss a speaker.
  const seen = { take: [] as number[] };
  const tx = txWithSessions([{ id: "session-a" }], seen);
  let delegated = 0;
  await backfillConfirmedSpeakerTasks(tx, "event-1", async () => {
    delegated++;
    return 3;
  });
  assert.equal(delegated, 1);
});
