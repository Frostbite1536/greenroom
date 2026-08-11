import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEMO_EVENT } from "@/lib/demo/seed";
import {
  DEMO_RESET_TARGET_EVENT_ID,
  demoResetTargetRefusal,
  RESET_WRONG_EVENT_CODE,
  RESET_WRONG_EVENT_MESSAGE,
} from "@/lib/demo/reset-guard";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const ROUTE = "app/api/admin/reset/route.ts";

test("the reset target is read from the seed, never retyped", () => {
  // A literal here could drift from the event `seedDemo` actually rebuilds, and
  // a guard comparing against the wrong id is worse than no guard.
  assert.equal(DEMO_RESET_TARGET_EVENT_ID, DEMO_EVENT.id);
  assert.doesNotMatch(
    source("lib/demo/reset-guard.ts").replace(/\/\*[\s\S]*?\*\//g, ""),
    /"demo-event"/,
  );
});

test("the demo event's own admin is allowed through", () => {
  assert.equal(demoResetTargetRefusal(DEMO_EVENT.id), null);
});

test("an admin of any other event is refused 403 and never reaches the seed", () => {
  // The exact hazard: a valid ADMIN session, on a real event, in a deployment
  // where ALLOW_DEMO_RESET is on.
  for (const eventId of [
    "another-event",
    "evt_a_new_event_created_from_the_admin_form",
    "",
    // Near-misses: the comparison is exact, not a prefix or a case fold.
    "demo-event-2",
    "DEMO-EVENT",
    " demo-event",
  ]) {
    assert.deepEqual(
      demoResetTargetRefusal(eventId),
      { code: RESET_WRONG_EVENT_CODE, message: RESET_WRONG_EVENT_MESSAGE, status: 403 },
      `${JSON.stringify(eventId)} must be refused`,
    );
  }
  assert.equal(RESET_WRONG_EVENT_CODE, "RESET_WRONG_EVENT");
});

test("the refusal names an action and leaks no internals", () => {
  // Honest and actionable: it says what reset does and what to change. It does
  // not disclose the target id, which is not the caller's to know.
  assert.match(RESET_WRONG_EVENT_MESSAGE, /Switch your active event/);
  assert.doesNotMatch(RESET_WRONG_EVENT_MESSAGE, /demo-event/);
});

/**
 * "No seed runs" is an ordering property of the handler, so it is asserted
 * against the route source: the guard sits after the authorization it depends
 * on, and before the only call that writes. There is no route-execution harness
 * in this repo (`npm test` runs `lib/**` only), which is why this is a source
 * assertion rather than an invoked handler — stated plainly rather than implied.
 *
 * S-18 amended the order this test pins. Authorization now runs FIRST, ahead of
 * the environment gate: with the gate first, an anonymous POST received
 * `RESET_DISABLED` on a deployment with reset off and `FORBIDDEN` on one with
 * it on, so the refusal body was a free read of `ALLOW_DEMO_RESET` for anyone
 * who had proved nothing. The seed's position is unchanged — it is still last,
 * behind all three checks, so every refusal writes nothing.
 *
 * CRLF-safe: no pattern crosses a line break.
 */
test("the route authorizes first, then configuration, then the event, then seeds", () => {
  const route = source(ROUTE);

  const authAt = route.indexOf("await requireContext([\"ADMIN\"])");
  const gateAt = route.indexOf("isDemoResetAllowed()");
  const guardAt = route.indexOf("demoResetTargetRefusal(ctx.eventId)");
  const seedAt = route.indexOf("await seedDemo(prisma)");

  for (const [name, at] of [["auth", authAt], ["env gate", gateAt], ["guard", guardAt], ["seed", seedAt]] as const) {
    assert.ok(at > 0, `${name} must be present in the route`);
  }
  // S-18: nothing about this deployment's configuration may be reachable by a
  // caller who has not authenticated as an admin of it.
  assert.ok(authAt < gateAt, "authorization must precede the environment gate (S-18)");
  assert.ok(gateAt < guardAt, "the configuration gate precedes the event check");
  assert.ok(guardAt < seedAt, "the event check must precede the seed");

  // The context is captured rather than discarded — that was GRA2-05's bug.
  assert.match(route, /ctx = await requireContext\(\["ADMIN"\]\)/);
  // And the refusal returns, so control cannot fall through to the seed.
  assert.match(route, /if \(wrongEvent\) return fail\(wrongEvent\.code, wrongEvent\.message, wrongEvent\.status\)/);
  // Exactly one seed call, and it is the one guarded above.
  assert.equal((route.match(/seedDemo\(/g) ?? []).length, 1);
});

/**
 * S-18, stated as the property rather than as an ordering: the ONLY refusal an
 * unauthenticated caller can reach is the authorization one. Everything the
 * route can say about how this deployment is configured — which flag is unset,
 * which event is the reset target — sits behind `requireContext`.
 */
test("only the authorization refusal is reachable before requireContext", () => {
  // Comments stripped: the handler's own doc block explains S-18 and therefore
  // names every string below. This must assert against code, not prose.
  const route = source(ROUTE)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\r\n]*/g, "$1");
  // Anchored at the handler body, not the file: the import block names all of
  // these and is not a reachable branch.
  const bodyAt = route.indexOf("export async function POST()");
  const authAt = route.indexOf("await requireContext([\"ADMIN\"])");
  assert.ok(bodyAt > 0 && authAt > bodyAt, "the handler must authorize inside its own body");
  const beforeAuth = route.slice(bodyAt, authAt);

  for (const disclosure of [
    "RESET_DISABLED",
    "ALLOW_DEMO_RESET",
    "demoResetTargetRefusal",
    "RESET_WRONG_EVENT",
    "seedDemo(",
  ]) {
    assert.equal(
      beforeAuth.includes(disclosure),
      false,
      `${disclosure} is reachable before authorization — an anonymous prober can read it`,
    );
  }

  // Non-vacuity: those strings do exist in this route, just later. Without this
  // the check above would pass just as happily against an empty file.
  const afterAuth = route.slice(authAt);
  for (const disclosure of ["RESET_DISABLED", "demoResetTargetRefusal", "seedDemo("]) {
    assert.ok(afterAuth.includes(disclosure), `${disclosure} must still exist after authorization`);
  }
});

/**
 * The two anonymous probes in the ops smoke are the executing half of S-18: it
 * boots one server with ALLOW_DEMO_RESET unset and another with it set, and
 * both anonymous POSTs must produce the identical body. Pinned here because a
 * future edit could quietly put `RESET_DISABLED` back in the closed-gate arm
 * and the smoke would still pass 2/2 while proving the opposite.
 */
test("the ops smoke probes both flag states anonymously and expects one body", () => {
  const smoke = readFileSync(new URL("../../scripts/ops-smoke.mjs", import.meta.url), "utf8");
  assert.match(smoke, /ALLOW_DEMO_RESET: ""/, "one run must have the gate closed");
  assert.match(smoke, /ALLOW_DEMO_RESET: "true"/, "the other must have it open");
  assert.match(smoke, /noAuthBody\?\.error\?\.code === "FORBIDDEN"/, "closed-gate anonymous → FORBIDDEN");
  assert.match(smoke, /anonBody\?\.error\?\.code === "FORBIDDEN"/, "open-gate anonymous → FORBIDDEN");
  // The authenticated branch keeps the actionable, configuration-specific body.
  assert.match(smoke, /asAdminBody\?\.error\?\.code === "RESET_DISABLED"/);
});

test("the pre-existing reset guardrails are untouched", () => {
  const route = source(ROUTE);
  // INV-RESET-001: POST only, env-gated, admin-only. The new check is additive.
  assert.match(route, /export async function POST\(\)/);
  assert.doesNotMatch(route, /export async function (GET|DELETE|PUT|PATCH)\(/);
  assert.match(route, /if \(!isDemoResetAllowed\(\)\)/);
  assert.match(route, /return fail\("RESET_DISABLED"/);
  assert.match(route, /return fail\("FORBIDDEN"/);
  assert.match(route, /return fail\("AUTH_UNAVAILABLE"/);
  assert.match(route, /return fail\("RESET_FAILED"/);
});
