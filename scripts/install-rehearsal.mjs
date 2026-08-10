/**
 * Clean-install rehearsal harness (plan item A5).
 *
 * Drives the seven golden-path steps plus three guardrails against a freshly
 * installed, freshly seeded instance, exactly as the README Quickstart leaves
 * it. Evidence and timings: `docs/judging/INSTALL-REHEARSAL.md`.
 *
 * Sessions are minted with the development fallback secret from `lib/auth.ts` —
 * the same value `npm run dev` uses for the one-click `/login` personas, and one
 * that fails closed in production (`getSessionSecret()`).
 *
 * ⚠️ THIS SCRIPT WRITES: it submits an abstract, accepts it, converts it to a
 * session, schedules it, and completes an onboarding task in `demo-event`. Point
 * it ONLY at a disposable database. It refuses to run without an explicit opt-in
 * and refuses any non-loopback target, so it can never touch production.
 *
 * Usage:
 *   INSTALL_REHEARSAL_ALLOW_WRITES=1 \
 *   INSTALL_REHEARSAL_EXPECTED_DB=<distinctive substring of the DISPOSABLE DATABASE_URL host> \
 *   node --env-file=.env scripts/install-rehearsal.mjs [baseUrl]
 */
import { createHmac } from "node:crypto";

const BASE = (process.argv[2] ?? "http://127.0.0.1:3000").replace(/\/$/, "");
// Sign with the same secret the target server resolves. This mirrors
// `getSessionSecret()` in `lib/auth.ts` exactly: a configured secret only
// counts when trimmed and >= 32 chars, otherwise a dev server falls back to
// the development secret — so the harness must apply the same rule or a short
// configured value would make it sign differently from the server. Run this
// script with the same `--env-file` as the server.
const configuredSecret = process.env.SESSION_SECRET?.trim();
const SECRET =
  configuredSecret && configuredSecret.length >= 32
    ? configuredSecret
    : "greenroom-development-session-secret-not-for-production";
const EVENT = { id: "demo-event", name: "Forward 2026", slug: "forward-2026" };

if (process.env.INSTALL_REHEARSAL_ALLOW_WRITES !== "1") {
  console.error(
    "install-rehearsal writes demo-event data (submit, accept, convert, schedule,\n" +
      "task completion) and is blocked by default.\n" +
      "Run it only against a DISPOSABLE database — never the shared demo DB — then set\n" +
      "  INSTALL_REHEARSAL_ALLOW_WRITES=1\n" +
      "and re-run.",
  );
  process.exit(2);
}

const host = new URL(BASE).hostname;
if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) {
  console.error(`Refusing to run against '${host}': this harness is loopback-only, so it cannot reach a deployed environment.`);
  process.exit(2);
}

// Loopback proves the SERVER is local, not that its DATABASE is disposable — a
// local dev server pointed at the shared demo DB would still be mutated. The
// operator must assert which database they expect: a distinctive substring of
// the disposable DATABASE_URL (e.g. its Neon host), checked against the env
// this script was launched with (use the same --env-file as the server).
const expectedDb = process.env.INSTALL_REHEARSAL_EXPECTED_DB;
const actualDb = process.env.DATABASE_URL ?? "";
if (!expectedDb) {
  console.error(
    "Set INSTALL_REHEARSAL_EXPECTED_DB to a distinctive substring of the DISPOSABLE\n" +
      "database's host (e.g. 'ep-nameless-flower') and run with the same --env-file\n" +
      "as the server. This asserts the rehearsal cannot hit a shared database.",
  );
  process.exit(2);
}
if (!actualDb.includes(expectedDb)) {
  console.error(
    `DATABASE_URL in this environment does not contain '${expectedDb}'.\n` +
      "Refusing to run: the server may be backed by a database you did not intend to mutate.",
  );
  process.exit(2);
}

// The check above only proves what THIS process is pointed at; the server is
// configured independently. Prove they share one database before any
// server-mediated write: create a sentinel row directly in the asserted
// disposable DB, read it back THROUGH the server, then remove it. If the
// server cannot see the sentinel, it is backed by some other database — abort
// with zero writes issued through it.
async function assertServerUsesAssertedDatabase() {
  const { createRequire } = await import("node:module");
  const { PrismaClient } = createRequire(import.meta.url)("@prisma/client");
  const prisma = new PrismaClient();
  const sentinelSlug = `rehearsal-sentinel-${Date.now()}`;
  // `process.exit` would skip async cleanup, so record the outcome and exit
  // only after the sentinel row is removed and the client disconnected.
  let mismatch = null;
  try {
    await prisma.formConfig.create({
      data: { eventId: EVENT.id, name: "Rehearsal sentinel", slug: sentinelSlug, published: true },
    });
    const probe = await fetch(`${BASE}/api/cfp/public/${sentinelSlug}`);
    if (probe.status !== 200) mismatch = probe.status;
  } finally {
    await prisma.formConfig.deleteMany({ where: { eventId: EVENT.id, slug: sentinelSlug } });
    await prisma.$disconnect();
  }
  if (mismatch !== null) {
    console.error(
      `Sentinel probe failed (HTTP ${mismatch}): the server at ${BASE} is NOT backed by\n` +
        "the database this harness verified. Refusing to run — no writes were sent through the server\n" +
        "and the sentinel row was removed.",
    );
    process.exit(2);
  }
  console.log("PASS  sentinel: server and harness share the asserted disposable database");
}
await assertServerUsesAssertedDatabase();

function cookie(user, role) {
  const iat = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ user, event: EVENT, role, iat, exp: iat + 604800 }), "utf8").toString("base64url");
  return `sb_session=${payload}.${createHmac("sha256", SECRET).update(payload).digest("base64url")}`;
}
const admin = cookie({ id: "demo-admin", name: "Maya Chen", email: "maya@greenroom-hq.com" }, "ADMIN");
const evaluator = cookie({ id: "demo-evaluator", name: "Ravi Patel", email: "ravi@greenroom-hq.com" }, "EVALUATOR");
const speaker = cookie({ id: "demo-speaker", name: "Sofia Marques", email: "sofia@greenroom-hq.com" }, "SPEAKER");

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
async function req(method, path, body, cookieValue) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookieValue ? { cookie: cookieValue } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, text, data };
}

const STAMP = Date.now();
const TITLE = `A5 rehearsal talk ${STAMP}`;
// A fresh speaker per run: the seeded form caps submissions per speaker (3).
const SPEAKER_EMAIL = `a5.rehearsal.${STAMP}@example.test`;

try {
  // Step 1 — a published CFP form is publicly reachable at its seeded slug.
  const forms = await req("GET", "/api/cfp/forms?eventId=demo-event", null, admin);
  const form = (forms.data?.data ?? []).find((f) => f.slug === "call-for-speakers");
  check("1. seeded CFP form is published", !!form && form.published === true);
  const publicCfp = await req("GET", "/cfp/call-for-speakers", null, null);
  check("1. public CFP renders logged out", publicCfp.status === 200 && !publicCfp.text.includes("Submissions are closed"), `status ${publicCfp.status}`);

  const cats = await req("GET", "/api/cfp/categories?eventId=demo-event", null, admin);
  const categoryId = (cats.data?.data ?? [])[0]?.id;
  check("1. categories available as track options", !!categoryId);

  // Step 2 — an anonymous speaker submits an abstract.
  const answers = {};
  for (const field of form?.fields ?? []) {
    if (!field.required) continue;
    if (field.type === "SELECT" || field.type === "RADIO") answers[field.key] = field.options?.[0]?.value ?? "";
    else if (field.type === "MULTISELECT" || field.type === "CHECKBOX") answers[field.key] = [field.options?.[0]?.value ?? ""];
    else if (field.type === "NUMBER") answers[field.key] = 1;
    else answers[field.key] = "Rehearsal answer with enough substance to pass validation.";
  }
  const submit = await req("POST", "/api/cfp/submissions", {
    formConfigId: form?.id,
    title: TITLE,
    abstract: "A disposable abstract submitted during the A5 clean-install rehearsal.",
    format: "Talk",
    durationMinutes: 30,
    categoryId,
    speakers: [{ email: SPEAKER_EMAIL, name: "A5 Rehearsal Speaker", isPrimary: true }],
    answers,
    intent: "submit",
  }, null);
  check("2. anonymous CFP submit → 200/201", submit.status === 200 || submit.status === 201, `${submit.status} ${JSON.stringify(submit.data?.error ?? "")}`);
  const abstractId = submit.data?.data?.id;
  check("2. abstract is SUBMITTED", submit.data?.data?.status === "SUBMITTED");

  // Step 3 — evaluator scores an assigned abstract through the plan rubric.
  const queue = await req("GET", "/admin/evaluations", null, evaluator);
  check("3. evaluator queue renders", queue.status === 200, `status ${queue.status}`);
  const plansForQueue = await req("GET", "/api/evaluations/plans", null, admin);
  const plan = (plansForQueue.data?.data ?? [])[0];
  const assignments = await req("GET", `/api/evaluations/assignments?planId=${plan?.id}`, null, evaluator);
  const assignment = (assignments.data?.data ?? [])[0];
  const rubricKey = (plan?.rubric ?? [])[0]?.key;
  if (assignment && rubricKey) {
    const score = await req("POST", "/api/evaluations/scores", {
      planId: plan.id,
      abstractId: assignment.abstractId,
      scores: [{ rubricKey, score: 4, comment: "A5 rehearsal score." }],
      complete: false,
    }, evaluator);
    check("3. evaluator scores an assigned abstract", score.status === 200 || score.status === 201, `${score.status} ${JSON.stringify(score.data?.error ?? "")}`);
  } else {
    check("3. evaluator scores an assigned abstract", false, `plan=${!!plan} rubricKey=${rubricKey} assignment=${!!assignment}`);
  }

  // Step 4 — admin accepts and converts to a Session.
  const decide = await req("POST", "/api/evaluations/decisions", { abstractId, decision: "ACCEPTED" }, admin);
  check("4. admin accept → 200", decide.status === 200, `${decide.status} ${JSON.stringify(decide.data?.error ?? "")}`);
  const convert = await req("POST", "/api/evaluations/convert", { abstractId, durationMinutes: 30 }, admin);
  check("4. convert to session → 201", convert.status === 201, `${convert.status} ${JSON.stringify(convert.data?.error ?? "")}`);
  const sessionId = convert.data?.data?.sessionId;

  // Step 5 — speaker portal: task check-off persists.
  const portal = await req("GET", "/portal", null, speaker);
  check("5. speaker portal renders", portal.status === 200 && portal.text.includes("Your tasks"), `status ${portal.status}`);
  // There is no GET /api/portal/tasks by design; the portal server-renders them.
  const taskId = (portal.text.split("\\").join("").match(/"taskId":"([A-Za-z0-9_-]+)"/) ?? [])[1];
  const done = await req("PATCH", "/api/portal/tasks", { taskId, status: "COMPLETED" }, speaker);
  check("5. task check-off persists", done.status === 200 && done.data?.data?.status === "COMPLETED", `${done.status} ${JSON.stringify(done.data?.error ?? "")}`);

  // Step 6 — schedule it; a conflicting placement must be refused by the server.
  const agenda = await req("GET", "/api/agenda?eventId=demo-event", null, admin);
  const agendaData = agenda.data?.data ?? {};
  const rooms = agendaData.rooms ?? [];
  const occupied = (agendaData.sessions ?? []).map((s) => s.slot).filter(Boolean)[0];
  const conflict = await req("POST", "/api/agenda/slots", {
    eventId: "demo-event", sessionId, roomId: occupied?.roomId,
    startsAt: occupied?.startsAt, endsAt: occupied?.endsAt,
  }, admin);
  check("6. conflicting placement refused → 409", conflict.status === 409, `got ${conflict.status} ${conflict.data?.error?.code ?? ""}`);
  // Pick a genuinely free window: one hour after the last placement of the day.
  const allSlots = (agendaData.sessions ?? []).map((s) => s.slot).filter(Boolean);
  const latestEnd = allSlots.reduce((max, slot) => Math.max(max, new Date(slot.endsAt).getTime()), 0);
  const freeStart = new Date(latestEnd + 3600_000).toISOString();
  const freeEnd = new Date(new Date(freeStart).getTime() + 30 * 60_000).toISOString();
  const place = await req("POST", "/api/agenda/slots", {
    eventId: "demo-event", sessionId, roomId: rooms[rooms.length - 1]?.id, startsAt: freeStart, endsAt: freeEnd,
  }, admin);
  check("6. clean placement accepted", place.status === 200 || place.status === 201, `${place.status} ${JSON.stringify(place.data?.error ?? "")}`);

  // Step 7 — public embed + .ics export, both logged out.
  const embed = await req("GET", "/embed/schedule?event=demo-event", null, null);
  check("7. public embed shows the new talk logged out", embed.status === 200 && embed.text.includes(TITLE), `status ${embed.status}`);
  const ics = await req("GET", "/api/comms/calendar?eventId=demo-event", null, null);
  check("7. public .ics export → 200", ics.status === 200, `status ${ics.status}`);
  check("7. .ics contains the new talk", ics.text.includes(`SUMMARY:${TITLE}`.slice(0, 40)) || ics.text.includes(TITLE.slice(0, 30)));
  const speakersEmbed = await req("GET", "/embed/speakers?event=demo-event", null, null);
  check("7. public speakers embed → 200", speakersEmbed.status === 200, `status ${speakersEmbed.status}`);

  // Guardrails that must hold on a fresh install.
  const reset = await req("POST", "/api/admin/reset", {}, admin);
  check("guard: demo reset refused without ALLOW_DEMO_RESET", reset.status === 403 && reset.data?.error?.code === "RESET_DISABLED", `${reset.status} ${reset.data?.error?.code}`);
  const v1 = await req("GET", "/api/v1/schedule?event=forward-2026", null, null);
  check("guard: v1 API returns 503 without GREENROOM_API_KEY", v1.status === 503, `got ${v1.status}`);
  const adminAsSpeaker = await req("GET", "/admin/agenda", null, speaker);
  check("guard: speaker blocked from /admin/agenda", adminAsSpeaker.status === 307, `got ${adminAsSpeaker.status}`);
} catch (error) {
  check("rehearsal completed", false, String(error));
} finally {
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} golden-path checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}
