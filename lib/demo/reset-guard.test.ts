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
 * CRLF-safe: no pattern crosses a line break.
 */
test("the route checks the event after authorizing and before seeding", () => {
  const route = source(ROUTE);

  const gateAt = route.indexOf("isDemoResetAllowed()");
  const authAt = route.indexOf("await requireContext([\"ADMIN\"])");
  const guardAt = route.indexOf("demoResetTargetRefusal(ctx.eventId)");
  const seedAt = route.indexOf("await seedDemo(prisma)");

  for (const [name, at] of [["env gate", gateAt], ["auth", authAt], ["guard", guardAt], ["seed", seedAt]] as const) {
    assert.ok(at > 0, `${name} must be present in the route`);
  }
  // Env gate, then authorization, then the event check, then — only then — the
  // destructive rebuild.
  assert.ok(gateAt < authAt, "the env gate stays first");
  assert.ok(authAt < guardAt, "the event check needs the resolved context");
  assert.ok(guardAt < seedAt, "the event check must precede the seed");

  // The context is now captured rather than discarded — that was the bug.
  assert.match(route, /ctx = await requireContext\(\["ADMIN"\]\)/);
  // And the refusal returns, so control cannot fall through to the seed.
  assert.match(route, /if \(wrongEvent\) return fail\(wrongEvent\.code, wrongEvent\.message, wrongEvent\.status\)/);
  // Exactly one seed call, and it is the one guarded above.
  assert.equal((route.match(/seedDemo\(/g) ?? []).length, 1);
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
