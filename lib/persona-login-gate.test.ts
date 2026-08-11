import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { arePersonaLoginsEnabled } from "./env";

/**
 * GRA2-01 — the passwordless one-click `/login` personas must fail closed.
 *
 * They are the judged demo's front door and stay unconditionally on in
 * development, test and the `next start` smoke harnesses (none of which set the
 * flag). In PRODUCTION they are refused unless `DEMO_PERSONA_LOGIN_ENABLED` is
 * exactly the string "true" — so a deployment that forgets the variable, fat
 * fingers it, or copies a stale value publishes no unauthenticated role login.
 *
 * Source assertions are CRLF-safe: no pattern crosses a line break.
 */
const NODE_ENV = process.env.NODE_ENV;
const FLAG = process.env.DEMO_PERSONA_LOGIN_ENABLED;

/** `NODE_ENV` is a narrow literal type; the runtime value is just a string. */
function setEnv(nodeEnv: string | undefined, flag: string | undefined): void {
  const env = process.env as Record<string, string | undefined>;
  if (nodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = nodeEnv;
  if (flag === undefined) delete env.DEMO_PERSONA_LOGIN_ENABLED;
  else env.DEMO_PERSONA_LOGIN_ENABLED = flag;
}

function restore(): void {
  setEnv(NODE_ENV, FLAG);
}

test("production with no flag at all refuses — the whole point of fail-closed", (t) => {
  t.after(restore);
  setEnv("production", undefined);
  assert.equal(arePersonaLoginsEnabled(), false);
});

test('production with "false" refuses', (t) => {
  t.after(restore);
  setEnv("production", "false");
  assert.equal(arePersonaLoginsEnabled(), false);
});

test("production with a malformed value refuses rather than guessing", (t) => {
  t.after(restore);
  // Every one of these is somebody meaning "on". None of them counts: a gate
  // that interprets is a gate that eventually interprets wrongly.
  for (const value of ["TRUE", "True", "1", "yes", "on", " true", "true ", "", "enabled", "0"]) {
    setEnv("production", value);
    assert.equal(arePersonaLoginsEnabled(), false, `production must refuse ${JSON.stringify(value)}`);
  }
});

test('production with exactly "true" enables the personas', (t) => {
  t.after(restore);
  setEnv("production", "true");
  assert.equal(arePersonaLoginsEnabled(), true);
});

test("outside production the personas need no flag, so nothing else changes", (t) => {
  t.after(restore);
  // Development, the unit runner, and anything unset. Every existing test and
  // smoke runs in one of these and must keep passing untouched.
  for (const nodeEnv of ["development", "test", undefined]) {
    for (const flag of [undefined, "false", "true", "garbage"]) {
      setEnv(nodeEnv, flag);
      assert.equal(
        arePersonaLoginsEnabled(),
        true,
        `personas must stay on for NODE_ENV=${String(nodeEnv)} flag=${String(flag)}`,
      );
    }
  }
});

test("the gate reads the environment on every call, not once at import", (t) => {
  t.after(restore);
  // A module-level constant would bake the build-time value in and make the
  // deployment's own configuration unable to turn the personas on.
  setEnv("production", undefined);
  assert.equal(arePersonaLoginsEnabled(), false);
  setEnv("production", "true");
  assert.equal(arePersonaLoginsEnabled(), true);
  setEnv("production", "false");
  assert.equal(arePersonaLoginsEnabled(), false);
});

// --- the surfaces that must consult it -------------------------------------

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const action = source("app/login/actions.ts");
const page = source("app/login/page.tsx");
const env = source("lib/env.ts");

test("the server action is the boundary, and refuses before touching a persona", () => {
  assert.match(action, /import \{ arePersonaLoginsEnabled \} from "@\/lib\/env"/);
  assert.match(action, /if \(!arePersonaLoginsEnabled\(\)\) redirect\("\/login\?error=personas-disabled"\)/);
  // Hiding buttons is presentation; this action is a POST endpoint anybody can
  // call directly, so the check must precede the lookup and the cookie write.
  assert.ok(action.indexOf("arePersonaLoginsEnabled()") < action.indexOf('formData.get("persona")'));
  assert.ok(action.indexOf("arePersonaLoginsEnabled()") < action.indexOf("await establish("));
});

test("the login page hides the buttons off the same helper, not its own copy", () => {
  assert.match(page, /import \{ arePersonaLoginsEnabled \} from "@\/lib\/env"/);
  assert.match(page, /const personasEnabled = arePersonaLoginsEnabled\(\)/);
  assert.match(page, /\{personasEnabled \? \(/);
  // No second reading of the raw variable anywhere but the helper itself.
  assert.doesNotMatch(page, /process\.env\.DEMO_PERSONA_LOGIN_ENABLED/);
  assert.doesNotMatch(action, /process\.env\.DEMO_PERSONA_LOGIN_ENABLED/);
  assert.equal((env.match(/process\.env\.DEMO_PERSONA_LOGIN_ENABLED/g) ?? []).length, 2);
});

test("the refusal lands on a page that explains itself calmly", () => {
  assert.match(page, /if \(error === "personas-disabled"\) \{/);
  assert.match(page, /One-click demo accounts are turned off on this deployment\./);
  // It points at the sign-in that does work rather than dead-ending.
  assert.match(page, /Sign in with your email and password\./);
});

test("the credentials form is never gated — it is the way in when personas are off", () => {
  assert.match(page, /<form className="login-credentials" method="post" action="\/api\/auth\/login">/);
  assert.ok(page.indexOf('className="login-credentials"') < page.indexOf("{personasEnabled ? ("));
});

test("the flag is declared in the env schema beside the other demo gate", () => {
  assert.match(env, /DEMO_PERSONA_LOGIN_ENABLED: boolish\.default\("false"\)/);
  assert.match(env, /DEMO_PERSONA_LOGIN_ENABLED: process\.env\.DEMO_PERSONA_LOGIN_ENABLED,/);
  // Production is the only environment the flag governs.
  assert.match(env, /if \(process\.env\.NODE_ENV !== "production"\) return true;/);
});
