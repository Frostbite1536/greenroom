/**
 * Frontend smoke test — golden-path screens against a real DB.
 *
 * Scoped entirely to the `scratch-frontend` event per the DB concurrency rule in
 * coordination STATE.md: `demo-event` is READ-ONLY for workers. This script
 * wipes and rebuilds only its own scratch event, then drives the pages and the
 * four mutations the frontend owns.
 *
 * Run: node --env-file=.env scripts/_frontend-smoke.mjs
 * Port: 3222 (frontend range 322x). Kills only the PID it spawns.
 */
import { spawn, spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const EVENT_ID = "scratch-frontend";
const PORT = process.env.SMOKE_PORT || "3222";
const BASE = `http://127.0.0.1:${PORT}`;

// Refuse to run against a server we did not start: a stale listener would
// silently serve these checks and report a misleading pass.
const probe = await fetch(`http://127.0.0.1:${PORT}/login`).then(() => true).catch(() => false);
if (probe) {
  console.error(`[smoke] port ${PORT} is already serving. Find and kill that PID first:\n` +
    `  netstat -ano | findstr :${PORT}\n  taskkill /F /PID <pid>`);
  process.exit(1);
}

const enc = (s) => Buffer.from(JSON.stringify(s), "utf8").toString("base64url");
const ev = { id: EVENT_ID, name: "Scratch Frontend", slug: EVENT_ID };
const admin = { user: { id: "x", name: "Maya Chen", email: "maya@sessionboard.demo" }, event: ev, role: "ADMIN" };
const evaluator = { user: { id: "x", name: "Ravi Patel", email: "ravi@sessionboard.demo" }, event: ev, role: "EVALUATOR" };
const cookie = (s) => `sb_session=${enc(s)}`;

async function req(method, path, body, sess) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(sess ? { cookie: cookie(sess) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text };
}

// ---- scratch fixture -------------------------------------------------------

async function resetScratch() {
  // Delete children first; the event cascade covers most, but be explicit.
  await prisma.event.deleteMany({ where: { id: EVENT_ID } });

  const now = Date.now();
  const event = await prisma.event.create({
    data: {
      id: EVENT_ID,
      name: "Scratch Frontend",
      slug: EVENT_ID,
      timezone: "America/Los_Angeles",
      startsAt: new Date(now + 30 * 86400000),
      endsAt: new Date(now + 32 * 86400000),
    },
  });

  const users = {};
  for (const [key, [email, name]] of Object.entries({
    admin: ["maya@sessionboard.demo", "Maya Chen"],
    evaluator: ["ravi@sessionboard.demo", "Ravi Patel"],
    speaker: ["sofia@sessionboard.demo", "Sofia Marques"],
  })) {
    const u = await prisma.user.upsert({ where: { email }, update: { name }, create: { email, name } });
    users[key] = u.id;
    await prisma.eventMember.upsert({
      where: { eventId_userId: { eventId: EVENT_ID, userId: u.id } },
      update: { role: key === "admin" ? "ADMIN" : key === "evaluator" ? "EVALUATOR" : "SPEAKER" },
      create: { eventId: EVENT_ID, userId: u.id, role: key === "admin" ? "ADMIN" : key === "evaluator" ? "EVALUATOR" : "SPEAKER" },
    });
  }

  const category = await prisma.category.create({
    data: { eventId: EVENT_ID, name: "Applied AI", defaultTeamKey: "team-ai", sortOrder: 0 },
  });
  const track = await prisma.track.create({ data: { eventId: EVENT_ID, name: "Mainstage", color: "#167565", sortOrder: 0 } });
  const roomA = await prisma.room.create({ data: { eventId: EVENT_ID, name: "Hall A", capacity: 200, sortOrder: 0 } });
  const roomB = await prisma.room.create({ data: { eventId: EVENT_ID, name: "Hall B", capacity: 200, sortOrder: 1 } });

  // An OPEN form (window spans now) so submission is actually possible.
  const form = await prisma.formConfig.create({
    data: {
      eventId: EVENT_ID,
      name: "Scratch CFP",
      slug: "scratch-cfp",
      welcomeText: "Pitch your talk.",
      thankYouText: "Thanks!",
      opensAt: new Date(now - 86400000),
      closesAt: new Date(now + 86400000),
      submissionLimit: 3,
      minSpeakers: 1,
      maxSpeakers: 3,
      maxBioLength: 1500,
      published: true,
      fields: {
        create: [
          {
            key: "audience_level", label: "Audience level", type: "SELECT", required: true, sortOrder: 0,
            options: [{ label: "Beginner", value: "beginner" }, { label: "Advanced", value: "advanced" }],
          },
          { key: "learning_objectives", label: "What will attendees learn?", type: "LONG_TEXT", required: true, sortOrder: 1 },
          {
            key: "workshop_prereqs", label: "Workshop prerequisites", type: "LONG_TEXT", required: true, sortOrder: 2,
            conditionalLogic: { match: "all", rules: [{ fieldKey: "audience_level", operator: "equals", value: "advanced" }] },
          },
        ],
      },
    },
    include: { fields: true },
  });

  // A submitted abstract assigned to the evaluator, for the scoring queue.
  const abstract = await prisma.abstract.create({
    data: {
      eventId: EVENT_ID, formConfigId: form.id, submitterId: users.speaker,
      title: "Scratch: Agents in Production", abstract: "A talk.", format: "Talk",
      durationMinutes: 30, categoryId: category.id, status: "UNDER_REVIEW",
      submittedAt: new Date(),
      speakers: { create: [{ userId: users.speaker, isPrimary: true }] },
    },
  });

  const plan = await prisma.evaluationPlan.create({
    data: {
      eventId: EVENT_ID, name: "Scratch Round 1", ordinal: 1, isBlind: false,
      rubric: [
        { key: "relevance", label: "Relevance", min: 1, max: 5, weight: 1.5 },
        { key: "clarity", label: "Clarity", min: 1, max: 5, weight: 1 },
      ],
    },
  });
  await prisma.reviewAssignment.create({
    data: { planId: plan.id, abstractId: abstract.id, evaluatorId: users.evaluator, teamKey: "team-ai", status: "ASSIGNED" },
  });

  // An accepted abstract to convert, plus two sessions to schedule/conflict.
  const acceptedAbstract = await prisma.abstract.create({
    data: {
      eventId: EVENT_ID, formConfigId: form.id, submitterId: users.speaker,
      title: "Scratch: Accepted Talk", abstract: "Body.", format: "Talk",
      durationMinutes: 30, categoryId: category.id, status: "ACCEPTED",
      submittedAt: new Date(), decidedAt: new Date(),
      speakers: { create: [{ userId: users.speaker, isPrimary: true }] },
    },
  });

  const sessionA = await prisma.session.create({
    data: {
      eventId: EVENT_ID, title: "Scratch Session A", durationMinutes: 30, format: "Talk",
      speakers: { create: [{ userId: users.speaker, isPrimary: true }] },
    },
  });
  const dayKey = new Date(now + 30 * 86400000).toISOString().slice(0, 10);
  await prisma.scheduleSlot.create({
    data: {
      eventId: EVENT_ID, sessionId: sessionA.id, roomId: roomA.id, trackId: track.id,
      startsAt: new Date(`${dayKey}T17:00:00.000Z`), endsAt: new Date(`${dayKey}T17:30:00.000Z`),
    },
  });
  const sessionB = await prisma.session.create({
    data: {
      eventId: EVENT_ID, title: "Scratch Session B (unscheduled)", durationMinutes: 30, format: "Talk",
      speakers: { create: [{ userId: users.speaker, isPrimary: true }] },
    },
  });

  return { event, form, abstract, acceptedAbstract, plan, sessionA, sessionB, roomA, roomB, track, category, users, dayKey };
}

// ---- checks ---------------------------------------------------------------

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${detail && !pass ? ` — ${detail}` : ""}`);
};

const server = spawn("npx", ["next", "start", "-p", PORT], { cwd: process.cwd(), shell: true, stdio: ["ignore", "pipe", "pipe"] });
console.log(`[smoke] spawned pid ${server.pid} on port ${PORT}`);

/**
 * Kill the spawned server and its children.
 *
 * `shell: true` means `server.pid` is the shell wrapper; killing only that
 * leaves the real `next-server` holding the port, which makes the next run fail
 * to bind. `/T` kills the tree. Never kill node by image name (see the incident
 * rule in coordination STATE.md) — this is scoped to our own PID.
 */
function stopServer() {
  if (!server.pid) return;
  const res = spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)], { encoding: "utf8" });
  console.log(`[smoke] stopped server tree for pid ${server.pid}${res.status === 0 ? "" : ` (exit ${res.status})`}`);
}
process.on("SIGINT", () => { stopServer(); process.exit(130); });
server.stderr.on("data", (d) => {
  const s = d.toString();
  if (/error|Error/.test(s)) process.stderr.write(s);
});

async function waitReady() {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${BASE}/login`);
      if (r.status) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

let fx;
try {
  console.log("[smoke] rebuilding scratch-frontend event…");
  fx = await resetScratch();
  console.log(`[smoke] scratch ready (form ${fx.form.id})`);

  if (!(await waitReady())) throw new Error("server never became ready");

  // --- page renders ---
  for (const [name, path, sess] of [
    ["page /admin/forms", "/admin/forms", admin],
    ["page /admin/forms/[id]", `/admin/forms/${fx.form.id}`, admin],
    ["page /admin/abstracts", "/admin/abstracts", admin],
    ["page /admin/agenda", "/admin/agenda", admin],
    ["page /admin/evaluations (evaluator)", "/admin/evaluations", evaluator],
    ["page /cfp/[formId] (public)", `/cfp/${fx.form.id}`, null],
    ["page /embed/schedule (public)", `/embed/schedule?event=${EVENT_ID}`, null],
  ]) {
    const r = await req("GET", path, null, sess);
    check(`${name} → 200`, r.status === 200, `got ${r.status}`);
  }

  // --- real data actually rendered ---
  const formsPage = await req("GET", "/admin/forms", null, admin);
  check("forms page shows scratch form name", formsPage.text.includes("Scratch CFP"));

  const absPage = await req("GET", "/admin/abstracts", null, admin);
  check("abstracts page shows seeded abstract", absPage.text.includes("Scratch: Agents in Production"));

  const agendaPage = await req("GET", "/admin/agenda", null, admin);
  check("agenda shows scheduled session", agendaPage.text.includes("Scratch Session A"));
  check("agenda shows unscheduled backlog", agendaPage.text.includes("Scratch Session B"));

  const cfpPage = await req("GET", `/cfp/${fx.form.id}`, null, null);
  check("public CFP renders open form (not closed state)", !cfpPage.text.includes("Submissions are closed"));
  check("public CFP renders category select", cfpPage.text.includes("Applied AI"));

  const evalPage = await req("GET", "/admin/evaluations", null, evaluator);
  check("evaluator queue shows assigned abstract", evalPage.text.includes("Scratch: Agents in Production"));

  const embedPage = await req("GET", `/embed/schedule?event=${EVENT_ID}`, null, null);
  check("embed shows scheduled session", embedPage.text.includes("Scratch Session A"));

  // --- mutation 1: builder Save ---
  const savePayload = {
    eventId: EVENT_ID,
    id: fx.form.id,
    name: "Scratch CFP (renamed)",
    slug: "scratch-cfp",
    welcomeText: "Updated copy.",
    thankYouText: "Thanks!",
    opensAt: new Date(Date.now() - 86400000).toISOString(),
    closesAt: new Date(Date.now() + 86400000).toISOString(),
    submissionLimit: 3,
    minSpeakers: 1,
    maxSpeakers: 3,
    maxBioLength: 1500,
    published: true,
    fields: [
      { key: "audience_level", label: "Audience level", type: "SELECT", required: true, sortOrder: 0, options: [{ label: "Beginner", value: "beginner" }, { label: "Advanced", value: "advanced" }] },
      { key: "learning_objectives", label: "What will attendees learn?", type: "LONG_TEXT", required: true, sortOrder: 1 },
      { key: "brand_new_q", label: "Added by smoke", type: "SHORT_TEXT", required: false, sortOrder: 2 },
    ],
  };
  const save = await req("POST", "/api/cfp/forms", savePayload, admin);
  check("builder Save → 200", save.status === 200, `${save.status} ${JSON.stringify(save.data?.error ?? "")}`);
  check("builder Save renamed the form", save.data?.data?.name === "Scratch CFP (renamed)");
  check("builder Save added the new field", (save.data?.data?.fields ?? []).some((f) => f.key === "brand_new_q"));
  check("builder Save removed the deleted field", !(save.data?.data?.fields ?? []).some((f) => f.key === "workshop_prereqs"));

  // --- mutation 2: CFP draft then submit ---
  const draft = await req("POST", "/api/cfp/submissions", {
    formConfigId: fx.form.id,
    title: "Smoke draft proposal",
    abstract: "Draft body",
    format: "Talk",
    durationMinutes: 30,
    categoryId: fx.category.id,
    speakers: [{ email: "smoke.speaker@example.com", name: "Smoke Speaker", isPrimary: true }],
    answers: { audience_level: "beginner", learning_objectives: "" },
    intent: "saveDraft",
  }, null);
  check("CFP save draft → 201", draft.status === 201, `${draft.status} ${JSON.stringify(draft.data?.error ?? "")}`);
  check("draft has DRAFT status", draft.data?.data?.status === "DRAFT");

  const submit = await req("POST", "/api/cfp/submissions", {
    formConfigId: fx.form.id,
    abstractId: draft.data?.data?.id,
    title: "Smoke submitted proposal",
    abstract: "Full body",
    format: "Talk",
    durationMinutes: 30,
    categoryId: fx.category.id,
    speakers: [
      { email: "smoke.speaker@example.com", name: "Smoke Speaker", isPrimary: true },
      { email: "smoke.cospeaker@example.com", name: "Smoke Co", isPrimary: false },
    ],
    answers: { audience_level: "beginner", learning_objectives: "Three takeaways." },
    intent: "submit",
  }, null);
  check("CFP submit → 200", submit.status === 200, `${submit.status} ${JSON.stringify(submit.data?.error ?? "")}`);
  check("submitted abstract has SUBMITTED status", submit.data?.data?.status === "SUBMITTED");
  check("co-speaker upserted by email", (submit.data?.data?.speakers ?? []).length === 2);

  // required-field rejection
  const badSubmit = await req("POST", "/api/cfp/submissions", {
    formConfigId: fx.form.id,
    title: "Missing required answers",
    speakers: [{ email: "smoke2@example.com", name: "Smoke Two", isPrimary: true }],
    answers: { audience_level: "beginner" },
    intent: "submit",
  }, null);
  check("CFP submit missing required field → 422", badSubmit.status === 422, `got ${badSubmit.status}`);
  check("422 carries fieldErrors the UI can map", !!badSubmit.data?.error?.fieldErrors);

  // --- mutation 3: accept + convert ---
  const decide = await req("POST", "/api/evaluations/decisions", {
    abstractId: submit.data?.data?.id, decision: "ACCEPTED",
  }, admin);
  check("accept decision → 200", decide.status === 200, `${decide.status} ${JSON.stringify(decide.data?.error ?? "")}`);
  check("abstract now ACCEPTED", decide.data?.data?.status === "ACCEPTED");

  const convert = await req("POST", "/api/evaluations/convert", {
    abstractId: submit.data?.data?.id, durationMinutes: 30,
  }, admin);
  check("convert to session → 201", convert.status === 201, `${convert.status} ${JSON.stringify(convert.data?.error ?? "")}`);
  check("convert reports created", convert.data?.data?.created === true);

  const convertAgain = await req("POST", "/api/evaluations/convert", {
    abstractId: submit.data?.data?.id, durationMinutes: 30,
  }, admin);
  check("convert is idempotent (created:false)", convertAgain.data?.data?.created === false);

  // --- mutation 4: score submission ---
  const score = await req("POST", "/api/evaluations/scores", {
    planId: fx.plan.id,
    abstractId: fx.abstract.id,
    scores: [
      { rubricKey: "relevance", score: 5, comment: "Strong." },
      { rubricKey: "clarity", score: 4 },
    ],
    complete: true,
  }, evaluator);
  check("score submission → 200", score.status === 200, `${score.status} ${JSON.stringify(score.data?.error ?? "")}`);

  const outOfRange = await req("POST", "/api/evaluations/scores", {
    planId: fx.plan.id, abstractId: fx.abstract.id,
    scores: [{ rubricKey: "relevance", score: 99 }], complete: false,
  }, evaluator);
  check("out-of-range score → 422", outOfRange.status === 422, `got ${outOfRange.status}`);

  const notAssigned = await req("POST", "/api/evaluations/scores", {
    planId: fx.plan.id, abstractId: fx.abstract.id,
    scores: [{ rubricKey: "relevance", score: 3 }], complete: false,
  }, admin);
  check("unassigned reviewer blocked → 403", notAssigned.status === 403, `got ${notAssigned.status}`);

  // --- scheduling: conflict refused, then forced, then moved/unscheduled ---
  const conflicting = await req("POST", "/api/agenda/slots", {
    eventId: EVENT_ID,
    sessionId: fx.sessionB.id,
    roomId: fx.roomA.id,
    trackId: fx.track.id,
    startsAt: `${fx.dayKey}T17:15:00.000Z`,
    endsAt: `${fx.dayKey}T17:45:00.000Z`,
  }, admin);
  check("overlapping placement refused → 409", conflicting.status === 409, `got ${conflicting.status}`);
  check("409 lists the conflicts", (conflicting.data?.error?.fieldErrors?.conflicts ?? []).length > 0);

  const clean = await req("POST", "/api/agenda/slots", {
    eventId: EVENT_ID,
    sessionId: fx.sessionB.id,
    roomId: fx.roomB.id,
    trackId: fx.track.id,
    startsAt: `${fx.dayKey}T19:00:00.000Z`,
    endsAt: `${fx.dayKey}T19:30:00.000Z`,
  }, admin);
  check("clean placement → 200", clean.status === 200, `${clean.status} ${JSON.stringify(clean.data?.error ?? "")}`);

  const unsched = await req("DELETE", `/api/agenda/slots?sessionId=${fx.sessionB.id}`, null, admin);
  check("unschedule → 200", unsched.status === 200, `got ${unsched.status}`);

  // --- authorization ---
  // Must be a clean redirect, not a thrown 401 error page: the page's own data
  // read races the layout's requireSession(), so the read has to redirect too.
  const noSession = await fetch(`${BASE}/admin/abstracts`, { redirect: "manual" });
  check("unauthenticated admin page → 307 /login", noSession.status === 307, `got ${noSession.status}`);
  check("redirect points at /login", (noSession.headers.get("location") ?? "").includes("/login"), noSession.headers.get("location") ?? "none");

  const wrongRole = await fetch(`${BASE}/admin/agenda`, {
    headers: { cookie: cookie({ ...admin, role: "SPEAKER" }) },
    redirect: "manual",
  });
  check("speaker role blocked from /admin/agenda → 307", wrongRole.status === 307, `got ${wrongRole.status}`);
} catch (error) {
  check("smoke run completed", false, String(error));
} finally {
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n[smoke] ${passed}/${results.length} checks passed`);
  try {
    await prisma.event.deleteMany({ where: { id: EVENT_ID } });
    console.log("[smoke] scratch-frontend cleaned up");
  } catch (e) {
    console.error("[smoke] cleanup failed", e);
  }
  await prisma.$disconnect();
  stopServer();
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}
