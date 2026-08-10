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

test("a session is issued only for a positively confirmed same-origin post", () => {
  const gate = route.indexOf("if (!isSameOriginRequest(originVerdict(req))) return refuseCrossOrigin(req, formEncoded);");
  assert.ok(gate > 0, "the route must gate on the request's origin");
  // Before the body is read, before the throttle, before any identity: a post
  // that cannot prove it came from this site reaches none of them.
  for (const later of ["await readAttempt(", "await enforceLoginRateLimit(", "await resolveCredentialSession("]) {
    assert.ok(gate < route.indexOf(later), `the origin gate must precede ${later}`);
  }
  // Both modes. `formEncoded` only selects the refusal's shape, never whether
  // the gate applies — a text/plain form can be crafted into a valid JSON body,
  // so gating the form mode alone would leave a preflight-free bypass.
  assert.doesNotMatch(route, /if \(formEncoded\)[^\n]*isSameOriginRequest/);
  assert.equal(route.split("isSameOriginRequest(").length - 1, 1);

  // The verdict is derived from headers a page cannot forge, plus the
  // configured APP_URL.
  for (const signal of ['get("origin")', 'get("referer")', 'get("host")', 'get("x-forwarded-host")', 'get("x-forwarded-proto")']) {
    assert.ok(route.includes(signal), `the expected origin must consider ${signal}`);
  }
  // Policy is owned by the pure module, not re-implemented here.
  assert.doesNotMatch(route, /=== *"same-origin"|verdict *===/);
});

test("the cross-origin refusal is a distinct 403 that leaks nothing about any account", () => {
  assert.match(route, /const CROSS_ORIGIN_CODE = "CROSS_ORIGIN_REFUSED";/);
  assert.equal(route.split("status: 403").length - 1, 1);
  // It is decided before any identity is considered, so a distinct code cannot
  // become an account oracle — and it names the fix instead of blaming the
  // password.
  assert.match(route, /Send an Origin header matching this deployment\./);
  assert.doesNotMatch(route, /CROSS_ORIGIN_MESSAGE[\s\S]{0,120}(password|email) is incorrect/);
  // The form mode gets its own error key, kept separate from the credential one.
  assert.equal(route.split("/login?error=blocked").length - 1, 1);
  assert.match(page, /error === "blocked"/);
  assert.match(page, /did not come from this site/);
  // No session is issued on that path.
  const refusal = route.slice(route.indexOf("function refuseCrossOrigin"), route.indexOf("function refuseThrottled"));
  assert.doesNotMatch(refusal, /cookies\.set|encodeSession/);
});

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

test("every discarded failure leaves a bounded label, and no body, address, or secret", () => {
  const logs = route.match(/console\.\w+\([^\n]*/g) ?? [];
  // Greptile #76 issue 2: a swallowed category must still be recorded. The
  // parse catch used to discard the class entirely.
  assert.equal(logs.length, 3, "body-rejected, throttle-unavailable and attempt-failed each need a diagnostic");
  assert.ok(logs.some((line) => line.includes("[login] request body rejected")));
  for (const line of logs) {
    for (const forbidden of ["password", "attempt.email", "email:", "body,", "text", "params", ".message"]) {
      assert.ok(!line.includes(forbidden), `console call must not carry ${forbidden}: ${line}`);
    }
    // Fixed label + exception class only, via the shared bounded helper.
    assert.match(line, /^console\.(warn|error)\("\[login\] [a-z ]+", diagnosticLabel\(error\)\);$/);
  }
  // No catch on this path discards its cause silently any more.
  assert.doesNotMatch(route, /\} catch \{/);
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
  // readAttempt turns every parse error into empty fields — the outcome is
  // unchanged, but the category is now labelled rather than discarded.
  assert.match(route, /catch \(error\) \{[\s\S]{0,400}?return \{ email: "", password: "" \};\s*\}/);
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
  // Route-shaped names, not bare words: the point is that no such surface
  // exists, and a prose comment that happens to contain "forgot" is not one.
  for (const forbidden of [/register/i, /signup/i, /sign-up/i, /forgot[-_ ]?password/i, /password[-_]reset/i, /resetPassword/i]) {
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
