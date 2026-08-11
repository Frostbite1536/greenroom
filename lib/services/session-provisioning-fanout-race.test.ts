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
 *  1. each transaction publishes its own backend pid from inside itself, before
 *     it invokes any lock helper;
 *  2. the first writer signals a barrier from INSIDE its transaction, once its
 *     locked work is done and before it awaits release, so "the lock is held" is
 *     known from the transaction itself rather than inferred from outside;
 *  3. the second writer is issued, and the server is asked directly whether it
 *     is blocked *by the first* — `pg_blocking_pids(second)` must contain the
 *     first pid;
 *  4. the first is released, and both are awaited.
 *
 * Nothing here depends on how fast a machine happens to be.
 *
 * ## Why `pg_blocking_pids` and not `pg_locks`
 *
 * An earlier revision reconstructed the advisory lock's `classid`/`objid` from
 * the hashed key and looked for an ungranted row in `pg_locks`. That worked on
 * one server and reported nothing on another: the reconstruction depends on how
 * a given version represents an advisory waiter, and getting it wrong fails
 * *open* — a silent "not blocked" that looks like the bug this file exists to
 * catch. `pg_blocking_pids` has existed since 9.6, understands every waiter
 * representation itself, and answers the question actually being asked ("is B
 * held up by A?") rather than a proxy for it.
 *
 * It does not say *which* lock, so: the required-task writer takes exactly one
 * lock, the per-event fan-out lock, and takes it before it touches a row. The
 * only lock the two racers can possibly contend on is therefore that one — the
 * abstract lock is taken by the provisioner alone. `pg_stat_activity`'s wait
 * state is captured alongside as corroboration and asserted when the server
 * populates it.
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
import { lockEventTaskFanOut } from "@/lib/services/onboarding-task-lock";
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
 * rather than a timing assumption: the loop also exits the moment the block is
 * seen or the second writer settles, and the block is guaranteed to appear and
 * to stay until this test releases the first transaction.
 */
const MAX_POLLS = 200;

/** Prisma's interactive-transaction budget. Generous: a blocked writer waits. */
const TX = { timeout: 60_000, maxWait: 20_000 } as const;

/** The backend serving this transaction, asked from inside it. */
async function backendPid(tx: { $queryRaw: PrismaClient["$queryRaw"] }): Promise<number> {
  const rows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
  return rows[0].pid;
}

type Blocked = { seen: boolean; polls: number; wait: string | null };

/**
 * Ask the server whether the second writer is held up by the first, and by what
 * kind of wait. Both pids are published from inside their own transactions, so
 * they name the backends actually running the racers even through a pooler.
 */
async function observeBlocked(
  observer: PrismaClient,
  pids: { first: () => number; second: () => number },
  done: () => boolean,
): Promise<Blocked> {
  for (let polls = 1; polls <= MAX_POLLS; polls++) {
    const first = pids.first();
    const second = pids.second();
    if (first > 0 && second > 0) {
      const rows = await observer.$queryRaw<{ blocked: boolean; wait: string | null }[]>`
        SELECT (${first}::int = ANY(pg_blocking_pids(${second}::int))) AS blocked,
               (SELECT wait_event_type || ':' || wait_event
                  FROM pg_stat_activity WHERE pid = ${second}::int) AS wait
      `;
      if (rows[0].blocked) return { seen: true, polls, wait: rows[0].wait };
    } else {
      // A pid is not published yet. Burn a round trip rather than spin the loop.
      await observer.$queryRaw`SELECT 1`;
    }
    if (done()) return { seen: false, polls, wait: null };
  }
  return { seen: false, polls: MAX_POLLS, wait: null };
}

/**
 * The handshake a racing transaction is driven by: it signals `reached` from
 * inside itself once its locked work is done, then waits on `held` until the
 * test releases it. `open` is idempotent, which is what lets the outer `finally`
 * release unconditionally.
 */
type Barrier = { signal: () => void; held: Promise<void> };

function barrier() {
  let signal!: () => void;
  const reached = new Promise<void>((resolve) => { signal = resolve; });
  let open!: () => void;
  const held = new Promise<void>((resolve) => { open = resolve; });
  return { signal, reached, open, held };
}

/** How a racer reports itself while it is still inside its transaction. */
type Probe = { onPid: (pid: number) => void; hold?: Barrier };

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
  probe: Probe,
): Promise<TaskWritten> {
  return client.$transaction(async (tx) => {
    // Published before any lock helper runs, so the pid is known even when the
    // very next statement is the one that blocks.
    probe.onPid(await backendPid(tx));
    // The route's own first statement, imported rather than re-implemented so
    // this side of the race cannot drift from `app/api/admin/tasks/route.ts`.
    await lockEventTaskFanOut(tx, fixture.eventId);
    const task = await tx.onboardingTask.create({
      data: { eventId: fixture.eventId, title: TASK_TITLE, required: true, sortOrder: 0 },
      select: { id: true },
    });
    const fanOut = await backfillConfirmedSpeakerTasks(tx, fixture.eventId);
    probe.hold?.signal();
    if (probe.hold) await probe.hold.held;
    return { taskId: task.id, assigned: fanOut.assigned };
  }, TX);
}

/** The talk `POST /api/agenda/sessions` would author. */
async function guaranteedProvisioner(
  client: PrismaClient,
  fixture: Fixture,
  probe: Probe,
): Promise<Provisioned> {
  return client.$transaction(async (tx) => {
    probe.onPid(await backendPid(tx));
    const result = await provisionGuaranteedSession(tx, fixture.eventId, {
      title: "Opening keynote",
      durationMinutes: 45,
      speakers: [{ userId: fixture.userId, isPrimary: true }],
    });
    probe.hold?.signal();
    if (probe.hold) await probe.hold.held;
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
  probe: Probe,
): Promise<Provisioned> {
  return client.$transaction(async (tx) => {
    probe.onPid(await backendPid(tx));
    await lockAbstractForWrite(tx, fixture.abstractId);
    const abstract = await tx.abstract.findUniqueOrThrow({
      where: { id: fixture.abstractId },
      include: {
        speakers: { select: { userId: true, isPrimary: true } },
        session: { select: { id: true, categoryId: true, description: true } },
      },
    });
    const result = await provisionAcceptedAbstract(tx, abstract);
    probe.hold?.signal();
    if (probe.hold) await probe.hold.held;
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

// ---- One cell of the matrix, with its lifecycle pinned --------------------

/**
 * The teardown contract, recorded in the order it actually happened.
 *
 * This is asserted, not merely logged. A transaction parked on a barrier holds
 * uncommitted rows for the scratch event, so any cleanup that runs before the
 * hold is released blocks behind it — for the full transaction budget, or
 * forever if the budget were raised. Releasing FIRST, then settling the racers,
 * then deleting, is the only order in which no cleanup step can ever wait on a
 * transaction this test itself is holding open.
 */
const LIFECYCLE = ["hold-released", "racers-settled", "cleanup-completed", "rows-absent"] as const;

type Observed = {
  secondWriterBlocked: boolean;
  assignments: string[];
  reportedAssignments: number;
  speakersOnSession: number;
};

type CellConfig = {
  mode: Mode;
  order: Order;
  fixture: Fixture;
  /** Filled in by the outer `finally`, in the order the steps completed. */
  lifecycle: string[];
  /**
   * Injected at the observation point — after the first transaction has parked
   * on its barrier — to prove the teardown path survives a fault there.
   */
  fault?: () => never;
};

async function runCell(config: CellConfig): Promise<{ observed: Observed; blocked: Blocked }> {
  const { mode, order, fixture, lifecycle } = config;
  const writerClient = new PrismaClient();
  const provisionerClient = new PrismaClient();
  const observer = new PrismaClient();
  const provision = provisionerFor(mode);

  const hold = barrier();
  const started: Promise<unknown>[] = [];
  let firstPid = 0;
  let secondPid = 0;

  try {
    await createFixture(observer, fixture, mode);

    // The first writer runs its whole locked body, then signals from inside its
    // own still-open transaction. No polling, no timer: when `reached` resolves,
    // the lock is held and the work under it is done.
    const firstProbe: Probe = { onPid: (pid) => { firstPid = pid; }, hold };
    const firstRun = settled<TaskWritten | Provisioned>(
      order === "task-writer-first"
        ? requiredTaskWriter(writerClient, fixture, firstProbe)
        : provision(provisionerClient, fixture, firstProbe),
    );
    started.push(firstRun.result);
    // Raced against the run itself, so a first writer that throws before
    // signalling fails the test rather than hanging it.
    await Promise.race([hold.reached, firstRun.result]);

    // Everything from here to `hold.open()` is the stranding window: a throw
    // here leaves a parked transaction, which is exactly what the outer
    // `finally` and the fault-path contract below exist to make survivable.
    config.fault?.();

    // Only now is the second writer issued. It must queue on the fan-out lock
    // rather than read a snapshot taken before the first one commits.
    const secondProbe: Probe = { onPid: (pid) => { secondPid = pid; } };
    const secondRun = settled<TaskWritten | Provisioned>(
      order === "task-writer-first"
        ? provision(provisionerClient, fixture, secondProbe)
        : requiredTaskWriter(writerClient, fixture, secondProbe),
    );
    started.push(secondRun.result);
    const blocked = await observeBlocked(
      observer,
      { first: () => firstPid, second: () => secondPid },
      secondRun.isDone,
    );

    // Released here so the results can be awaited and asserted. The outer
    // `finally` releases again, first and unconditionally; `open` is idempotent.
    hold.open();
    const firstOutcome = await firstRun.result;
    const secondOutcome = await secondRun.result;

    const taskOutcome = order === "task-writer-first" ? firstOutcome : secondOutcome;
    const sessionOutcome = order === "task-writer-first" ? secondOutcome : firstOutcome;
    const taskResult = asTaskWritten(unwrap(taskOutcome, "required-task writer"));
    const sessionResult = asProvisioned(unwrap(sessionOutcome, "session provisioner"));

    const observed: Observed = {
      secondWriterBlocked: blocked.seen,
      assignments: await assignments(observer, fixture, taskResult.taskId),
      reportedAssignments: taskResult.assigned + sessionResult.tasksAssigned,
      speakersOnSession: await observer.sessionSpeaker.count({
        where: { sessionId: sessionResult.sessionId },
      }),
    };
    return { observed, blocked };
  } finally {
    // 1. Release first, before anything else, so no step below can wait on a
    //    transaction this test is holding open.
    hold.open();
    lifecycle.push("hold-released");
    // 2. Let every racer that was actually started finish rolling back or
    //    committing. `settled` promises never reject; `allSettled` is belt.
    await Promise.allSettled(started);
    lifecycle.push("racers-settled");
    try {
      // 3. Loud cleanup: a scratch event left behind on a shared disposable
      //    database is this suite's own failure to report.
      await destroyFixture(observer, fixture);
      lifecycle.push("cleanup-completed");
      await assertFixtureGone(observer, fixture);
      lifecycle.push("rows-absent");
    } finally {
      // 4. Disconnects, last resort, even when cleanup throws.
      await Promise.all([
        writerClient.$disconnect(),
        provisionerClient.$disconnect(),
        observer.$disconnect(),
      ]);
    }
  }
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

      const lifecycle: string[] = [];
      const fixture = planFixture(`${mode}-${order}`);
      const { observed, blocked } = await runCell({ mode, order, fixture, lifecycle });

      t.diagnostic(
        `${mode}/${order}: ${JSON.stringify(observed)} (blocked after ${blocked.polls} polls, wait=${blocked.wait ?? "n/a"})`,
      );

      assert.deepEqual(observed, {
        // The server's own answer to "is the second writer held up by the
        // first": pg_blocking_pids(second) contains the first backend's pid.
        secondWriterBlocked: true,
        // Exactly the cross-product, exactly once: this is the invariant.
        assignments: ["required-task:new-speaker"],
        // And exactly one writer reports having made it — no double count.
        reportedAssignments: 1,
        speakersOnSession: 1,
      });
      // Corroboration, where the server populates it: the wait is on an advisory
      // lock, not a row lock. Skipped rather than guessed where it is null.
      if (blocked.wait !== null) {
        assert.match(blocked.wait, /advisory/i, "the block must be on the advisory fan-out lock");
      }
      // And teardown ran in the only order that cannot deadlock on itself.
      assert.deepEqual(lifecycle, [...LIFECYCLE]);
    },
  );
}

// ---- The fault path -------------------------------------------------------

test(
  "C33 lifecycle: a fault while the first transaction is parked still releases, settles and cleans up",
  { skip, timeout: 300_000 },
  async (t) => {
    requireDisposableDatabase();

    const lifecycle: string[] = [];
    const fixture = planFixture("fault-path");
    const injected = new Error("injected observer fault while the first transaction is parked");

    // The fault fires after the first writer has signalled its barrier, so a
    // transaction is parked holding uncommitted rows for this scratch event.
    // Without the release-first teardown, the delete below would queue behind it.
    await assert.rejects(
      () =>
        runCell({
          mode: "guaranteed",
          order: "task-writer-first",
          fixture,
          lifecycle,
          fault: () => { throw injected; },
        }),
      (error: unknown) => error === injected,
    );

    t.diagnostic(`fault-path lifecycle: ${JSON.stringify(lifecycle)}`);

    // The whole contract, in order: the hold was released first, the one racer
    // that had been started settled, cleanup ran to completion, and the rows are
    // gone. Cleanup completing at all is itself the liveness proof — it deletes
    // rows the parked transaction had locked.
    assert.deepEqual(lifecycle, [...LIFECYCLE]);

    // Verified independently of the client `runCell` used and then disconnected.
    const auditor = new PrismaClient();
    try {
      assert.equal(await auditor.event.count({ where: { id: fixture.eventId } }), 0);
      assert.equal(await auditor.user.count({ where: { id: fixture.userId } }), 0);
      assert.equal(await auditor.onboardingTask.count({ where: { eventId: fixture.eventId } }), 0);
      assert.equal(await auditor.session.count({ where: { eventId: fixture.eventId } }), 0);
    } finally {
      await auditor.$disconnect();
    }
  },
);
