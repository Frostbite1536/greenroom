import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parsePasswordCredential, verifyPassword } from "@/lib/password-credential";
import { DEMO_FIXTURE_IDENTITIES, DEMO_PERSONA_PASSWORD } from "./seed";
import { DEMO_PERSONAS } from "@/lib/auth";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const seedSource = readFileSync(path.join(repoRoot, "lib/demo/seed.ts"), "utf8");

test("the harness fixture identities D-C5-6 names are all seeded, with every address form", () => {
  assert.deepEqual(
    DEMO_FIXTURE_IDENTITIES.map((identity) => identity.name),
    ["Jordan Alvarez", "Priya Raman", "Sam Whitfield"],
  );
  assert.deepEqual(
    DEMO_FIXTURE_IDENTITIES.map((identity) => identity.role),
    ["ADMIN", "SPEAKER", "EVALUATOR"],
  );
  // Both known harness address conventions per identity: the canonical
  // `sbek-<role>@example.com` fixture form and the `@sbek-test.example.com`
  // form its scenario specs type into forms.
  for (const identity of DEMO_FIXTURE_IDENTITIES) {
    assert.ok(identity.emails.length >= 2, `${identity.name} needs every known address form`);
    for (const email of identity.emails) {
      assert.equal(email, email.toLowerCase(), "seeded addresses must already be normalized");
      assert.match(email, /^[^@\s]+@[^@\s]+$/);
    }
  }
  const all: string[] = DEMO_FIXTURE_IDENTITIES.flatMap((identity) => [...identity.emails]);
  assert.equal(new Set(all).size, all.length, "an address may belong to only one identity");
  for (const persona of Object.values(DEMO_PERSONAS)) {
    assert.ok(!all.includes(persona.user.email), "a fixture must not shadow a demo persona");
  }
});

test("every seeded password is non-trivial and distinct per identity", () => {
  const passwords = [DEMO_PERSONA_PASSWORD, ...DEMO_FIXTURE_IDENTITIES.map((identity) => identity.password)];
  assert.equal(new Set(passwords).size, passwords.length);
  for (const password of passwords) {
    assert.ok(password.length >= 12, "a demo password still has to survive a casual guess");
    assert.doesNotMatch(password, /^(password|demo|test|1234)/i);
  }
});

test("the seed stores a scrypt hash, never a plaintext, and hashes outside the transaction", async () => {
  // The write path never sees a plaintext: it only ever reads from the
  // pre-derived credential map.
  assert.match(seedSource, /credentials\.set\(email, await hashPassword\(plaintext\)\)/);
  assert.match(seedSource, /update: \{ name, \.\.\.\(passwordHash \? \{ passwordHash \} : \{\}\) \}/);
  assert.match(seedSource, /create: \{ email: lower, name, \.\.\.\(passwordHash \? \{ passwordHash \} : \{\}\) \}/);
  // Derivation happens before `prisma.$transaction`, so scrypt never holds the
  // seed advisory lock.
  assert.ok(
    seedSource.indexOf("credentials.set(email, await hashPassword(plaintext))") <
      seedSource.indexOf("return prisma.$transaction("),
    "credentials must be derived before the seed transaction opens",
  );
  assert.doesNotMatch(seedSource, /passwordHash: (?!passwordHash)["'`a-z]/i);

  // The constants really are usable credentials.
  const stored = await import("@/lib/password-credential").then((m) => m.hashPassword(DEMO_PERSONA_PASSWORD));
  assert.ok(parsePasswordCredential(stored));
  assert.equal(await verifyPassword(DEMO_PERSONA_PASSWORD, stored), true);
  assert.equal(await verifyPassword(DEMO_FIXTURE_IDENTITIES[0].password, stored), false);
});

test("a demo reset preserves credentials rather than dropping the identities", () => {
  // Users are global and upserted; the event-scoped wipe must not touch them.
  assert.doesNotMatch(seedSource, /db\.user\.deleteMany/);
  assert.match(seedSource, /db\.user\.upsert\(\{/);
  // Fixture memberships are rebuilt with the rest, so a reset restores the
  // role their home page depends on.
  assert.match(seedSource, /\.\.\.fixtureUsers\.map\(\(f\) => \(\{ eventId, userId: f\.id, role: f\.role \}\)\)/);
  // Fixture speakers are kept out of the deterministic speaker pool, so adding
  // them cannot shift the seeded abstract/session/task distribution.
  assert.doesNotMatch(seedSource, /speakerUsers\.push\(\.\.\.fixtureUsers/);
  assert.match(seedSource, /\[\.\.\.speakerUsers, \.\.\.fixtureUsers\.filter\(\(f\) => f\.role === "SPEAKER"\)\]/);
});

test("the plaintext demo passwords live in the seed file and nowhere else", () => {
  const secrets = [DEMO_PERSONA_PASSWORD, ...DEMO_FIXTURE_IDENTITIES.map((identity) => identity.password)];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(repoRoot, dir))) {
      if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
      const relative = path.join(dir, entry);
      const absolute = path.join(repoRoot, relative);
      if (statSync(absolute).isDirectory()) {
        walk(relative);
        continue;
      }
      if (!/\.(ts|tsx|mjs|js|json|md|css|prisma)$/.test(entry)) continue;
      const key = relative.split(path.sep).join("/");
      if (key === "lib/demo/seed.ts") continue;
      const contents = readFileSync(absolute, "utf8");
      if (secrets.some((secret) => contents.includes(secret))) offenders.push(key);
    }
  };
  for (const dir of ["app", "lib", "components", "types", "scripts", "prisma", "docs"]) walk(dir);
  assert.deepEqual(offenders, [], "demo passwords must exist only as seed constants");
  // And the seed never prints one.
  assert.doesNotMatch(seedSource, /console\.(log|info|warn|error)/);
});
