import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getOpenAiApiKey, getServerEnv, ServerEnvError } from "./env";

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
  "OPENAI_API_KEY",
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
  // Absent is a supported configuration: it disables the assistant, and must
  // never be an error that stops the application booting.
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test("an absent or unusable assistant credential reads as disabled, never as a throw", () => {
  for (const value of [undefined, "", "   ", "sk-short"]) {
    withEnv({ DATABASE_URL: "postgresql://user:pw@db.example.test:5432/greenroom", OPENAI_API_KEY: value }, () => {
      assert.equal(getOpenAiApiKey(), undefined, `${JSON.stringify(value)} must read as absent`);
    });
  }
  const key = "sk-proj-not-a-real-key-0000000000";
  withEnv({ DATABASE_URL: "postgresql://user:pw@db.example.test:5432/greenroom", OPENAI_API_KEY: ` ${key} ` }, () => {
    assert.equal(getOpenAiApiKey(), key, "a usable key is returned trimmed");
  });
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

/**
 * `NODE_ENV` is deliberately NOT one of the managed variables above: it is
 * Node's, not this deployment's, and the schema never reads it as data. It is
 * patched here because it is the one input that decides whether a missing
 * `SESSION_SECRET` is a supported configuration or a refusal.
 */
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function withNodeEnv<T>(nodeEnv: string | undefined, fn: () => T): T {
  const env = process.env as Record<string, string | undefined>;
  try {
    if (nodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = nodeEnv;
    return fn();
  } finally {
    if (ORIGINAL_NODE_ENV === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
}

const GOOD_DATABASE_URL = "postgresql://user:pw@db.example.test:5432/greenroom";
const GOOD_SECRET = "a".repeat(32);

test("a production boot with no SESSION_SECRET is refused, by name", () => {
  // The documented rule (DECISIONS: \"required in production\"; DEPLOY: \"fails
  // closed without it\") was enforced at the FIRST SIGN-IN, not at boot: the
  // schema made it `.optional()`, so `register()` passed, the health check
  // answered 200, and every `/login` then 503'd. A deployment that cannot
  // authenticate anyone is a failed deployment and must look like one.
  for (const value of [undefined, "", "    "]) {
    assert.throws(
      () => withNodeEnv("production", () => withEnv({ DATABASE_URL: GOOD_DATABASE_URL, SESSION_SECRET: value }, getServerEnv)),
      (error: unknown) =>
        error instanceof ServerEnvError &&
        error.variables.includes("SESSION_SECRET") &&
        /SESSION_SECRET/.test(error.message),
      `${JSON.stringify(value)} must be refused in production`,
    );
  }
  // And the reason names production, so an operator is not left guessing why
  // the same configuration worked locally.
  try {
    withNodeEnv("production", () => withEnv({ DATABASE_URL: GOOD_DATABASE_URL }, getServerEnv));
    assert.fail("a production boot with no SESSION_SECRET must throw");
  } catch (error) {
    assert.ok(error instanceof ServerEnvError);
    assert.match(error.message, /SESSION_SECRET is required in production/);
  }
});

test("a production SESSION_SECRET below the floor is refused without echoing it", () => {
  const short = "hunter2-SHORT-PRODUCTION-SECRET";
  assert.equal(short.length < 32, true, "the fixture must actually be short");
  try {
    withNodeEnv("production", () => withEnv({ DATABASE_URL: GOOD_DATABASE_URL, SESSION_SECRET: short }, getServerEnv));
    assert.fail("a short production secret must throw");
  } catch (error) {
    assert.ok(error instanceof ServerEnvError);
    assert.ok(error.variables.includes("SESSION_SECRET"));
    const rendered = `${error.message} ${JSON.stringify(error.variables)} ${error.stack ?? ""}`;
    assert.equal(rendered.includes(short), false, "this string reaches a deploy log");
    assert.equal(rendered.includes("hunter2"), false);
    assert.match(error.message, /at least 32 characters/);
  }
});

test("a production boot with a usable SESSION_SECRET parses", () => {
  const env = withNodeEnv("production", () =>
    withEnv({ DATABASE_URL: GOOD_DATABASE_URL, SESSION_SECRET: GOOD_SECRET }, getServerEnv),
  );
  assert.equal(env.SESSION_SECRET, GOOD_SECRET);
  // Trimmed by the schema, exactly as `getServerSigningSecret` trims it, so the
  // boot check and the signer cannot disagree about what counts.
  const padded = withNodeEnv("production", () =>
    withEnv({ DATABASE_URL: GOOD_DATABASE_URL, SESSION_SECRET: `  ${GOOD_SECRET}  ` }, getServerEnv),
  );
  assert.equal(padded.SESSION_SECRET, GOOD_SECRET);
});

test("outside production an absent SESSION_SECRET is still a supported configuration", () => {
  // This is what keeps `npm test`, `next dev`, the seeds and the local golden
  // path running with DATABASE_URL as the only variable anyone must set —
  // `lib/server-signing.ts` supplies the non-production fallback.
  for (const nodeEnv of [undefined, "development", "test"]) {
    const env = withNodeEnv(nodeEnv, () => withEnv({ DATABASE_URL: GOOD_DATABASE_URL }, getServerEnv));
    assert.equal(env.SESSION_SECRET, undefined, `NODE_ENV=${String(nodeEnv)} must stay bootable`);
  }
  // A near-miss spelling is not production: the check is an exact match, the
  // same rule `arePersonaLoginsEnabled` already applies.
  for (const nodeEnv of ["PRODUCTION", "prod", "production-like"]) {
    const env = withNodeEnv(nodeEnv, () => withEnv({ DATABASE_URL: GOOD_DATABASE_URL }, getServerEnv));
    assert.equal(env.SESSION_SECRET, undefined, `NODE_ENV=${nodeEnv} is not production`);
  }
});

test("a production refusal reports every broken variable at once, not just the first", () => {
  try {
    withNodeEnv("production", () => withEnv({ DATABASE_URL: "mysql://user:pw@db/greenroom" }, getServerEnv));
    assert.fail("must throw");
  } catch (error) {
    assert.ok(error instanceof ServerEnvError);
    // One deploy, one list of things to fix.
    assert.deepEqual([...error.variables].sort(), ["DATABASE_URL", "SESSION_SECRET"]);
  }
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
