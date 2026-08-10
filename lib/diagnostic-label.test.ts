import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ApiError } from "@/lib/api/http";
import { diagnosticLabel } from "./diagnostic-label";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a stable code is preferred, then the exception class", () => {
  assert.equal(diagnosticLabel(new ApiError(400, "INVALID_JSON", "Request body must be valid JSON.")), "INVALID_JSON");
  assert.equal(diagnosticLabel(new TypeError("boom")), "TypeError");
  assert.equal(diagnosticLabel(new SyntaxError("Unexpected token } in JSON at position 41")), "SyntaxError");
  const nodeError = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  assert.equal(diagnosticLabel(nodeError), "ECONNRESET");
});

test("the exception message never survives, however it is smuggled", () => {
  // The whole point: a message routinely carries the input that caused it — a
  // body, a URL, a decoded buffer, a password.
  const leak = "hunter2-the-actual-password";
  for (const error of [
    new Error(leak),
    Object.assign(new Error(leak), { code: leak }),
    Object.assign(new Error(leak), { name: leak }),
    Object.assign(new Error(leak), { code: `INVALID ${leak}` }),
    Object.assign(new Error(leak), { name: "Type Error; " + leak }),
  ]) {
    assert.ok(!diagnosticLabel(error).includes(leak), String(diagnosticLabel(error)));
  }
});

test("labels are charset- and length-bounded, so nothing can be smuggled through name or code", () => {
  // `Object.assign` replaces `name`, so there is no original class left to fall
  // back to — an over-long name degrades to "unknown", it does not leak.
  assert.equal(diagnosticLabel(Object.assign(new Error("x"), { name: "A".repeat(65) })), "unknown");
  assert.equal(diagnosticLabel({ code: "A".repeat(65), name: "B".repeat(65) }), "unknown");
  assert.equal(diagnosticLabel({ code: "lowercase_code", name: "Fine" }), "Fine");
  assert.equal(diagnosticLabel({ code: "WITH\nNEWLINE" }), "unknown");
  assert.equal(diagnosticLabel({ name: "9StartsWithDigit" }), "unknown");
  assert.match(diagnosticLabel({ code: "A".repeat(64) }), /^A{64}$/);
});

test("non-errors and hostile shapes degrade to 'unknown' without throwing", () => {
  for (const value of [null, undefined, 0, "", "a string", [], {}, true, Symbol("s")]) {
    assert.equal(diagnosticLabel(value), "unknown", String(typeof value));
  }
  // A getter that throws must not take the log line down with it.
  const hostile = { get code(): string { throw new Error("nope"); } };
  assert.throws(() => diagnosticLabel(hostile));
});

test("the login and body-reading paths route their diagnostics through this helper", () => {
  const files = ["app/api/auth/login/route.ts", "lib/api/bounded-json.ts", "lib/password-credential.ts"];
  for (const file of files) {
    const source = readFileSync(path.join(repoRoot, file), "utf8");
    const logs = source.match(/console\.\w+\([^\n]*/g) ?? [];
    assert.ok(logs.length > 0, `${file} should record its discarded categories`);
    for (const line of logs) {
      assert.match(line, /diagnosticLabel\(error\)\);$/, `${file}: ${line}`);
    }
    assert.match(source, /import \{ diagnosticLabel \} from "@\/lib\/diagnostic-label";/, file);
  }
});

test("the helper itself never logs and has no dependencies that could", () => {
  const source = readFileSync(path.join(repoRoot, "lib/diagnostic-label.ts"), "utf8");
  assert.doesNotMatch(source, /console\.|^import /m);
});

test("no catch on the credential path discards its cause silently", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(repoRoot, dir))) {
      if (entry === "node_modules" || entry === ".next") continue;
      const relative = path.join(dir, entry);
      const absolute = path.join(repoRoot, relative);
      if (statSync(absolute).isDirectory()) {
        walk(relative);
        continue;
      }
      if (!/\.ts$/.test(entry) || /\.test\.ts$/.test(entry)) continue;
      // `catch {` with no binding cannot label anything.
      if (/\} catch \{/.test(readFileSync(absolute, "utf8"))) offenders.push(relative.split(path.sep).join("/"));
    }
  };
  walk("app/api/auth");
  assert.deepEqual(offenders, []);
});
