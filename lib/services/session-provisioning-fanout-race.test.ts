/**
 * C33 invariant race — the two-client proof, against a real Postgres.
 *
 * INV-TASK-001 says every confirmed speaker holds the event's checklist. Two
 * writers maintain that cross-product from opposite ends:
 *
 *  - the **required-task writer** (`POST`/`PATCH /api/admin/tasks`,
 *    `POST /api/admin/tasks/assign`) creates a template and fans it out across
 *    the event's existing confirmed sessions;
 *  - the **session provisioner** (`provisionGuaranteedSession`,
 *    `provisionAcceptedAbstract`) creates a confirmed session and fans the
 *    event's existing templates out across its new speakers.
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
 * These tests prove that against the real database, in BOTH orders, with no
 * sleeps: the interleaving is driven by explicit transaction control and by
 * observing `pg_locks` directly, so nothing here depends on how fast a machine
 * happens to be.
 *
 * ## Running it
 *
 * Double-gated, like every other prerequisite-dependent suite in this repo:
 * plain `npm test` must stay green with no database anywhere, so these tests
 * skip unless BOTH
 *
 *   RACE_PROOF=1              (explicit opt-in), and
 *   DATABASE_URL              (a real, DISPOSABLE Postgres — from the shell or
 *                              from `.env`, loaded the way `e2e/db-guard.ts`
 *                              loads it)
 *
 * are present. Every row written lives under one uniquely named scratch event
 * created by the test and deleted in a `finally`, so a shared disposable
 * database keeps working for everyone else's smokes even if this fails mid-run.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { backfillConfirmedSpeakerTasks } from "@/lib/services/onboarding-task-backfill";
import { lockEventTaskFanOut, taskFanOutLockKey } from "@/lib/services/onboarding-task-lock";
import { provisionGuaranteedSession } from "@/lib/services/session-provisioning";

// ---- Gate -----------------------------------------------------------------

/**
 * The same loader `e2e/db-guard.ts` uses, and for the same reason: this process
 * is not started by `next`, so it does not have the repository `.env` unless we
 * read it. Only consulted once the RACE_PROOF opt-in is present, so a plain
 * `npm test` never so much as looks for a database.
 */
function loadRepoEnv(): void {
  if (process.env.DATABASE_URL) return;
  const file = resolve(process.cwd(), ".env");
  if (!existsSync(file)) return;
  process.loadEnvFile(file);
}

function gateReason(): string | false {
  if (process.env.RACE_PROOF !== "1") {
    return "set RACE_PROOF=1 (with a disposable DATABASE_URL) to run the C33 two-client race proof";
  }
  loadRepoEnv();
  if (!process.env.DATABASE_URL?.startsWith("postgresql://")) {
    return "RACE_PROOF=1 is set but no postgresql:// DATABASE_URL is available";
  }
  return false;
}

const skip = gateReason();

// ---- Observing the lock, without sleeping ---------------------------------

/**
 * A bound on observation loops. Each iteration is a real round trip to the
 * database, not a timer, so this is a safety net against an unexpected hang
 * rather than a timing assumption: every loop below also exits the moment the
 * thing it is waiting for is true, and the thing it waits for is guaranteed to
 * become true and stay true until this test releases it.
 */
const MAX_POLLS = 200;

/** Prisma's interactive-transaction budget. Generous: a blocked writer waits. */
const TX = { timeout: 60_000, maxWait: 20_000 } as const;

/**
 * Where a transaction-scoped advisory lock on `key` shows up in `pg_locks`.
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
  return { classid: rows[0].classid, objid: rows[0].objid };
}

type LockCoordinates = Awaited<ReturnType<typeof lockCoordinates>>;

/**
 * How many backends currently hold (`granted`) or are queued for (`!granted`)
 * this event's fan-out lock.
 */
async function lockHolders(
  observer: PrismaClient,
  coordinates: LockCoordinates,
  granted: boolean,
): Promise<number> {
  const rows = await observer.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype = 'advisory'
      AND granted = ${granted}
      AND classid::text = ${coordinates.classid}
      AND objid::text = ${coordinates.objid}
  `;
  return rows[0].n;
}

/** Poll until the lock is in the asked-for state, or until `done()` gives up. */
async function observe(
  observer: PrismaClient,
  coordinates: LockCoordinates,
  granted: boolean,
  done: () => boolean = () => false,
): Promise<{ seen: boolean; polls: number }> {
  for (let polls = 1; polls <= MAX_POLLS; polls++) {
    if (await lockHolders(observer, coordinates, granted) > 0) return { seen: true, polls };
    if (done()) return { seen: false, polls };
  }
  return { seen: false, polls: MAX_POLLS };
}

/** A promise the test resolves by hand — how a transaction is held open. */
function gate() {
  let open!: () => void;
  const held = new Promise<void>((resolve) => { open = resolve; });
  return { held, open };
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
 * A scratch event of its own, per run and per scenario.
 *
 * Deliberately NOT `demo-event`, `scratch-backend` or `scratch-frontend`: the
 * disposable database is shared with the smoke harnesses, and this suite writes
 * and deletes whole events.
 */
type Fixture = { eventId: string; userId: string };

async function createFixture(client: PrismaClient, label: string): Promise<Fixture> {
  const suffix = `${label}-${randomUUID().slice(0, 8)}`;
  const eventId = `c33-race-${suffix}`;
  const userId = `c33-race-user-${suffix}`;
  await client.event.create({
    data: { id: eventId, name: `C33 race proof ${suffix}`, slug: eventId, timezone: "UTC" },
  });
  await client.user.create({
    data: { id: userId, email: `${userId}@c33-race.test`, name: "Race Proof Speaker" },
  });
  return { eventId, userId };
}

/** Cascades take `Session`/`SessionSpeaker`/`OnboardingTask`/`SpeakerTask` with them. */
async function destroyFixture(client: PrismaClient, fixture: Fixture | null): Promise<void> {
  if (!fixture) return;
  await client.event.deleteMany({ where: { id: fixture.eventId } });
  await client.user.deleteMany({ where: { id: fixture.userId } });
}

/** The required template a `POST /api/admin/tasks` would create, plus its fan-out. */
async function requiredTaskWriter(client: PrismaClient, fixture: Fixture, held?: Promise<void>) {
  return client.$transaction(async (tx) => {
    await lockEventTaskFanOut(tx, fixture.eventId);
    const task = await tx.onboardingTask.create({
      data: { eventId: fixture.eventId, title: TASK_TITLE, required: true, sortOrder: 0 },
      select: { id: true },
    });
    const fanOut = await backfillConfirmedSpeakerTasks(tx, fixture.eventId);
    if (held) await held;
    return { taskId: task.id, assigned: fanOut.assigned };
  }, TX);
}

/** The talk `POST /api/agenda/sessions` would author, through the real provisioner. */
async function sessionProvisioner(client: PrismaClient, fixture: Fixture, held?: Promise<void>) {
  return client.$transaction(async (tx) => {
    const result = await provisionGuaranteedSession(tx, fixture.eventId, {
      title: "Opening keynote",
      durationMinutes: 45,
      speakers: [{ userId: fixture.userId, isPrimary: true }],
    });
    if (held) await held;
    return result;
  }, TX);
}

/**
 * What the database is left holding: the checklist assignments for this event,
 * named rather than keyed so a failure prints the story instead of two cuids.
 */
async function assignments(observer: PrismaClient, fixture: Fixture, taskId: string | null) {
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

// ---- The two orders -------------------------------------------------------

test(
  "C33: the required-task writer commits first, and the new talk still gets its task",
  { skip, timeout: 300_000 },
  async (t) => {
    const writer = new PrismaClient();
    const provisioner = new PrismaClient();
    const observer = new PrismaClient();
    let fixture: Fixture | null = null;

    try {
      fixture = await createFixture(observer, "a-first");
      const coordinates = await lockCoordinates(observer, fixture.eventId);

      // A: create the required template and fan it out over the event's
      // confirmed sessions (there are none yet), then hold the transaction open.
      const hold = gate();
      const writerRun = settled(requiredTaskWriter(writer, fixture, hold.held));
      const held = await observe(observer, coordinates, true, writerRun.isDone);

      // B: only now is the talk authored. It must queue behind A rather than
      // reading a snapshot taken before A's template exists.
      const provisionerRun = settled(sessionProvisioner(provisioner, fixture));
      const blocked = await observe(observer, coordinates, false, provisionerRun.isDone);

      // Released before any assertion, so a failing run still lets both
      // transactions finish and the fixture still cleans up.
      hold.open();
      const writerResult = unwrap(await writerRun.result, "required-task writer");
      const provisionerResult = unwrap(await provisionerRun.result, "session provisioner");

      const observed = {
        firstWriterHoldsLock: held.seen,
        secondWriterBlocked: blocked.seen,
        assignments: await assignments(observer, fixture, writerResult.taskId),
        reportedAssignments: writerResult.assigned + provisionerResult.tasksAssigned,
        speakersOnSession: await observer.sessionSpeaker.count({
          where: { sessionId: provisionerResult.sessionId },
        }),
      };
      t.diagnostic(`task-writer-first: ${JSON.stringify(observed)} (polls: held=${held.polls}, blocked=${blocked.polls})`);

      assert.deepEqual(observed, {
        // The required-task writer serialized the whole class behind itself...
        firstWriterHoldsLock: true,
        // ...and the provisioner queued on it instead of racing past it.
        secondWriterBlocked: true,
        // Exactly the cross-product, exactly once: this is the invariant.
        assignments: ["required-task:new-speaker"],
        // And exactly one writer reports having made it — no double count.
        reportedAssignments: 1,
        speakersOnSession: 1,
      });
    } finally {
      await destroyFixture(observer, fixture).catch(() => {});
      await Promise.all([writer.$disconnect(), provisioner.$disconnect(), observer.$disconnect()]);
    }
  },
);

test(
  "C33: the new talk commits first, and the required task still reaches its speaker",
  { skip, timeout: 300_000 },
  async (t) => {
    const writer = new PrismaClient();
    const provisioner = new PrismaClient();
    const observer = new PrismaClient();
    let fixture: Fixture | null = null;

    try {
      fixture = await createFixture(observer, "b-first");
      const coordinates = await lockCoordinates(observer, fixture.eventId);

      // B: author the talk and its roster, fan out the event's templates (there
      // are none yet), then hold the transaction open.
      const hold = gate();
      const provisionerRun = settled(sessionProvisioner(provisioner, fixture, hold.held));
      const held = await observe(observer, coordinates, true, provisionerRun.isDone);

      // A: only now is the required template created. It must queue behind B
      // rather than backfilling over a session it cannot see.
      const writerRun = settled(requiredTaskWriter(writer, fixture));
      const blocked = await observe(observer, coordinates, false, writerRun.isDone);

      // Released before any assertion, so a failing run still lets both
      // transactions finish and the fixture still cleans up.
      hold.open();
      const provisionerResult = unwrap(await provisionerRun.result, "session provisioner");
      const writerResult = unwrap(await writerRun.result, "required-task writer");

      const observed = {
        firstWriterHoldsLock: held.seen,
        secondWriterBlocked: blocked.seen,
        assignments: await assignments(observer, fixture, writerResult.taskId),
        reportedAssignments: writerResult.assigned + provisionerResult.tasksAssigned,
        speakersOnSession: await observer.sessionSpeaker.count({
          where: { sessionId: provisionerResult.sessionId },
        }),
      };
      t.diagnostic(`provisioning-first: ${JSON.stringify(observed)} (polls: held=${held.polls}, blocked=${blocked.polls})`);

      assert.deepEqual(observed, {
        // The provisioner serialized the whole class behind itself...
        firstWriterHoldsLock: true,
        // ...and the required-task writer queued on it.
        secondWriterBlocked: true,
        assignments: ["required-task:new-speaker"],
        reportedAssignments: 1,
        speakersOnSession: 1,
      });
    } finally {
      await destroyFixture(observer, fixture).catch(() => {});
      await Promise.all([writer.$disconnect(), provisioner.$disconnect(), observer.$disconnect()]);
    }
  },
);
