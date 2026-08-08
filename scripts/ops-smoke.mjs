/**
 * Ops production smoke test.
 *
 * Boots the built Next server (`next start`) twice — once with the demo-reset
 * gate closed, once open — and asserts the public routes render without a
 * session and that INV-RESET-001 holds on the reset endpoint.
 *
 * Ports: ops owns the 323x range. Only the PID tree we spawn is ever killed
 * (never `taskkill /IM node.exe` — see the 04:18 incident rule in STATE.md).
 *
 * Usage: node scripts/ops-smoke.mjs
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT_CLOSED = Number(process.env.OPS_SMOKE_PORT ?? 3230);
const PORT_OPEN = PORT_CLOSED + 1;

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Mirrors lib/auth.ts encodeSession (base64url JSON). */
function cookieFor(role) {
  const personas = {
    ADMIN: { id: "demo-admin", name: "Maya Chen", email: "maya@greenroom.demo" },
    SPEAKER: { id: "demo-speaker", name: "Sofia Marques", email: "sofia@greenroom.demo" },
  };
  const session = {
    user: personas[role],
    event: { id: "demo-event", name: "Forward 2026", slug: "forward-2026" },
    role,
  };
  return `sb_session=${Buffer.from(JSON.stringify(session), "utf8").toString("base64url")}`;
}

async function waitForServer(port, proc) {
  for (let i = 0; i < 90; i++) {
    if (proc.exitCode !== null) throw new Error(`server exited early (code ${proc.exitCode})`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/login`);
      if (res.status > 0) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`server on :${port} never became ready`);
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === "win32") {
    // Kill ONLY this PID and its children.
    spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
  }
}

async function withServer(port, extraEnv, fn) {
  const proc = spawn("npx", ["next", "start", "-p", String(port)], {
    env: { ...process.env, ...extraEnv },
    stdio: "ignore",
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
  });
  try {
    await waitForServer(port, proc);
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    killTree(proc);
    await sleep(600);
  }
}

async function json(res) {
  try { return await res.json(); } catch { return null; }
}

// --- Run A: reset gate CLOSED (ALLOW_DEMO_RESET unset) ----------------------
await withServer(PORT_CLOSED, { ALLOW_DEMO_RESET: "" }, async (base) => {
  const login = await fetch(`${base}/login`);
  check("/login renders with no session", login.status === 200, `status ${login.status}`);

  const embed = await fetch(`${base}/embed/schedule`);
  check("/embed/schedule public (null session)", embed.status === 200, `status ${embed.status}`);

  const noAuth = await fetch(`${base}/api/admin/reset`, { method: "POST" });
  const noAuthBody = await json(noAuth);
  check(
    "reset refused when gate closed (anonymous)",
    noAuth.status === 403 && noAuthBody?.error?.code === "RESET_DISABLED",
    `status ${noAuth.status} code ${noAuthBody?.error?.code}`,
  );

  const asAdmin = await fetch(`${base}/api/admin/reset`, { method: "POST", headers: { cookie: cookieFor("ADMIN") } });
  const asAdminBody = await json(asAdmin);
  check(
    "reset refused when gate closed (even as ADMIN)",
    asAdmin.status === 403 && asAdminBody?.error?.code === "RESET_DISABLED",
    `status ${asAdmin.status} code ${asAdminBody?.error?.code}`,
  );

  const viaGet = await fetch(`${base}/api/admin/reset`);
  check("reset rejects GET (POST-only)", viaGet.status === 405, `status ${viaGet.status}`);
});

// --- Run B: reset gate OPEN (ALLOW_DEMO_RESET=true) -------------------------
await withServer(PORT_OPEN, { ALLOW_DEMO_RESET: "true" }, async (base) => {
  const anon = await fetch(`${base}/api/admin/reset`, { method: "POST" });
  const anonBody = await json(anon);
  check(
    "reset requires a session when gate open",
    anon.status === 403 && anonBody?.error?.code === "FORBIDDEN",
    `status ${anon.status} code ${anonBody?.error?.code}`,
  );

  const speaker = await fetch(`${base}/api/admin/reset`, { method: "POST", headers: { cookie: cookieFor("SPEAKER") } });
  const speakerBody = await json(speaker);
  check(
    "reset refuses non-admin (SPEAKER) when gate open",
    speaker.status === 403 && speakerBody?.error?.code === "FORBIDDEN",
    `status ${speaker.status} code ${speakerBody?.error?.code}`,
  );

  const admin = await fetch(`${base}/api/admin/reset`, { method: "POST", headers: { cookie: cookieFor("ADMIN") } });
  const adminBody = await json(admin);
  check(
    "reset succeeds for ADMIN when gate open",
    admin.status === 200 && adminBody?.ok === true && adminBody?.data?.abstracts === 40,
    `status ${admin.status} abstracts ${adminBody?.data?.abstracts}`,
  );

  // Idempotency: a second reset yields identical counts.
  const again = await fetch(`${base}/api/admin/reset`, { method: "POST", headers: { cookie: cookieFor("ADMIN") } });
  const againBody = await json(again);
  check(
    "reset is idempotent (identical summary on re-run)",
    again.status === 200 && JSON.stringify(againBody?.data) === JSON.stringify(adminBody?.data),
    `status ${again.status}`,
  );
});

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length === 0 ? 0 : 1);
