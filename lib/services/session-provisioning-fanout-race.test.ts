/**
 * C33 invariant race — the two-client proof, against a real Postgres.
 *
 * INV-TASK-001 says every confirmed speaker holds the event's checklist. Two
 * writers maintain that cross-product from opposite ends:
 *
 *  - the **required-task writer** (`POST`/`PATCH /api/admin/tasks`,
 *    `POST /api/admin/tasks/assign`) creates a template and fans it out across
 *    the event's existing confirmed sessions;
 *  - the **session provisioner** — either entry point, `provisionAcceptedAbstract`
 *    (a proposal is accepted) or `provisionGuaranteedSession` (a keynote is
 *    authored directly) — creates a confirmed session and fans the event's
 *    existing templates out across its new speakers.
 *
 * Each reads what the other is about to write. Under READ COMMITTED, two
 * transactions that overlap each read a snapshot in which the other's row does
 * not exist yet, both commit, and the new speaker is left without the new
 * required task — a speaker the portal reports as Ready who has never been shown
 * a task they must complete. `skipDuplicates` cannot help: there is no duplicate,
 * there is an absence.
 *
 * The fix is that both sides take the same per-event advisory lock
 * (`lockEventTaskFanOut`) as the first thing they do, so the two are single-file
 * per event and whichever runs second sees the first one's committed row.
 *
 * This proves that against the real database across the full matrix — BOTH
 * provisioning entry points against BOTH commit orders — with no sleeps. The
 * interleaving is driven by explicit transaction control:
 *
 *  1. the first writer signals a barrier from INSIDE its transaction, once its
 *     locked work is done and before it awaits release, so "the lock is held"
 *     is known from the transaction itself rather than inferred from outside;
 *  2. the second writer is issued, and is observed *queued* on that advisory
 *     lock in `pg_locks` — the server's own account of blocking;
 *  3. the first is released, and both are awaited.
 *
 * Nothing here depends on how fast a machine happens to be.
 *
 * ## Running it
 *
 * Double-gated, like every other prerequisite-dependent suite in this repo, but
 * it fails closed rather than skipping once you have opted in:
 *
 *   RACE_PROOF=1        absent  → every run below SKIPS, so a plain `npm test`
 *                                 stays green and never looks for a database;
 *   RACE_PROOF=1        present → `assertDisposableDatabase()` must pass, which
 *                                 means E2E_EXPECTED_DB must name a distinctive
 *                                 substring of a DISPOSABLE DATABASE_URL. A
 *                                 missing or mismatched assertion FAILS the run.
 *                                 Opting in and being quietly skipped is exactly
 *                                 the outcome a race proof must never have.
 *
 * Every row written lives under one uniquely named scratch event created by the
 * test and deleted in a `finally` whose failure is itself a test failure, so a
 * shared disposable database keeps working for everyone else's smokes.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { assertDisposableDatabase, loadRepoEnv } from "../../e2e/db-guard";
import { lockAbstractForWrite } from "@/lib/services/abstract-lock";
import { backfillConfirmedSpeakerTasks } from "@/lib/services/onboarding-task-backfill";
import { lockEventTaskFanOut, taskFanOutLockKey } from "@/lib/services/onboarding-task-lock";
import {
  provisionAcceptedAbstract,
  provisionGuaranteedSession,
} from "@/lib/services/session-provisioning";

// ---- Gate -----------------------------------------------------------------

const skip =
  process.env.RACE_PROOF === "1"
    ? false
    : "set RACE_PROOF=1 (with E2E_EXPECTED_DB naming a disposable DATABASE_URL) to run the C33 race proof";

/**
 * The database assertion, run before a single client is constructed or a single
 * row is written. `assertDisposableDatabase` is the same helper the Playwright
 * config and the e2e harness take, and it throws — never skips — on a missing
 * or mismatched `E2E_EXPECTED_DB`.
 */
function requireDisposableDatabase(): void {
  loadRepoEnv();
  assertDisposableDatabase();
}

// ---- Observing the block, without sleeping --------------------------------

/**
 * A bound on the observation loop. Each iteration is a real round trip to the
 * database, not a timer, so this is a safety net against an unexpected hang
 * rather than a timing assumption: the loop also exits the moment the waiter
 * appears or the second writer settles, and the waiter is guaranteed to appear
 * and to stay until this test releases the first transaction.
 */
const MAX_POLLS = 200;

/** Prisma's interactive-transaction budget. Generous: a blocked writer waits. */
const TX = { timeout: 60_000, maxWait: 20_000 } as const;

/**
 * Where a transaction-scoped advisory lock on this event's fan-out key shows up
 * in `pg_locks`.
 *
 * `pg_advisory_xact_lock(bigint)` splits its 64-bit key across two `oid`
 * columns: `classid` is the high half, `objid` the low half. Both the hash and
 * the split are computed by the server — the hash by `hashtextextended` over
 * `taskFanOutLockKey`, exactly as the production helper computes it, so this
 * cannot drift from the real key — and returned as text, because `oid` is
 * unsigned and a negative 64-bit hash has no bigint-safe reassembly.
 */
async function lockCoordinates(observer: PrismaClient, eventId: string) {
  const key = taskFanOutLockKey(eventId);
  const rows = await observer.$queryRaw<{ classid: string; objid: string }[]>`
    SELECT ((hashtextextended(${key}, 0) >> 32) & 4294967295)::text AS classid,
           (hashtextextended(${key}, 0) & 4294967295)::text AS objid
  `;
  return rows[0];
}

type LockCoordinates = Awaited<ReturnType<typeof lockCoordinates>>;

/**
 * Poll until a backend is *queued* on this event's fan-out lock, or until the
 * second writer settles without ever queueing (which is the pre-fix behaviour,
 * and is what this observation exists to rule out).
 *
 * Only the ungranted side is observed. Who *holds* the lock is already known
 * from the barrier the holder signals inside its own transaction, and reading
 * the granted holder out of `pg_locks` is not portable across the pooled and
 * self-hosted servers this proof has to run on.
 */
async function observeBlocked(
  observer: PrismaClient,
  coordinates: LockCoordinates,
  done: () => boolean,
): Promise<{ seen: boolean; polls: number }> {
  for (let polls = 1; polls <= MAX_POLLS; polls++) {
    const rows = await observer.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory'
        AND NOT granted
        AND classid::text = ${coordinates.classid}
        AND objid::text = ${coordinates.objid}
    `;
    if (rows[0].n > 0) return { seen: true, polls };
    if (done()) return { seen: false, polls };
  }
  return { seen: false, polls: MAX_POLLS };
}

/**
 * The handshake a racing transaction is driven by: it signals `reached` from
 * inside itself once its locked work is done, then waits on `held` until the
 * test releases it.
 */
type Barrier = { signal: () => void; held: Promise<void> };

function barrier() {
  let signal!: () => void;
  const reached = new Promise<void>((resolve) => { signal = resolve; });
  let open!: () => void;
  const held = new Promise<void>((resolve) => { open = resolve; });
  return { signal, reached, open, held };
}

/** Never rejects, so a failing racer cannot surface as an unhandled rejection. */
function settled<T>(promise: Promise<T>) {
  const state = { done: false };
  const result = promise.then(
    (value) => { state.done = true; return { ok: true, value } as const; },
    (error: unknown) => { state.done = true; return { ok: false, error } as const; },
  );
  return { result, isDone: () => state.done };
}

function unwrap<T>(outcome: { ok: true; value: T } | { ok: false; error: unknown }, label: string): T {
  if (!outcome.ok) {
    throw new Error(`${label} failed: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`);
  }
  return outcome.value;
}

// ---- Fixture --------------------------------------------------------------

const TASK_TITLE = "Upload your slides";

/**
 * A scratch event of its own, per run.
 *
 * Deliberately NOT `demo-event`, `scratch-backend` or `scratch-frontend`: the
 * disposable database is shared with the smoke harnesses, and this suite writes
 * and deletes whole events.
 */
type Fixture = {
  eventId: string;
  userId: string;
  formConfigId: string;
  /** Only the accepted path has a proposal to convert. */
  abstractId: string;
};

/** Ids first, rows second, so cleanup can target a half-built fixture. */
function planFixture(label: string): Fixture {
  const suffix = `${label}-${randomUUID().slice(0, 8)}`;
  return {
    eventId: `c33-race-${suffix}`,
    userId: `c33-race-user-${suffix}`,
    formConfigId: `c33-race-form-${suffix}`,
    abstractId: `c33-race-abstract-${suffix}`,
  };
}

async function createFixture(client: PrismaClient, fixture: Fixture, mode: Mode): Promise<void> {
  await client.event.create({
    data: { id: fixture.eventId, name: `C33 race proof ${fixture.eventId}`, slug: fixture.eventId, timezone: "UTC" },
  });
  await client.user.create({
    data: { id: fixture.userId, email: `${fixture.userId}@c33-race.test`, name: "Race Proof Speaker" },
  });
  if (mode !== "accepted") return;

  // An accepted proposal, with its speaker, ready for the decision writer to
  // convert. `Abstract.formConfigId` is required, so the form comes with it.
  await client.formConfig.create({
    data: { id: fixture.formConfigId, eventId: fixture.eventId, name: "Race proof CFP", slug: "race-proof-cfp" },
  });
  await client.abstract.create({
    data: {
      id: fixture.abstractId,
      eventId: fixture.eventId,
      formConfigId: fixture.formConfigId,
      submitterId: fixture.userId,
      title: "An accepted proposal",
      abstract: "What the speaker proposed.",
      durationMinutes: 30,
      status: "ACCEPTED",
      speakers: { create: [{ userId: fixture.userId, isPrimary: true }] },
    },
  });
}

/**
 * Explicit, dependency-ordered deletes rather than one cascading `Event` delete:
 * `Abstract.formConfigId` is `onDelete: Restrict`, so a cascade that reached the
 * form before the proposal would be refused.
 */
async function destroyFixture(client: PrismaClient, fixture: Fixture): Promise<void> {
  await client.abstract.deleteMany({ where: { eventId: fixture.eventId } });
  await client.session.deleteMany({ where: { eventId: fixture.eventId } });
  await client.onboardingTask.deleteMany({ where: { eventId: fixture.eventId } });
  await client.formConfig.deleteMany({ where: { eventId: fixture.eventId } });
  await client.event.deleteMany({ where: { id: fixture.eventId } });
  await client.user.deleteMany({ where: { id: fixture.userId } });
}

/** Cleanup that reported success but left rows behind is a failure. */
async function assertFixtureGone(client: PrismaClient, fixture: Fixture): Promise<void> {
  assert.equal(
    await client.event.count({ where: { id: fixture.eventId } }),
    0,
    `scratch event ${fixture.eventId} survived cleanup`,
  );
  assert.equal(
    await client.user.count({ where: { id: fixture.userId } }),
    0,
    `scratch user ${fixture.userId} survived cleanup`,
  );
}

// ---- The two racers -------------------------------------------------------

type Mode = "guaranteed" | "accepted";
type Order = "task-writer-first" | "provisioning-first";

/** What either provisioning entry point reports back to this test. */
type Provisioned = { sessionId: string; tasksAssigned: number };

/** What the required-task writer reports back. */
type TaskWritten = { taskId: string; assigned: number };

/**
 * Which racer produced an outcome is decided by the order under test, so it is
 * checked rather than asserted by cast: a mix-up would otherwise read the wrong
 * counts out of the right run.
 */
function asTaskWritten(value: TaskWritten | Provisioned): TaskWritten {
  assert.ok("taskId" in value, "expected the required-task writer's result");
  return value;
}

function asProvisioned(value: TaskWritten | Provisioned): Provisioned {
  assert.ok("sessionId" in value, "expected the session provisioner's result");
  return value;
}

/** The required template a `POST /api/admin/tasks` would create, plus its fan-out. */
async function requiredTaskWriter(
  client: PrismaClient,
  fixture: Fixture,
  hold?: Barrier,
): Promise<TaskWritten> {
  return client.$transaction(async (tx) => {
    // The route's own first statement, imported rather than re-implemented so
    // this side of the race cannot drift from `app/api/admin/tasks/route.ts`.
    await lockEventTaskFanOut(tx, fixture.eventId);
    const task = await tx.onboardingTask.create({
      data: { eventId: fixture.eventId, title: TASK_TITLE, required: true, sortOrder: 0 },
      select: { id: true },
    });
    const fanOut = await backfillConfirmedSpeakerTasks(tx, fixture.eventId);
    hold?.signal();
    if (hold) await hold.held;
    return { taskId: task.id, assigned: fanOut.assigned };
  }, TX);
}

/** The talk `POST /api/agenda/sessions` would author. */
async function guaranteedProvisioner(
  client: PrismaClient,
  fixture: Fixture,
  hold?: Barrier,
): Promise<Provisioned> {
  return client.$transaction(async (tx) => {
    const result = await provisionGuaranteedSession(tx, fixture.eventId, {
      title: "Opening keynote",
      durationMinutes: 45,
      speakers: [{ userId: fixture.userId, isPrimary: true }],
    });
    hold?.signal();
    if (hold) await hold.held;
    return { sessionId: result.sessionId, tasksAssigned: result.tasksAssigned };
  }, TX);
}

/**
 * The talk `POST /api/evaluations/decisions` would confirm — in that route's own
 * lock order: the per-abstract advisory lock first, then the read, then
 * provisioning (which takes the fan-out lock itself). Taking the abstract lock
 * here is what makes this run exercise the real `abstract -> fan-out` edge
 * rather than a simplified one.
 */
async function acceptedProvisioner(
  client: PrismaClient,
  fixture: Fixture,
  hold?: Barrier,
): Promise<Provisioned> {
  return client.$transaction(async (tx) => {
    await lockAbstractForWrite(tx, fixture.abstractId);
    const abstract = await tx.abstract.findUniqueOrThrow({
      where: { id: fixture.abstractId },
      include: {
        speakers: { select: { userId: true, isPrimary: true } },
        session: { select: { id: true, categoryId: true, description: true } },
      },
    });
    const result = await provisionAcceptedAbstract(tx, abstract);
    hold?.signal();
    if (hold) await hold.held;
    return { sessionId: result.sessionId, tasksAssigned: result.tasksAssigned };
  }, TX);
}

function provisionerFor(mode: Mode) {
  return mode === "guaranteed" ? guaranteedProvisioner : acceptedProvisioner;
}

/**
 * What the database is left holding: the checklist assignments for this event,
 * named rather than keyed so a failure prints the story instead of two cuids.
 */
async function assignments(observer: PrismaClient, fixture: Fixture, taskId: string) {
  const rows = await observer.speakerTask.findMany({
    where: { task: { eventId: fixture.eventId } },
    select: { taskId: true, userId: true },
    orderBy: [{ taskId: "asc" }, { userId: "asc" }],
  });
  return rows.map(
    (row) =>
      `${row.taskId === taskId ? "required-task" : row.taskId}:${row.userId === fixture.userId ? "new-speaker" : row.userId}`,
  );
}

// ---- The matrix: both entry points, both orders ---------------------------

const RUNS: { mode: Mode; order: Order }[] = [
  { mode: "guaranteed", order: "task-writer-first" },
  { mode: "guaranteed", order: "provisioning-first" },
  { mode: "accepted", order: "task-writer-first" },
  { mode: "accepted", order: "provisioning-first" },
];

for (const { mode, order } of RUNS) {
  test(
    `C33 (${mode}, ${order}): the new confirmed speaker holds the new required task exactly once`,
    { skip, timeout: 300_000 },
    async (t) => {
      // Before any client, any connection, any row.
      requireDisposableDatabase();

      const writerClient = new PrismaClient();
      const provisionerClient = new PrismaClient();
      const observer = new PrismaClient();
      const fixture = planFixture(`${mode}-${order}`);
      const provision = provisionerFor(mode);

      try {
        await createFixture(observer, fixture, mode);
        const coordinates = await lockCoordinates(observer, fixture.eventId);

        const hold = barrier();

        // The first writer runs its whole locked body, then signals from inside
        // its own still-open transaction. No polling, no timer: when `reached`
        // resolves, the lock is held and the work under it is done.
        const firstRun = settled<TaskWritten | Provisioned>(
          order === "task-writer-first"
            ? requiredTaskWriter(writerClient, fixture, hold)
            : provision(provisionerClient, fixture, hold),
        );
        // Raced against the run itself, so a first writer that throws before
        // signalling fails the test rather than hanging it.
        await Promise.race([hold.reached, firstRun.result]);

        // Only now is the second writer issued. It must queue on the fan-out
        // lock rather than read a snapshot taken before the first one commits.
        const secondRun = settled<TaskWritten | Provisioned>(
          order === "task-writer-first"
            ? provision(provisionerClient, fixture)
            : requiredTaskWriter(writerClient, fixture),
        );
        const blocked = await observeBlocked(observer, coordinates, secondRun.isDone);

        // Released before any assertion, so a failing run still lets both
        // transactions finish and the fixture still cleans up.
        hold.open();
        const firstOutcome = await firstRun.result;
        const secondOutcome = await secondRun.result;

        const taskOutcome = order === "task-writer-first" ? firstOutcome : secondOutcome;
        const sessionOutcome = order === "task-writer-first" ? secondOutcome : firstOutcome;
        const taskResult = asTaskWritten(unwrap(taskOutcome, "required-task writer"));
        const sessionResult = asProvisioned(unwrap(sessionOutcome, "session provisioner"));

        const observed = {
          secondWriterBlocked: blocked.seen,
          assignments: await assignments(observer, fixture, taskResult.taskId),
          reportedAssignments: taskResult.assigned + sessionResult.tasksAssigned,
          speakersOnSession: await observer.sessionSpeaker.count({
            where: { sessionId: sessionResult.sessionId },
          }),
        };
        t.diagnostic(`${mode}/${order}: ${JSON.stringify(observed)} (blocked after ${blocked.polls} polls)`);

        assert.deepEqual(observed, {
          // The second writer queued on the fan-out lock instead of racing past
          // it — the server's own account of the serialization.
          secondWriterBlocked: true,
          // Exactly the cross-product, exactly once: this is the invariant.
          assignments: ["required-task:new-speaker"],
          // And exactly one writer reports having made it — no double count.
          reportedAssignments: 1,
          speakersOnSession: 1,
        });
      } finally {
        try {
          // Not swallowed: a scratch event left behind on a shared disposable
          // database is this suite's own failure to report.
          await destroyFixture(observer, fixture);
          await assertFixtureGone(observer, fixture);
        } finally {
          await Promise.all([
            writerClient.$disconnect(),
            provisionerClient.$disconnect(),
            observer.$disconnect(),
          ]);
        }
      }
    },
  );
}
