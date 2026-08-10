import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

const route = read("app/api/auth/login/route.ts");
const page = read("app/login/page.tsx");
const personaAction = read("app/login/actions.ts");

test("the throttle is charged before any User row is read", () => {
  const throttle = route.indexOf("await enforceLoginRateLimit(");
  const lookup = route.indexOf("await resolveCredentialSession(");
  assert.ok(throttle > 0, "the route must enforce the login throttle");
  assert.ok(lookup > 0, "the route must resolve credentials through the shared policy");
  assert.ok(throttle < lookup, "throttling after the lookup would make it an account oracle");

  // The only `User` query in the file lives in `findCredentialUser`, and that
  // helper is referenced exactly once — as the `findUser` the resolver is
  // handed. The resolver runs after the throttle has already committed, so
  // textual declaration order is not what orders the query.
  assert.equal(route.split("prisma.user.").length - 1, 1);
  assert.match(route, /async function findCredentialUser\(email: string\) \{\s*return prisma\.user\.findUnique\(/);
  assert.deepEqual(route.match(/findCredentialUser/g), ["findCredentialUser", "findCredentialUser"]);
  assert.match(route, /findUser: findCredentialUser,/);
});

test("there is exactly one refusal, and it names neither the address nor the reason", () => {
  assert.equal(route.split("INVALID_CREDENTIALS_MESSAGE =").length - 1, 1);
  assert.match(route, /const INVALID_CREDENTIALS_MESSAGE = "Email or password is incorrect\.";/);
  // One 401 construction site, one form-mode refusal target.
  assert.equal(route.split("status: 401").length - 1, 1);
  assert.equal(route.split("/login?error=invalid").length - 1, 1);
  for (const leak of [/USER_NOT_FOUND/, /NO_PASSWORD/, /WRONG_PASSWORD/, /NOT_PROVISIONED/, /NO_MEMBERSHIP/]) {
    assert.doesNotMatch(route, leak);
  }
});

test("nothing on the credential path logs a body, an address, or a secret", () => {
  const logs = route.match(/console\.\w+\([^\n]*/g) ?? [];
  assert.ok(logs.length > 0, "the unavailable paths should still leave a server-side diagnostic");
  for (const line of logs) {
    for (const forbidden of ["password", "attempt.email", "email:", "body", "text", "params"]) {
      assert.ok(!line.includes(forbidden), `console call must not carry ${forbidden}: ${line}`);
    }
    assert.match(line, /errorType/);
  }
});

test("session and cookie mechanics are imported, never reimplemented", () => {
  const authImport = route.match(/import \{([^}]*)\} from "@\/lib\/auth";/);
  assert.ok(authImport, "the route must import its session helpers from lib/auth");
  for (const symbol of ["SESSION_COOKIE", "SESSION_TTL_SECONDS", "encodeSession", "homeForRole"]) {
    assert.ok(authImport[1].includes(symbol), `login must reuse ${symbol} from lib/auth`);
  }
  // No parallel signing, no hand-rolled cookie serialization.
  assert.doesNotMatch(route, /createHmac|Set-Cookie|base64url/);
  // The cookie options match the persona action's exactly, so both modes issue
  // the same session.
  for (const option of ["httpOnly: true", 'sameSite: "lax"', 'path: "/"', 'secure: process.env.NODE_ENV === "production"']) {
    assert.ok(route.includes(option), `login cookie must set ${option}`);
    assert.ok(personaAction.includes(option), `persona cookie must set ${option}`);
  }
  // The role always comes from the server-side membership, never the request.
  assert.match(route, /homeForRole\(session\.role\)/);
  assert.doesNotMatch(route, /body\.role|params\.get\("role"\)|attempt\.role/);
});

test("scrypt needs the node runtime and a non-cached response", () => {
  assert.match(route, /export const runtime = "nodejs";/);
  assert.match(route, /export const dynamic = "force-dynamic";/);
  assert.match(route, /response\.headers\.set\("Cache-Control", "no-store"\)/);
  // Every response goes through noStore, including the refusals.
  const returns = route.match(/return (?!noStore|refuse|establish|loginRedirect|\{|prisma|NextResponse\.redirect\(new URL)[^\n;]*Response[^\n;]*/g) ?? [];
  assert.deepEqual(returns, []);
});

test("the body is bounded and a parse failure is not its own observable outcome", () => {
  assert.match(route, /LOGIN_BODY_MAX_BYTES = 4 \* 1024/);
  assert.match(route, /parseBoundedText\(req, LOGIN_BODY_MAX_BYTES/);
  // readAttempt swallows every parse error into empty fields.
  assert.match(route, /catch \{\s*return \{ email: "", password: "" \};\s*\}/);
});

test("the login page renders a labelled credential form beside the unchanged personas", () => {
  assert.match(page, /method="post"\s+action="\/api\/auth\/login"/);
  assert.match(page, /<label htmlFor="login-email">/);
  assert.match(page, /<label htmlFor="login-password">/);
  assert.match(page, /id="login-email"/);
  assert.match(page, /id="login-password"/);
  assert.match(page, /autoComplete="username"/);
  assert.match(page, /autoComplete="current-password"/);
  assert.match(page, /type="password"/);
  assert.match(page, /role="alert"/);
  // The one-click personas are still there and still one click.
  assert.match(page, /action=\{loginAsPersona\}/);
  assert.match(page, /one-click/i);
  assert.match(page, /No password required\./);
  // Honest scope copy: provisioned only, no sign-up, no reset.
  assert.match(page, /Organizers provision accounts\./);
  assert.match(page, /no self-service sign-up/i);
  assert.match(page, /password reset is\s*\n?\s*not available yet/i);
});

test("no self-registration or password-reset surface was added", () => {
  const authRoutes: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(repoRoot, dir))) {
      const relative = path.join(dir, entry);
      if (statSync(path.join(repoRoot, relative)).isDirectory()) walk(relative);
      else authRoutes.push(relative.split(path.sep).join("/"));
    }
  };
  walk("app/api/auth");
  assert.deepEqual(authRoutes.sort(), [
    "app/api/auth/login/route.ts",
    "app/api/auth/reviewer-invites/accept/route.ts",
  ]);
  for (const forbidden of [/register/i, /signup/i, /sign-up/i, /forgot/i, /password-reset/i, /resetPassword/i]) {
    assert.doesNotMatch(route, forbidden);
  }
});

test("passwordHash is confined to the credential path and never projected", () => {
  const allowed = new Set([
    "app/api/auth/login/route.ts",
    "lib/password-credential.ts",
    "lib/services/credential-login.ts",
    "lib/demo/seed.ts",
  ]);
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
      if (!/\.(ts|tsx)$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      const key = relative.split(path.sep).join("/");
      if (allowed.has(key)) continue;
      if (readFileSync(absolute, "utf8").includes("passwordHash")) offenders.push(key);
    }
  };
  for (const dir of ["app", "lib", "components", "types"]) walk(dir);
  assert.deepEqual(offenders, [], "passwordHash must not appear outside the credential path");

  // The routes that fetch a whole User row hand it to serializers that project
  // an explicit field list, so a new column cannot ride out with them.
  const abstractSerializer = read("lib/api/abstract-serialize.ts");
  assert.match(abstractSerializer, /speakers: \(abstract\.speakers \?\? \[\]\)\.map\(\(s\) => \(\{\s*userId: s\.userId,\s*email: s\.user\.email,\s*name: s\.user\.name,\s*isPrimary: s\.isPrimary,\s*\}\)\)/);
  for (const serializer of ["lib/api/abstract-serialize.ts", "lib/api/v1-serialize.ts", "lib/api/form-serialize.ts", "lib/api/speaker-submission.ts"]) {
    assert.doesNotMatch(read(serializer), /\.\.\.\w*[uU]ser\b/, `${serializer} must not spread a User row`);
  }
});
