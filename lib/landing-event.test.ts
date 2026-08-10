import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLandingEventParam, resolveLandingEvent } from "@/lib/landing-event";

test("no event parameter means the default programme", () => {
  assert.deepEqual(resolveLandingEvent(undefined, false), {
    eventParam: undefined,
    fellBackToDefault: false,
  });
  // `requestedResolved` is irrelevant when nothing was requested.
  assert.deepEqual(resolveLandingEvent(undefined, true), {
    eventParam: undefined,
    fellBackToDefault: false,
  });
});

test("a blank event parameter is treated as absent, not as a failed lookup", () => {
  assert.deepEqual(resolveLandingEvent("   ", false), {
    eventParam: undefined,
    fellBackToDefault: false,
  });
  assert.equal(normalizeLandingEventParam("  forward-2026 "), "forward-2026");
  assert.equal(normalizeLandingEventParam(""), undefined);
  assert.equal(normalizeLandingEventParam(undefined), undefined);
});

test("a resolving event parameter is honoured for every surface", () => {
  assert.deepEqual(resolveLandingEvent("scratch-frontend", true), {
    eventParam: "scratch-frontend",
    fellBackToDefault: false,
  });
  assert.deepEqual(resolveLandingEvent("  scratch-frontend  ", true), {
    eventParam: "scratch-frontend",
    fellBackToDefault: false,
  });
});

test("an unknown event parameter falls back to the default programme everywhere", () => {
  // The whole point of the fix: the unknown slug must not leak to any read or
  // link, or the page pairs one event's schedule with another event's CFP.
  assert.deepEqual(resolveLandingEvent("does-not-exist", false), {
    eventParam: undefined,
    fellBackToDefault: true,
  });
});

test("an unknown slug resolves identically to no slug at all", () => {
  const unknown = resolveLandingEvent("does-not-exist", false);
  const absent = resolveLandingEvent(undefined, false);
  assert.equal(unknown.eventParam, absent.eventParam);
});
