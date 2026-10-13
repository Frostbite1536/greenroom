import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrismaClient } from "@prisma/client";
import { DEMO_CREDENTIAL_EMAILS, DEMO_FIXTURE_IDENTITIES, DEMO_SEED_PERSONAS, demoSeedRefusal, seedDemo } from "./seed";

test("SEC-01: the demo seed refuses production unless ALLOW_DEMO_RESET opts in", () => {
  assert.match(demoSeedRefusal({ NODE_ENV: "production" }) ?? "", /ALLOW_DEMO_RESET=true/);
  assert.match(demoSeedRefusal({ NODE_ENV: "production", ALLOW_DEMO_RESET: "false" }) ?? "", /ALLOW_DEMO_RESET=true/);
  assert.equal(demoSeedRefusal({ NODE_ENV: "production", ALLOW_DEMO_RESET: "true" }), null);
  assert.equal(demoSeedRefusal({ NODE_ENV: "development" }), null);
  assert.equal(demoSeedRefusal({}), null);
});

test("SEC-01: a refused seed throws before it touches the database", async () => {
  const env = process.env as Record<string, string | undefined>;
  const saved = { NODE_ENV: env.NODE_ENV, ALLOW_DEMO_RESET: env.ALLOW_DEMO_RESET };
  let touched = false;
  const prisma = new Proxy({}, {
    get() {
      touched = true;
      throw new Error("the database was touched");
    },
  }) as PrismaClient;
  try {
    env.NODE_ENV = "production";
    delete env.ALLOW_DEMO_RESET;
    await assert.rejects(seedDemo(prisma), /Refusing to seed demo data/);
    assert.equal(touched, false);
  } finally {
    env.NODE_ENV = saved.NODE_ENV;
    if (saved.ALLOW_DEMO_RESET === undefined) delete env.ALLOW_DEMO_RESET;
    else env.ALLOW_DEMO_RESET = saved.ALLOW_DEMO_RESET;
  }
});

test("SEC-01: every seeded credential address is in the demo-credential set", () => {
  const expected = [
    ...Object.values(DEMO_SEED_PERSONAS).map((persona) => persona.email),
    ...DEMO_FIXTURE_IDENTITIES.flatMap((identity) => [...identity.emails]),
  ].map((email) => email.toLowerCase());
  assert.deepEqual([...DEMO_CREDENTIAL_EMAILS].sort(), [...new Set(expected)].sort());
  assert.equal(DEMO_CREDENTIAL_EMAILS.size, 9);
});
