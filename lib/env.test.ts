import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getServerEnv, ServerEnvError } from "./env";

/**
 * D-02. `lib/env.ts` carried a complete `envSchema` with ZERO call sites: the
 * `postgresql://` check on `DATABASE_URL`, the 32-character floor on
 * `SESSION_SECRET`, the URL shape of `ACCELEVENTS_BASE_URL` — none of it ever
 * executed. A deployment with a mistyped variable booted green, reported
 * healthy, and failed at whatever request first touched the broken thing.
 *
 * `instrumentation.ts` is the fix; these are the tests that stop it rotting
 * back. Two properties matter and are both asserted below:
 *   1. the schema actually refuses a bad environment, and accepts a good one;
 *   2. the refusal names the VARIABLE and never its VALUE — this error lands
 *      in a deploy log, which is the last place a secret may be echoed.
 *
 * Source assertions are CRLF-safe: no pattern crosses a line break.
 */

const MANAGED = [
  "DATABASE_URL",
  "MOCK_EXTERNAL_APIS",
  "ALLOW_DEMO_RESET",
  "RESEND_API_KEY",
  "RESEND_FROM",
  "ACCELEVENTS_BASE_URL",
  "ACCELEVENTS_API_KEY",
  "AIRTABLE_API_KEY",
  "AIRTABLE_BASE_ID",
  "GREENROOM_API_KEY",
  "SESSION_SECRET",
  "APP_URL",
] as const;

/** Run `fn` against exactly `patch`, with every other managed variable unset. */
function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map(MANAGED.map((name) => [name, process.env[name]]));
  try {
    for (const name of MANAGED) delete process.env[name];
    for (const [name, value] of Object.entries(patch)) {
      if (value !== undefined) process.env[name] = value;
    }
    return fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("D-02: a well-formed environment parses, and the optional variables stay optional", () => {
  const env = withEnv({ DATABASE_URL: "postgresql://user:pw@db.example.test:5432/greenroom" }, getServerEnv);
  assert.equal(env.DATABASE_URL, "postgresql://user:pw@db.example.test:5432/greenroom");
  // The two documented safe defaults, which is what makes DATABASE_URL the
  // only variable a local install must set.
  assert.equal(env.MOCK_EXTERNAL_APIS, "true");
  assert.equal(env.ALLOW_DEMO_RESET, "false");
  assert.equal(env.SESSION_SECRET, undefined);
  assert.equal(env.GREENROOM_API_KEY, undefined);
});

test("D-02: a malformed DATABASE_URL is refused, and the refusal names it", () => {
  for (const [label, value] of [
    ["absent", undefined],
    ["not a URL at all", "greenroom-db"],
    ["the wrong driver", "mysql://user:pw@db.example.test/greenroom"],
    // The exact near-miss the schema exists to catch: a real, valid URL that
    // Prisma's postgres client cannot use.
    ["postgres:// rather than postgresql://", "postgres://user:pw@db.example.test/greenroom"],
    ["empty", ""],
  ] as const) {
    assert.throws(
      () => withEnv({ DATABASE_URL: value }, getServerEnv),
      (error: unknown) =>
        error instanceof ServerEnvError &&
        error.variables.includes("DATABASE_URL") &&
        /DATABASE_URL/.test(error.message),
      `${label} must be refused by name`,
    );
  }
});

test("D-02: the refusal never echoes the rejected value", () => {
  // Every code path that can carry a value in zod's own message, in one go:
  // `invalid_enum_value` interpolates the received value into BOTH `received`
  // and `message`, which is what a raw ZodError would have printed to a deploy
  // log. These stand in for a leaked credential.
  const secrets = {
    DATABASE_URL: "mysql://root:hunter2-DB-PASSWORD@db.internal:5432/greenroom",
    MOCK_EXTERNAL_APIS: "hunter2-MOCK-VALUE",
    ALLOW_DEMO_RESET: "hunter2-RESET-VALUE",
    SESSION_SECRET: "hunter2-SHORT",
    GREENROOM_API_KEY: "hunter2-V1-KEY",
    ACCELEVENTS_BASE_URL: "hunter2-NOT-A-URL",
    RESEND_FROM: "hunter2-NOT-AN-EMAIL",
  };

  let thrown: unknown;
  try {
    withEnv(secrets, getServerEnv);
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof ServerEnvError, "the bad environment must be refused");
  const rendered = `${thrown.message} ${JSON.stringify(thrown.variables)} ${thrown.stack ?? ""}`;
  for (const [name, value] of Object.entries(secrets)) {
    assert.equal(
      rendered.includes(value),
      false,
      `the error echoed the value of ${name} — this string reaches a deploy log`,
    );
    // Non-vacuity: it did not stay silent instead. Each offending variable is
    // named, so an operator knows what to fix without being shown what they set.
    assert.ok(thrown.variables.includes(name), `${name} must be named in the refusal`);
  }
  assert.equal(rendered.includes("hunter2"), false);
});

test("D-02: getServerEnv is actually wired to Next's boot hook", () => {
  // The whole finding was an unreferenced schema. Pin the call site, or the
  // validation quietly becomes dead code again.
  const hook = readFileSync(new URL("../instrumentation.ts", import.meta.url), "utf8");
  assert.match(hook, /export function register\(\)/, "must export Next's register hook");
  assert.match(hook, /getServerEnv\(\)/, "register must call getServerEnv");
  assert.match(hook, /from "@\/lib\/env"/);
  // Node runtime only: the same hook runs on Edge, where these server-only
  // variables are absent, and validating there would fail deploys wrongly.
  assert.match(hook, /process\.env\.NEXT_RUNTIME !== "nodejs"/);
  // It must RETHROW. Swallowing the error would restore the exact bug: a
  // misconfigured deployment that boots green.
  assert.match(hook, /^\s*throw error;$/m);
});

test("D-02: the value-free reasons are built from issue codes, not zod's message", () => {
  const env = readFileSync(new URL("./env.ts", import.meta.url), "utf8");
  // `message` is where zod interpolates the rejected value, so the only issue
  // code allowed to use it is `custom`, whose messages are authored in this
  // very file and are value-free by construction.
  const describe = env.slice(env.indexOf("function describeIssue"), env.indexOf("export function getServerEnv"));
  assert.match(describe, /case "invalid_enum_value":/);
  assert.match(describe, /issue\.options\.map/, "enum options come from the schema, not the input");
  assert.equal(
    (describe.match(/issue\.message/g) ?? []).length,
    1,
    "only the custom-refine branch may pass a zod message through",
  );
  assert.match(env, /safeParse\(readServerEnv\(\)\)/, "the raw ZodError must never escape");
  assert.equal(/envSchema\.parse\(/.test(env), false, "`.parse` would throw the value-carrying ZodError");
});
