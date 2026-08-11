/**
 * C33 lock-order contract for the two provisioning entry points.
 *
 * `session-provisioning-fanout-race.test.ts` proves the behaviour against a real
 * Postgres, in both orders — but it is gated behind `RACE_PROOF=1` and a
 * disposable database, so it does not run on an ordinary `npm test`. This file
 * is the rail that runs every time: *where* the lock is taken is a property of
 * the source, and "first, before anything else this function awaits" is the part
 * of the fix that no unit test with a fake transaction client can observe.
 *
 * Why first, and why here rather than anywhere else:
 *
 *  - **Both entry points, not one.** A talk becomes confirmed either by
 *    acceptance (`provisionAcceptedAbstract`) or by direct authoring
 *    (`provisionGuaranteedSession`). Both maintain the onboarding-task ×
 *    session-speaker cross-product from the session end; the template writers
 *    maintain it from the task end. Locking one entry point and not the other
 *    leaves the identical race open on the other door.
 *  - **Not in the routes.** Four call sites (two accept paths, the direct-create
 *    route, and any future one) would each have to remember, and a forgotten one
 *    is invisible until a speaker is silently missing a required task.
 *  - **Not in `assignOnboardingTasks`.** It is the low-level fan-out, called
 *    once per session by the C33 backfill inside a transaction that already
 *    holds this very lock. Acquiring per call would be re-entrant noise at best
 *    and, if it ever moved to a non-transaction-scoped lock, a self-deadlock.
 *
 * Regexes are CRLF-safe: nothing matches across a line break without allowing
 * an optional `\r`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const raw = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/**
 * The same file with comments stripped. Every assertion below is about what the
 * code does, and this lane's own prose names `lockEventTaskFanOut` repeatedly —
 * without this, a doc comment would satisfy a contract about a call.
 */
const code = (path: string) =>
  raw(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

const PROVISIONING = "lib/services/session-provisioning.ts";

/** One top-level `export async function`, up to the closing brace in column 0. */
function body(source: string, name: string): string {
  const at = source.indexOf(`export async function ${name}(`);
  assert.ok(at >= 0, `${name} must be an exported async function`);
  const rest = source.slice(at);
  // A brace alone in column 0. Not merely `\n}`: a multi-line return type ends
  // `}> {`, which would truncate the body before its first statement.
  const end = rest.search(/\r?\n\}(\r?\n|$)/);
  assert.ok(end > 0, `${name} must be terminated by a brace in column 0`);
  return rest.slice(0, end);
}

/** Every awaited call in a function body, in source order. */
function awaitedCalls(source: string, name: string): string[] {
  return [...body(source, name).matchAll(/await\s+([\w$.]+)\s*\(/g)].map(([, callee]) => callee);
}

// ---- 1. The lock is taken, and taken first, at both entry points -----------

test("C33: provisioning imports the existing per-event fan-out lock", () => {
  // The same helper the four template writers take, not a second key: the point
  // is to join their lock class, and a private copy would serialize nothing.
  assert.match(
    raw(PROVISIONING),
    /import \{ lockEventTaskFanOut \} from "@\/lib\/services\/onboarding-task-lock";/,
  );
});

test("C33: the direct-authoring entry point locks before it creates the session", () => {
  const guaranteed = body(code(PROVISIONING), "provisionGuaranteedSession");
  assert.match(guaranteed, /await lockEventTaskFanOut\(tx, eventId\);/);
  // First-awaited, so no row lock is held while this one is waited for, and so
  // the session cannot come into existence in the window before the lock.
  assert.deepEqual(awaitedCalls(code(PROVISIONING), "provisionGuaranteedSession"), [
    "lockEventTaskFanOut",
    "tx.session.create",
    "tx.sessionSpeaker.createMany",
    "assignOnboardingTasks",
  ]);
});

test("C33: the acceptance entry point locks before it provisions the session", () => {
  const accepted = body(code(PROVISIONING), "provisionAcceptedAbstract");
  // The abstract's own event, never a caller-supplied one: the lock has to name
  // the event whose cross-product is about to change.
  assert.match(accepted, /await lockEventTaskFanOut\(tx, abstract\.eventId\);/);
  assert.deepEqual(awaitedCalls(code(PROVISIONING), "provisionAcceptedAbstract"), [
    "lockEventTaskFanOut",
    "provisionSessionForAbstract",
    "assignOnboardingTasks",
  ]);
});

// ---- 2. Taken there and nowhere else --------------------------------------

test("C33: the lock lives at the entry points, not in the routes that call them", () => {
  // Exactly two acquisitions in the module: one per entry point.
  assert.equal((code(PROVISIONING).match(/lockEventTaskFanOut\(/g) ?? []).length, 2);

  for (const route of [
    "app/api/agenda/sessions/route.ts",
    "app/api/evaluations/decisions/route.ts",
    "app/api/evaluations/convert/route.ts",
  ]) {
    assert.doesNotMatch(
      code(route),
      /lockEventTaskFanOut/,
      `${route} must not duplicate the lock its provisioning call already takes`,
    );
  }
});

test("C33: the low-level fan-out takes no lock of its own", () => {
  // Called once per session by `backfillConfirmedSpeakerTasks`, inside a
  // transaction that already holds this lock. It stays a pure write helper.
  for (const helper of ["assignOnboardingTasks", "provisionSessionForAbstract"]) {
    assert.doesNotMatch(
      body(code(PROVISIONING), helper),
      /lockEventTaskFanOut/,
      `${helper} is below the lock boundary and must not acquire it`,
    );
  }
  assert.doesNotMatch(code("lib/services/onboarding-task-backfill.ts"), /lockEventTaskFanOut/);
});

// ---- 3. The other side of the class, and the absent reverse edge -----------

test("C33: every template writer still takes the same lock first", () => {
  // The half of the class that already existed. If one of these stopped taking
  // it, the entry points above would be serializing against nothing. Each is
  // the FIRST statement of its transaction callback, which is the same "first
  // awaited operation" property asserted for the two entry points above.
  const locksFirst = String.raw`\$transaction\(async \(tx\) => \{\s*await lockEventTaskFanOut\(tx, ctx\.eventId\);`;
  const tasks = code("app/api/admin/tasks/route.ts");
  // POST, PATCH and DELETE — every template mutation on the event.
  assert.equal((tasks.match(new RegExp(locksFirst, "g")) ?? []).length, 3);
  assert.equal((tasks.match(/lockEventTaskFanOut\(/g) ?? []).length, 3);
  assert.match(code("app/api/admin/tasks/assign/route.ts"), new RegExp(locksFirst));
});

test("C33: no writer takes the abstract lock after the fan-out lock", () => {
  // What makes abstract → fan-out safe to add: the lock graph gains an edge, not
  // a cycle. None of the writers on the other side of the fan-out lock touches
  // the per-abstract lock at all, so there is no path back.
  for (const route of ["app/api/admin/tasks/route.ts", "app/api/admin/tasks/assign/route.ts"]) {
    assert.doesNotMatch(
      code(route),
      /lockAbstractForWrite/,
      `${route} would close a lock cycle against the accept path`,
    );
  }
  // And the accept paths take them in the documented order: abstract first, then
  // the fan-out lock inside provisioning.
  for (const route of ["app/api/evaluations/decisions/route.ts", "app/api/evaluations/convert/route.ts"]) {
    const source = code(route);
    assert.ok(
      source.indexOf("lockAbstractForWrite(") < source.indexOf("provisionAcceptedAbstract("),
      `${route} must hold the abstract lock before provisioning takes the fan-out lock`,
    );
  }
});
