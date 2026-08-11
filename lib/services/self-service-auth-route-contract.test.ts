import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  PASSWORD_RESET_INVALID_TOKEN_MESSAGE,
  PASSWORD_RESET_NEUTRAL_MESSAGE,
} from "./self-service-auth-copy";
import { SELF_SERVICE_AUTH_RATE_LIMITS, selfServiceAuthRatePlan } from "./self-service-auth-rate";
import { forgotPasswordSchema, passwordResetSchema, signupSchema } from "@/types/api";

/**
 * The self-service auth surface (D-C5-16 item 2).
 *
 * Source assertions are CRLF-safe: no pattern crosses a line break, and every
 * ordering claim is made with `indexOf` rather than a multi-line regex.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

/** Comment text stripped, so "this file does X" is asserted against code. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\r\n]*/g, "$1");

const signup = read("app/api/auth/signup/route.ts");
const forgot = read("app/api/auth/forgot/route.ts");
const reset = read("app/api/auth/reset/route.ts");
const cont = read("app/api/auth/continue/route.ts");
const events = read("app/api/admin/events/route.ts");
const shared = read("lib/api/auth-request.ts");
const mailer = read("lib/comms/password-reset.ts");
const redeem = read("lib/services/password-reset-redeem.ts");

const signupPage = read("app/signup/page.tsx");
const forgotPage = read("app/forgot/page.tsx");
const resetPage = read("app/reset/page.tsx");
const welcomePage = read("app/welcome/page.tsx");
const loginPage = read("app/login/page.tsx");
const smoke = read("scripts/_smoke.mjs");
const frontendSmoke = read("scripts/_frontend-smoke.mjs");

const SESSION_CHANGING = [
  ["signup", signup],
  ["forgot", forgot],
  ["reset", reset],
  ["continue", cont],
] as const;

test("every session-changing post is gated on origin before anything else happens", () => {
  for (const [name, route] of SESSION_CHANGING) {
    const gate = route.indexOf("if (!isSameOriginAuthRequest(req)) return refuseCrossOrigin(");
    assert.ok(gate > 0, `${name} must gate on the request's origin`);
    // Before the body, before the throttle, before any identity. A request that
    // cannot prove it came from this site reaches none of them.
    for (const later of ["await readAuthFields(", "await enforceSelfServiceAuthRateLimit(", "prisma.user.", "await getPendingIdentity("]) {
      const at = route.indexOf(later);
      if (at === -1) continue;
      assert.ok(gate < at, `${name}: the origin gate must precede ${later}`);
    }
    // The gate is unconditional — `formEncoded` selects the refusal's shape,
    // never whether the check applies. A text/plain form can be crafted into a
    // valid JSON body, so gating one mode would leave a preflight-free bypass.
    assert.equal(route.split("isSameOriginAuthRequest(").length - 1, 1, `${name}: exactly one gate`);
    assert.doesNotMatch(route, /if \(formEncoded\)[^\r\n]*isSameOriginAuthRequest/);
  }
});

test("the throttle is charged before any User row is read", () => {
  for (const [name, route] of [["signup", signup], ["forgot", forgot], ["reset", reset]] as const) {
    const throttle = route.indexOf("await enforceSelfServiceAuthRateLimit(");
    assert.ok(throttle > 0, `${name} must enforce the self-service throttle`);
    for (const lookup of ["prisma.user.", "resolvePasswordResetToken(", "maybeSendResetLink("]) {
      const at = route.indexOf(lookup);
      if (at === -1) continue;
      assert.ok(throttle < at, `${name}: throttling after ${lookup} would make it an account oracle`);
    }
  }
  // The intents are exactly the three public endpoints, and `/continue` — which
  // is unreachable without an already-valid signed cookie — deliberately has none.
  assert.doesNotMatch(cont, /enforceSelfServiceAuthRateLimit/);
});

test("the rate rules are durable buckets with the ruled bounds, not a new table", () => {
  // Reuse, not a fork: the shared plan builder and the shared enforcement.
  const rate = read("lib/services/self-service-auth-rate.ts");
  assert.match(rate, /from "@\/lib\/services\/public-submission-rate";/);
  assert.match(rate, /enforceRateBucketPlans\(\{/);
  assert.doesNotMatch(rate, /CREATE TABLE|\$queryRaw|prisma\.\$transaction/);
  // Its own advisory namespace, so a signup burst never queues behind login.
  assert.match(rate, /SELF_SERVICE_AUTH_RATE_NAMESPACE = "self-service-auth-rate";/);

  // Every rule is hourly, every rule is bounded, and the per-address rules are
  // the narrow ones — an inbox must not be floodable even from many addresses.
  for (const [name, rule] of Object.entries(SELF_SERVICE_AUTH_RATE_LIMITS)) {
    assert.equal(rule.windowMs, 60 * 60 * 1_000, `${name} must be an hourly window`);
    assert.ok(rule.limit > 0 && rule.limit <= 10, `${name} must be bounded, got ${rule.limit}`);
  }
  assert.ok(SELF_SERVICE_AUTH_RATE_LIMITS.signupEmail.limit < SELF_SERVICE_AUTH_RATE_LIMITS.signupIp.limit);
  assert.ok(SELF_SERVICE_AUTH_RATE_LIMITS.forgotEmail.limit < SELF_SERVICE_AUTH_RATE_LIMITS.forgotIp.limit);
  // The per-address bucket is charged first only in the sense that it is the one
  // that fires first in practice; ordering itself is by `order`, IP before email.
  assert.ok(SELF_SERVICE_AUTH_RATE_LIMITS.signupIp.order < SELF_SERVICE_AUTH_RATE_LIMITS.signupEmail.order);
  assert.ok(SELF_SERVICE_AUTH_RATE_LIMITS.forgotIp.order < SELF_SERVICE_AUTH_RATE_LIMITS.forgotEmail.order);

  const now = new Date(Date.UTC(2026, 7, 10, 12, 0, 0));
  const args = { email: "someone@example.test", clientIp: "203.0.113.9", secret: "test-secret", now };
  const signupPlans = selfServiceAuthRatePlan({ ...args, intent: "signup" });
  const forgotPlans = selfServiceAuthRatePlan({ ...args, intent: "forgot" });
  const resetPlans = selfServiceAuthRatePlan({ ...args, intent: "reset" });
  assert.deepEqual(signupPlans.map((p) => p.scope), ["signup_ip_1h", "signup_email_1h"]);
  assert.deepEqual(forgotPlans.map((p) => p.scope), ["forgot_ip_1h", "forgot_email_1h"]);
  // No per-address bucket on redemption: the redeemer supplies a token, not an
  // address, and a bucket keyed off the token's user id would make the throttle
  // behave differently depending on which account the token names.
  assert.deepEqual(resetPlans.map((p) => p.scope), ["reset_ip_1h"]);
  // Fingerprints are HMACs — no raw address or IP reaches storage.
  for (const plan of [...signupPlans, ...forgotPlans]) {
    assert.match(plan.fingerprint, /^[0-9a-f]{64}$/);
    assert.ok(!plan.fingerprint.includes("example.test"));
    assert.ok(!plan.fingerprint.includes("203.0.113.9"));
  }
  // An address that differs only in case charges the same bucket.
  const upper = selfServiceAuthRatePlan({ ...args, email: "SOMEONE@Example.TEST", intent: "forgot" });
  assert.deepEqual(upper.map((p) => p.fingerprint), forgotPlans.map((p) => p.fingerprint));
});

test("/forgot answers the same bytes whether or not the address has an account", () => {
  // Exactly one success construction site, and it is the shared constant.
  assert.equal(forgot.split("ok: true").length - 1, 1);
  assert.match(forgot, /data: \{ message: PASSWORD_RESET_NEUTRAL_MESSAGE \}/);
  assert.equal(forgot.split("?sent=1").length - 1, 1);
  assert.ok(PASSWORD_RESET_NEUTRAL_MESSAGE.length > 0);

  // The lookup cannot reach the response: it happens inside a helper whose
  // return type is void, called in a try/catch that swallows everything, and
  // `neutral(...)` is the single statement after it.
  assert.match(forgot, /async function maybeSendResetLink\(email: string\): Promise<void> \{/);
  const call = forgot.indexOf("await maybeSendResetLink(");
  const answer = forgot.indexOf("return neutral(req, formEncoded);");
  assert.ok(call > 0 && answer > call, "the send must precede the one neutral answer");
  // No status, no code, no branch derived from whether a user was found.
  assert.doesNotMatch(forgot, /USER_NOT_FOUND|NO_ACCOUNT|UNKNOWN_EMAIL|status: 404/);
  const helper = forgot.slice(forgot.indexOf("async function maybeSendResetLink"));
  assert.doesNotMatch(helper, /return neutral|NextResponse|throw new ApiError/);
});

test("/reset collapses every token failure into one message, shared with its page", () => {
  assert.equal(reset.split("PASSWORD_RESET_INVALID_TOKEN_MESSAGE").length - 1, 2, "imported and used once");
  assert.match(resetPage, /PASSWORD_RESET_INVALID_TOKEN_MESSAGE/);
  assert.ok(PASSWORD_RESET_INVALID_TOKEN_MESSAGE.length > 0);
  for (const leak of [/TOKEN_EXPIRED/, /TOKEN_USED/, /ALREADY_USED/, /UNKNOWN_USER/, /NO_CREDENTIAL/]) {
    assert.doesNotMatch(reset, leak);
    assert.doesNotMatch(redeem, leak);
  }
  // The resolver collapses them, and the page uses the same resolver, so it can
  // never render a form the route would refuse.
  assert.match(resetPage, /await resolvePasswordResetToken\(token\)/);
  assert.equal(redeem.split("return null;").length - 1, 4, "malformed, no secret, unknown user, bad signature");
  // The redeeming write is the credential and nothing else.
  assert.match(reset, /prisma\.user\.update\(\{ where: \{ id: resolved\.user\.id \}, data: \{ passwordHash \} \}\)/);
  // One write, and it is the credential. A reset must not grant a membership or
  // change a role — anything beyond the password makes a phished link more
  // valuable than it already is. (`role:` alone would false-positive on the
  // session the route issues afterwards from a membership it merely read.)
  assert.equal(reset.split("prisma.user.update(").length - 1, 1);
  assert.doesNotMatch(reset, /eventMember|\.create\(|data: \{ role/);
});

test("use-once is enforced by construction: the signature is derived from the current hash", () => {
  assert.match(redeem, /verifyPasswordResetToken\(parts, user\.passwordHash, secret\)/);
  // No revocation bookkeeping anywhere — that is the point of the design.
  const token = read("lib/services/password-reset-token.ts");
  // Comments stripped: "No `usedAt` column" is exactly the claim being made, and
  // asserting against prose would forbid stating it.
  for (const source of [token, redeem, reset, forgot]) {
    assert.doesNotMatch(code(source), /usedAt|revokedAt|consumedAt|redeemedAt/);
    assert.doesNotMatch(code(source), /prisma\.passwordReset|tx\.passwordReset/);
  }
  // And no schema change was smuggled in to support it.
  const schema = read("prisma/schema.prisma");
  assert.doesNotMatch(schema, /model PasswordReset/);
  assert.doesNotMatch(schema, /resetToken/i);
});

test("cookies are issued through one helper with the login route's exact attributes", () => {
  for (const [name, route] of [["signup", signup], ["reset", reset], ["continue", cont], ["events", events]] as const) {
    if (!route.includes("setSessionCookie(")) continue;
    // No parallel signing, no hand-rolled cookie serialization, no second set of
    // attributes that could drift from the login route's.
    assert.doesNotMatch(route, /createHmac|Set-Cookie|httpOnly:|sameSite:|maxAge:/, `${name} must not re-implement the cookie`);
  }
  for (const option of ["httpOnly: true", 'sameSite: "lax"', 'path: "/"', "maxAge: SESSION_TTL_SECONDS", 'secure: process.env.NODE_ENV === "production"']) {
    assert.ok(shared.includes(option), `the shared issuer must set ${option}`);
  }
  assert.equal(shared.split("cookies.set(").length - 1, 1, "one cookie-setting site for the new surfaces");
  // Roles and events are never taken from a request body.
  for (const [name, route] of SESSION_CHANGING) {
    assert.doesNotMatch(route, /fields\.role|fields\.event|body\.role|params\.get\("role"\)/, `${name} must not read authority from the request`);
  }
});

test("a new account is issued the pending variant, never a session it has no membership for", () => {
  assert.match(signup, /encodePendingSession\(user\)/);
  assert.doesNotMatch(signup, /encodeSession\(/);
  assert.match(signup, /redirectTo: "\/welcome"/);
  // Reset and continue may issue a real session, but only from a membership the
  // database already holds, chosen by the same picker credential login uses.
  for (const route of [reset, cont]) {
    assert.match(route, /pickCredentialMembership\(/);
    assert.match(route, /homeForRole\(membership\.role\)/);
  }
});

test("the frontend smoke checks an empty composite EventMember projection", () => {
  assert.match(frontendSmoke, /memberships: \{ select: \{ eventId: true, userId: true \} \}/);
  assert.doesNotMatch(frontendSmoke, /memberships: \{ select: \{ id: true \} \}/);
});

test("the taken-address 409 is deliberate, documented, and the only one", () => {
  assert.match(signup, /const EMAIL_TAKEN_CODE = "EMAIL_TAKEN";/);
  assert.equal(signup.split("authFail(409,").length - 1, 1, "exactly one 409 construction site");
  assert.equal(signup.split("?error=taken").length - 1, 1, "one form-mode target for it");
  // The calm copy points at both doors that work and names no account detail.
  assert.match(signup, /Sign in instead, or reset the password if you have forgotten it\./);
  assert.doesNotMatch(signup, /has a password|is an admin|belongs to/i);
  // The tradeoff is recorded where the decision lives, and the opposite call on
  // /forgot is recorded too — neither is an accident.
  assert.match(signup, /enumeration tradeoff/i);
  assert.match(forgot, /oracle/i);
  // It is a P2002 on the unique column, not a read-then-write race.
  assert.match(signup, /error\.code === "P2002"/);
  assert.doesNotMatch(signup, /findUnique|findFirst/);
});

test("the reset email rides the audited dispatch path and never stores the bearer", () => {
  assert.match(mailer, /from "@\/lib\/comms\/send";/);
  assert.match(mailer, /await dispatchEmail\(db, \{/);
  assert.doesNotMatch(mailer, /api\.resend\.com|RESEND_API_KEY|fetch\(/);
  // C21 truth rule: fixed copy, and the audit row says so rather than claiming a
  // template drove it.
  assert.match(mailer, /source: "fixed"/);
  assert.doesNotMatch(mailer, /renderEmailTemplate/);
  // The token and the URL that carries it are durable-storage poison.
  const variables = mailer.slice(mailer.indexOf("variables: {"), mailer.indexOf("fetcher: options.fetcher"));
  assert.doesNotMatch(variables, /resetUrl|token/);
  // Links are built from configured deployment URL only — never a request Host.
  assert.match(mailer, /process\.env\.APP_URL/);
  assert.doesNotMatch(mailer, /headers\.get\("host"\)|x-forwarded-host/);
  assert.match(mailer, /return process\.env\.NODE_ENV === "production" \? null : "http:\/\/localhost:3000";/);
  // Never throws: /forgot's neutrality must not depend on the provider.
  assert.match(mailer, /catch \(error\) \{/);
  assert.doesNotMatch(mailer, /throw new/);
});

test("live sends are impossible unless the deployment explicitly opts out of mock", () => {
  const send = read("lib/comms/send.ts");
  const env = read("lib/env.ts");
  // The reset mailer inherits the one mock branch every other send uses; it has
  // no provider call of its own to forget to gate.
  assert.match(send, /mocked: useMockIntegrations\(\)/);
  assert.match(send, /if \(!canDeliverEmail\(config\)\) return \{ status: "mocked" \};/);
  // Default-deny: the flag has to be the literal string "false" to allow a real
  // call, so an unset variable in a test or smoke run mocks.
  assert.match(env, /return \(process\.env\.MOCK_EXTERNAL_APIS \?\? "true"\) !== "false";/);
});

test("nothing on this surface logs a body, an address, a password, or a token", () => {
  /**
   * A structural pin, not a word blacklist. Every diagnostic on this surface
   * must be a **literal** label plus a bounded exception class and nothing else,
   * which forbids any variable other than `error` reaching a log by
   * construction. A blacklist would both miss a new leak (`fields.secret`) and
   * false-positive on honest prose ("password could not be changed").
   *
   * `[^\r\n]`, not `[^\n]`: a CRLF checkout would otherwise smuggle the \r into
   * the captured line and break the `$` anchor.
   */
  const LABEL = String.raw`(?:"\[[a-z-]+\] [A-Za-z ._]+"|\x60\[\$\{label\}\] [A-Za-z ._]+\x60)`;
  const SHAPE = new RegExp(
    String.raw`^console\.(warn|error)\(${LABEL}, (diagnosticLabel\(error\)|error instanceof Error \? error\.name : "unknown")\);$`,
  );
  // The one interpolated label is the shared body reader's, and `label` is the
  // caller's own literal — pinned here so it can never become a request value.
  const callers = shared.includes("label: string,");
  assert.ok(callers, "readAuthFields must take its label as a parameter");
  for (const [name, route] of SESSION_CHANGING) {
    if (!route.includes("readAuthFields(")) continue;
    assert.match(route, /readAuthFields\(req, "[a-z-]+", formEncoded\)/, `${name} must pass a literal label`);
  }
  let checked = 0;
  for (const [name, route] of [...SESSION_CHANGING, ["shared", shared], ["mailer", mailer]] as const) {
    const logs = route.match(/console\.\w+\([^\r\n]*/g) ?? [];
    for (const line of logs) {
      assert.match(line, SHAPE, `${name}: diagnostic must be a fixed label plus a bounded class`);
      checked += 1;
    }
  }
  // The pin is worthless if it inspected nothing.
  assert.ok(checked >= 8, `expected the surface to carry diagnostics, saw ${checked}`);
  // No catch on this surface discards its cause silently.
  for (const [name, route] of SESSION_CHANGING) {
    assert.doesNotMatch(route, /\} catch \{/, `${name} must label what it swallows`);
  }
});

test("scrypt needs the node runtime, and no response is cacheable", () => {
  for (const [name, route] of SESSION_CHANGING) {
    assert.match(route, /export const runtime = "nodejs";/, name);
    assert.match(route, /export const dynamic = "force-dynamic";/, name);
    // Every return goes through noStore — including every refusal.
    const bare = route.match(/return (?!noStore|refuse|authRedirect|\{|prisma)[^\r\n;]*NextResponse[^\r\n;]*/g) ?? [];
    assert.deepEqual(bare, [], `${name} returned a response outside noStore`);
  }
  assert.match(shared, /response\.headers\.set\("Cache-Control", "no-store"\)/);
  assert.match(shared, /response\.headers\.set\("Referrer-Policy", "no-referrer"\)/);
  // The reset page resolves a token from the query string; a cached render of it
  // would be a cached account decision.
  assert.match(resetPage, /export const dynamic = "force-dynamic";/);
});

test("the request schemas are strict and reject authority identifiers", () => {
  const good = { email: "someone@example.test", password: "a".repeat(12), confirmPassword: "a".repeat(12) };
  assert.equal(signupSchema.safeParse(good).success, true);
  assert.equal(signupSchema.safeParse({ ...good, eventId: "demo-event" }).success, false);
  assert.equal(signupSchema.safeParse({ ...good, role: "ADMIN" }).success, false);
  assert.equal(signupSchema.safeParse({ ...good, email: "not-an-address" }).success, false);
  assert.equal(signupSchema.safeParse({ ...good, email: `${"a".repeat(250)}@example.test` }).success, false);
  // Normalisation is in the schema, so the bucket key and the stored row agree.
  const normalized = signupSchema.parse({ ...good, email: "  SomeOne@Example.TEST " });
  assert.equal(normalized.email, "someone@example.test");

  assert.equal(forgotPasswordSchema.safeParse({ email: "someone@example.test" }).success, true);
  assert.equal(forgotPasswordSchema.safeParse({ email: "someone@example.test", userId: "u" }).success, false);

  assert.equal(passwordResetSchema.safeParse({ token: "v1.a.1.b", password: "a".repeat(12), confirmPassword: "a".repeat(12) }).success, true);
  assert.equal(passwordResetSchema.safeParse({ token: "", password: "a".repeat(12), confirmPassword: "a".repeat(12) }).success, false);
  assert.equal(passwordResetSchema.safeParse({ token: "v1.a.1.b", password: "a".repeat(12), confirmPassword: "a".repeat(12), userId: "u" }).success, false);
});

test("the first-event bootstrap can only ever create someone's first event", () => {
  // The branch exists, and it is bounded by a zero-membership assertion rather
  // than by hope. A pending identity that already belongs to something takes the
  // same generic 401 an anonymous caller takes.
  assert.match(events, /if \(!pending \|\| pending\.memberships\.length > 0\) \{/);
  assert.match(events, /throw new ApiError\(401, "UNAUTHENTICATED", "Sign in to continue\."\);/);
  // The ADMIN refusal for a signed-in non-admin is byte-identical to the one
  // `requireContext(["ADMIN"])` produced before this route grew a second caller.
  const context = read("lib/api/context.ts");
  const message = 'You do not have access to this resource.';
  assert.ok(events.includes(`throw new ApiError(403, "FORBIDDEN", "${message}")`));
  assert.ok(context.includes(message));
  // The membership is still written in the same transaction as the event.
  const tx = events.indexOf("prisma.$transaction");
  assert.ok(tx > 0 && events.indexOf("tx.eventMember.create(") > tx);
  // The role is the one the transaction wrote, never anything requested.
  assert.match(events, /role: "ADMIN",/);
  assert.doesNotMatch(events, /input\.role|data\.role/);
});

test("the public pages post plain forms, label every field, and link the other doors", () => {
  for (const [name, page, action] of [
    ["signup", signupPage, "/api/auth/signup"],
    ["forgot", forgotPage, "/api/auth/forgot"],
    ["reset", resetPage, "/api/auth/reset"],
  ] as const) {
    assert.ok(page.includes(`action="${action}"`), `${name} must post to ${action}`);
    assert.match(page, /method="post"/, name);
    assert.match(page, /role="alert"/, name);
  }
  // Password managers get the right hints, and new secrets are never labelled
  // as current ones.
  for (const page of [signupPage, resetPage]) {
    assert.match(page, /autoComplete="new-password"/);
    assert.doesNotMatch(page, /autoComplete="current-password"/);
  }
  for (const id of ["signup-email", "signup-password", "signup-confirm"]) {
    assert.ok(signupPage.includes(`htmlFor="${id}"`), `signup must label ${id}`);
    assert.ok(signupPage.includes(`id="${id}"`), `signup must carry ${id}`);
  }
  assert.ok(resetPage.includes('name="token"') && resetPage.includes('type="hidden"'));
  // The strength floor is shown beside the field, from the same constant the
  // server enforces.
  for (const page of [signupPage, resetPage]) {
    assert.match(page, /PASSWORD_POLICY_HINT/);
  }
  // /forgot renders the neutral sentence from the shared constant, not a copy.
  assert.match(forgotPage, /PASSWORD_RESET_NEUTRAL_MESSAGE/);
  assert.doesNotMatch(forgotPage, /we sent|we have sent|no account/i);
});

test("login and the runtime smoke both advertise the shipped self-service doors", () => {
  assert.match(loginPage, /<Link href="\/signup">Create one<\/Link>/);
  assert.match(loginPage, /<Link href="\/forgot">Reset it<\/Link>/);
  assert.ok(smoke.includes(`loginHtml.includes('href="/signup"') && /Create one/.test(loginHtml)`));
  assert.ok(smoke.includes(`loginHtml.includes('href="/forgot"') && /Reset it/.test(loginHtml)`));
  assert.doesNotMatch(smoke, /Self-service sign-up is on the roadmap|for now organizers provision accounts/);
});

test("the welcome page is the membership-less landing, and it offers both ways out", () => {
  // A real session belongs somewhere else; an unsigned visitor belongs at login.
  assert.match(welcomePage, /if \(session\) redirect\(homeForRole\(session\.role\)\);/);
  assert.match(welcomePage, /if \(!pending\) redirect\("\/login"\);/);
  assert.match(welcomePage, /<NewEventDialog onboarding \/>/);
  assert.match(welcomePage, /action="\/api\/auth\/continue"/);
  assert.match(welcomePage, /ask an organizer to/i);
  // And /login knows to send a pending identity here rather than showing it the
  // form it just came from.
  assert.match(loginPage, /const pending = await getPendingIdentity\(\);/);
  assert.match(loginPage, /redirect\("\/welcome"\);/);
});
