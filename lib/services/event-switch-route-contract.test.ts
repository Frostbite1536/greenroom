import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source-level contract for the event switcher (D-C5-16 item 1), in the style of
 * the sibling route-contract suites: these are reuse, absence and wiring
 * properties that no unit test over a pure function can observe, and that a
 * refactor could silently drop.
 *
 * Source assertions are CRLF-safe: no pattern crosses a line break.
 */
const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/** Comment text stripped, so "this file does X" is asserted against code. */
const code = (path: string) =>
  source(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\r\n]*/g, "$1");

const route = code("app/api/auth/switch-event/route.ts");
const shell = code("components/app-shell.tsx");
const layout = code("app/(app)/layout.tsx");
const dialog = code("components/new-event-dialog.tsx");
const frontendSmoke = source("scripts/_frontend-smoke.mjs");

test("the switch route reuses the login session mechanics instead of forking them", () => {
  // Every piece of cookie identity comes from lib/auth. A second signing path
  // is exactly the drift this asserts against.
  assert.match(route, /SESSION_COOKIE,/);
  assert.match(route, /SESSION_TTL_SECONDS,/);
  assert.match(route, /encodeSession,/);
  assert.match(route, /from "@\/lib\/auth"/);
  assert.doesNotMatch(route, /createHmac/);
  assert.doesNotMatch(route, /getServerSigningSecret/);
  assert.doesNotMatch(route, /sb_session/);
  // The TTL is the imported constant, never a retyped literal.
  assert.match(route, /maxAge: SESSION_TTL_SECONDS/);
});

test("the switch route is same-origin gated before it reads anything", () => {
  assert.match(route, /isSameOriginRequest\(originVerdict\(req\)\)/);
  assert.ok(
    route.indexOf("isSameOriginRequest") < route.indexOf("getResolvedSession()"),
    "the origin gate must run before the session is resolved",
  );
  assert.ok(
    route.indexOf("isSameOriginRequest") < route.indexOf("readRequestedEventId"),
    "the origin gate must run before the body is read",
  );
});

test("the membership is the only authority, and it is keyed on the caller's own id", () => {
  // The event id arrives from the client; the user id never does.
  assert.match(route, /eventId_userId: \{ eventId: query\.eventId, userId: query\.userId \}/);
  assert.match(route, /user: current\.user/);
  // No Event lookup at all — an event that exists but is not the caller's must
  // not be answerable from a different query than one that does not exist.
  assert.doesNotMatch(route, /prisma\.event\./);
  // The role is never taken from the session being replaced or from the body.
  assert.doesNotMatch(route, /role: current\.role/);
});

test("unknown and non-member event ids are one refusal, and a refusal writes no cookie", () => {
  assert.match(route, /NOT_FOUND_CODE = "EVENT_NOT_FOUND"/);
  assert.match(route, /refuse\(req, formEncoded, 404, NOT_FOUND_CODE, NOT_FOUND_MESSAGE, current\)/);
  // A database failure is deliberately NOT the 404 — it is its own 503.
  assert.match(route, /UNAVAILABLE_CODE = "SWITCH_UNAVAILABLE"/);
  assert.match(route, /503, UNAVAILABLE_CODE/);
  // `cookies.set` appears exactly once, inside the success path.
  assert.equal(route.match(/cookies\.set\(/g)?.length, 1);
  const establish = route.slice(route.indexOf("function establish"), route.indexOf("async function findMembership"));
  assert.match(establish, /cookies\.set\(SESSION_COOKIE, encodeSession\(session\)/);
});

test("the switch lands on the role-correct home for the event switched INTO", () => {
  const establish = route.slice(route.indexOf("function establish"), route.indexOf("async function findMembership"));
  assert.match(establish, /const home = homeForRole\(session\.role\)/);
  // `session` here is the resolved NEXT session, so the home follows the new
  // event's role rather than the one the caller arrived with.
  assert.match(route, /const next = await resolveEventSwitch\(/);
  assert.match(route, /return establish\(req, formEncoded, next\)/);
});

test("the frontend smoke proves switch-back restoration through the scoped API, not view-dependent markup", () => {
  assert.match(frontendSmoke, /const agendaDataBack = await getAs\("\/api\/agenda", switchedBack\.issued \?\? ""\);/);
  assert.match(frontendSmoke, /redirect: switchedBack\.status === 303 && switchedBack\.location\.endsWith\("\/admin"\)/);
  assert.match(frontendSmoke, /issued: Boolean\(switchedBack\.issued\)/);
  assert.match(frontendSmoke, /ev\.name = "Scratch Frontend Settings"/);
  assert.match(frontendSmoke, /currentEvent: agendaBack\.text\.includes\("<strong>Scratch Frontend Settings<\/strong>"\)/);
  assert.match(frontendSmoke, /session\.id === fx\.sessionA\.id && session\.title === "Scratch Session A"/);
  assert.match(frontendSmoke, /createdEventAbsent: !agendaBack\.text\.includes\("<strong>Scratch Created Event<\/strong>"\)/);
  assert.match(frontendSmoke, /Object\.values\(switchedBackPredicates\)\.every\(Boolean\)/);
  for (const surface of ["dashboardAfter", "agendaAfterSwitch", "abstractsAfterSwitch"]) {
    assert.match(frontendSmoke, new RegExp(`!${surface}\\.text\\.includes\\("<strong>Scratch Frontend Settings<\\/strong>"\\)`));
  }
});

test("the shell renders no switcher for a single membership", () => {
  assert.match(shell, /if \(list\.workspaces\.length <= 1\) return null;/);
  // The current event stays a plain label, exactly as before.
  assert.match(shell, /<strong>\{session\.event\.name\}<\/strong>/);
});

test("the shell's switcher is a plain post to the real endpoint", () => {
  assert.match(shell, /action="\/api\/auth\/switch-event"/);
  assert.match(shell, /method="post"/);
  assert.match(shell, /name="eventId"/);
  // The current event is the preselected option, so "which one am I on" is
  // answerable from the control itself.
  assert.match(shell, /defaultValue=\{session\.event\.id\}/);
  // The switcher is presentation: it must not do its own authorization.
  assert.doesNotMatch(shell, /prisma/);
});

test("the workspace layout lists only the signed-in user's own memberships", () => {
  assert.match(layout, /getUserWorkspaces\(session\.user\.id\)/);
  assert.match(layout, /workspaces=\{workspaces\}/);
  // No event id or email is passed in its place, and nothing else supplies one.
  assert.doesNotMatch(layout, /getUserWorkspaces\(session\.event/);
});

test("the create-event success path offers the switch through the same endpoint", () => {
  assert.match(dialog, /action="\/api\/auth\/switch-event"/);
  assert.match(dialog, /value=\{created\.id\}/);
  // No client-side navigation to a screen still scoped to the old event.
  assert.doesNotMatch(dialog, /router\.push/);
  // One full navigation is allowed and required: the ONBOARDING branch
  // (D-C5-16 #2) just swapped a pending cookie for a real session, and only a
  // fresh document request re-reads it. The created-notice switch offer must
  // still go through the endpoint, so the navigation may appear exactly once,
  // guarded by the onboarding flag.
  const navigations = dialog.match(/window\.location/g) ?? [];
  assert.equal(navigations.length, 1, "only the onboarding branch may navigate");
  assert.match(dialog, /if \(onboarding\) \{[^]*?window\.location\.assign\("\/admin"\);[^]*?\}/);
});

test("the obsoleted 'switching is on the roadmap' copy is gone from the product surfaces", () => {
  for (const path of ["components/new-event-dialog.tsx", "components/app-shell.tsx", "app/login/page.tsx"]) {
    assert.doesNotMatch(
      source(path),
      /switching between events is on the roadmap/i,
      `${path} still claims event switching is unshipped`,
    );
  }
});
