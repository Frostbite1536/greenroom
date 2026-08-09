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
import { SMOKE_SESSION_SECRET, cookieForSession } from "./_signed-session.mjs";

const prisma = new PrismaClient();
const EVENT_ID = "scratch-frontend";
const BLIND_SPEAKER_EMAIL = "blind-boundary@scratch.test";
// A second, deliberately empty event: the fresh-event empty states are the
// first thing a judge driving the product live will see, so they are asserted
// rather than assumed.
const FRESH_EVENT_ID = "scratch-frontend-fresh";
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

const ev = { id: EVENT_ID, name: "Scratch Frontend", slug: EVENT_ID };
const admin = { user: { id: "x", name: "Maya Chen", email: "maya@greenroom.demo" }, event: ev, role: "ADMIN" };
const evaluator = { user: { id: "x", name: "Ravi Patel", email: "ravi@greenroom.demo" }, event: ev, role: "EVALUATOR" };
const speaker = { user: { id: "x", name: "Sofia Marques", email: "sofia@greenroom.demo" }, event: ev, role: "SPEAKER" };
const cookie = cookieForSession;

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
  await prisma.event.deleteMany({ where: { id: { in: [EVENT_ID, FRESH_EVENT_ID] } } });
  await prisma.user.deleteMany({ where: { email: BLIND_SPEAKER_EMAIL } });

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
    admin: ["maya@greenroom.demo", "Maya Chen"],
    evaluator: ["ravi@greenroom.demo", "Ravi Patel"],
    speaker: ["sofia@greenroom.demo", "Sofia Marques"],
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
  // Amber on purpose: this is the seeded track colour that measured 2.14:1
  // against white text (ops-a11y-frontend-findings). Keeping it here means the
  // contrast assertion below guards the exact reported regression.
  const track = await prisma.track.create({ data: { eventId: EVENT_ID, name: "Mainstage", color: "#f59e0b", sortOrder: 0 } });
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

  // A brand-new event: an admin, and nothing else. Drives the F2 empty states.
  await prisma.event.create({
    data: {
      id: FRESH_EVENT_ID,
      name: "Scratch Fresh",
      slug: FRESH_EVENT_ID,
      timezone: "America/Los_Angeles",
      memberships: { create: [{ userId: users.admin, role: "ADMIN" }] },
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

const server = spawn("npx", ["next", "start", "-p", PORT], {
  cwd: process.cwd(), shell: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, SESSION_SECRET: SMOKE_SESSION_SECRET },
});
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
  if (!server.pid || server.exitCode !== null) return true;
  const res = spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)], { encoding: "utf8" });
  console.log(`[smoke] stopped server tree for pid ${server.pid}${res.status === 0 ? "" : ` (exit ${res.status})`}`);
  if (res.error || res.status !== 0) {
    cleanupFailed = true;
    console.error(`[smoke] failed to stop server tree: ${res.error?.message ?? res.stderr ?? `exit ${res.status}`}`);
    return false;
  }
  return true;
}
let cleanupFailed = false;
let cleanupPromise;
function cleanup() {
  cleanupPromise ??= (async () => {
    try {
      await prisma.event.deleteMany({ where: { id: { in: [EVENT_ID, FRESH_EVENT_ID] } } });
      await prisma.user.deleteMany({ where: { email: BLIND_SPEAKER_EMAIL } });
      console.log("[smoke] scratch-frontend cleaned up");
    } catch (error) {
      cleanupFailed = true;
      console.error("[smoke] cleanup failed", error);
    }
    await prisma.$disconnect().catch((error) => {
      cleanupFailed = true;
      console.error("[smoke] Prisma cleanup failed", error);
    });
    stopServer();
    return cleanupFailed;
  })();
  return cleanupPromise;
}
process.once("SIGINT", () => {
  void cleanup().finally(() => process.exit(130));
});
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
    ["page /admin/embeds", "/admin/embeds", admin],
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
  check("agenda offers day, week, tracks and conflicts views",
    ["Day", "Week", "Tracks", "Conflicts"].every((t) => agendaPage.text.includes(t)));
  // Drag-and-drop itself needs a browser; these assert the affordance ships and
  // the underlying move is the same POST /api/agenda/slots covered below.
  check("day grid renders draggable slot blocks", agendaPage.text.includes('draggable="true"'));
  check("day grid explains the drag affordance", agendaPage.text.includes("Drag a session to another room or time"));

  const cfpPage = await req("GET", `/cfp/${fx.form.id}`, null, null);
  check("public CFP renders open form (not closed state)", !cfpPage.text.includes("Submissions are closed"));
  check("public CFP renders category select", cfpPage.text.includes("Applied AI"));

  const evalPage = await req("GET", "/admin/evaluations", null, evaluator);
  check("evaluator queue shows assigned abstract", evalPage.text.includes("Scratch: Agents in Production"));

  const embedPage = await req("GET", `/embed/schedule?event=${EVENT_ID}`, null, null);
  check("embed shows scheduled session", embedPage.text.includes("Scratch Session A"));

  // Calendar downloads remain public: whole event with no session, or one
  // scheduled session when its affordance is used in the embed.
  const eventCalendar = await req("GET", `/api/comms/calendar?eventId=${EVENT_ID}`, null, null);
  check("public event calendar export → 200", eventCalendar.status === 200, `got ${eventCalendar.status}`);
  check("public event calendar export has scheduled session", eventCalendar.text.includes("SUMMARY:Scratch Session A"));

  const sessionCalendar = await req("GET", `/api/comms/calendar?eventId=${EVENT_ID}&sessionId=${fx.sessionA.id}`, null, null);
  check("public session calendar export → 200", sessionCalendar.status === 200, `got ${sessionCalendar.status}`);
  check("public session calendar export has one event", (sessionCalendar.text.match(/BEGIN:VEVENT/g) ?? []).length === 1);

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

  // --- mutation 1b: create a brand-new form (B3, what NewFormDialog posts) ---
  const createdPayload = {
    eventId: EVENT_ID,
    name: "Scratch New Form",
    slug: "scratch-new-form",
    welcomeText: "Submit your proposal for Scratch New Form.",
    thankYouText: "Thanks for your submission! The program team will follow up by email.",
    minSpeakers: 1,
    maxSpeakers: 2,
    maxBioLength: 1000,
    published: false,
    fields: [
      { key: "audience_level", label: "Audience level", type: "SELECT", required: true, sortOrder: 0, options: [{ label: "Beginner", value: "beginner" }, { label: "Intermediate", value: "intermediate" }, { label: "Advanced", value: "advanced" }] },
      { key: "learning_objectives", label: "What will attendees learn?", helpText: "Three concrete takeaways.", type: "LONG_TEXT", required: true, sortOrder: 1 },
    ],
  };
  const created = await req("POST", "/api/cfp/forms", createdPayload, admin);
  check("create new form → 201", created.status === 201, `${created.status} ${JSON.stringify(created.data?.error ?? "")}`);
  check("new form starts unpublished", created.data?.data?.published === false);
  check("new form carries the starter questions", (created.data?.data?.fields ?? []).length === 2);

  const newFormId = created.data?.data?.id;
  const builderPage = await req("GET", `/admin/forms/${newFormId}`, null, admin);
  check("new form opens in the builder → 200", builderPage.status === 200, `got ${builderPage.status}`);
  check("builder surfaces the new form's public URL", builderPage.text.includes(`/cfp/${newFormId}`));

  const listAfterCreate = await req("GET", "/admin/forms", null, admin);
  check("forms list shows the new form", listAfterCreate.text.includes("Scratch New Form"));
  check("forms list offers the New form action", listAfterCreate.text.includes("New form"));

  // Unpublished forms must stay invisible publicly until the builder publishes.
  const unpublishedPublic = await req("GET", `/cfp/${newFormId}`, null, null);
  check("unpublished new form is not public yet → 404", unpublishedPublic.status === 404, `got ${unpublishedPublic.status}`);

  // A duplicate slug must not silently create a second form.
  const duplicate = await req("POST", "/api/cfp/forms", createdPayload, admin);
  check("duplicate slug is rejected", duplicate.status >= 400,
    `got ${duplicate.status} ${duplicate.data?.error?.code ?? ""}`);
  // Documented so the dialog's fallback copy stays honest: the API surfaces the
  // unique (eventId, slug) violation as a generic error, so NewFormDialog
  // pre-checks slugs client-side. Backend: a 409 FORM_SLUG_TAKEN would be nicer.
  console.log(`  note duplicate-slug response: ${duplicate.status} ${duplicate.data?.error?.code ?? "?"}`);

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

  // --- mutation 3: accept auto-provisions; convert reuses that Session ---
  const decide = await req("POST", "/api/evaluations/decisions", {
    abstractId: submit.data?.data?.id, decision: "ACCEPTED",
  }, admin);
  check("accept decision → 200", decide.status === 200, `${decide.status} ${JSON.stringify(decide.data?.error ?? "")}`);
  check("abstract now ACCEPTED", decide.data?.data?.status === "ACCEPTED");

  const convert = await req("POST", "/api/evaluations/convert", {
    abstractId: submit.data?.data?.id, durationMinutes: 30,
  }, admin);
  check("convert reuses the auto-provisioned session → 200", convert.status === 200,
    `${convert.status} ${JSON.stringify(convert.data?.error ?? "")}`);
  check("convert reports existing session", convert.data?.data?.created === false);

  const convertAgain = await req("POST", "/api/evaluations/convert", {
    abstractId: submit.data?.data?.id, durationMinutes: 30,
  }, admin);
  check("convert is idempotent (created:false)", convertAgain.data?.data?.created === false);

  // --- W2: the admin table must surface a talk left on the programme ---
  // Walks the exact sequence the notice exists for: converted -> scheduled ->
  // decision reversed. INV-DOMAIN-001 means nothing is auto-deleted, so the
  // only safeguard is that the admin can SEE it.
  const convertedAbstractId = submit.data?.data?.id;
  const convertedSessionId = convert.data?.data?.sessionId;

  const afterConvert = await req("GET", "/admin/abstracts", null, admin);
  check("abstracts table shows an unscheduled talk as 'Talk created'",
    afterConvert.text.includes("Talk created"));

  // --- F1: the admin drawer must actually carry the speaker's custom answers ---
  // The drawer is client-rendered on click, so the assertion is that the answer
  // DATA reaches the client payload at all — that is precisely what was missing.
  check("admin page ships the submitted long-text answer",
    afterConvert.text.includes("Three takeaways."));
  check("admin page ships the custom field labels",
    afterConvert.text.includes("Audience level") && afterConvert.text.includes("What will attendees learn?"));
  // Option labels must ship too, or the drawer can only show raw slugs. The
  // slug->label mapping itself runs client-side and is unit-tested in
  // lib/answer-display.test.ts.
  check("admin page ships select option labels for slug resolution",
    afterConvert.text.includes("Beginner"));
  const evaluatorAbstracts = await req("GET", "/admin/abstracts", null, evaluator);
  check("evaluator abstracts page withholds custom answer values",
    !evaluatorAbstracts.text.includes("Three takeaways."));
  check("evaluator abstracts page withholds custom field labels",
    !evaluatorAbstracts.text.includes("Audience level") && !evaluatorAbstracts.text.includes("What will attendees learn?"));

  const placeConverted = await req("POST", "/api/agenda/slots", {
    eventId: EVENT_ID,
    sessionId: convertedSessionId,
    roomId: fx.roomB.id,
    trackId: fx.track.id,
    startsAt: `${fx.dayKey}T22:00:00.000Z`,
    endsAt: `${fx.dayKey}T22:30:00.000Z`,
  }, admin);
  check("converted session schedules cleanly → 200", placeConverted.status === 200,
    `${placeConverted.status} ${JSON.stringify(placeConverted.data?.error ?? "")}`);

  const afterSchedule = await req("GET", "/admin/abstracts", null, admin);
  check("abstracts table shows a scheduled talk as 'On the programme'",
    afterSchedule.text.includes("On the programme"));
  // Non-vacuity guard: the warning must be absent while the decision still
  // matches the programme, otherwise the assertion below proves nothing.
  check("no 'Still on the programme' warning while the talk is accepted",
    !afterSchedule.text.includes("Still on the programme"));

  // M4: MAYBE is a deliberate, non-final decision. It does not provision a
  // second Session, retains an existing one honestly, and can later change.
  const maybe = await req("POST", "/api/evaluations/decisions", {
    abstractId: convertedAbstractId, decision: "MAYBE",
  }, admin);
  check("maybe decision → 200", maybe.status === 200,
    `${maybe.status} ${JSON.stringify(maybe.data?.error ?? "")}`);
  check("maybe remains non-final and keeps the existing talk",
    maybe.data?.data?.status === "MAYBE"
    && maybe.data?.data?.decidedAt === null
    && maybe.data?.data?.sessionCreated === false
    && maybe.data?.data?.tasksAssigned === 0
    && maybe.data?.data?.session?.id === convertedSessionId,
    JSON.stringify(maybe.data?.data ?? {}));
  check("maybe never creates a second session",
    (await prisma.session.count({ where: { sourceAbstractId: convertedAbstractId } })) === 1);

  const afterMaybe = await req("GET", "/admin/abstracts", null, admin);
  check("pipeline renders a Maybe status pill",
    /class="pill warn">Maybe<\/span>/.test(afterMaybe.text));
  check("Maybe status filter exposes its pressed state",
    /aria-pressed="false" class="tab">Maybe <span class="count">1<\/span>/.test(afterMaybe.text));
  check("maybe-but-scheduled abstract is flagged 'Still on the programme'",
    afterMaybe.text.includes("Still on the programme"));

  // The drawer's 'Change decision' path depends on a later final decision
  // being allowed after MAYBE.
  const reverse = await req("POST", "/api/evaluations/decisions", {
    abstractId: convertedAbstractId, decision: "REJECTED",
  }, admin);
  check("a final decision after maybe is allowed → 200", reverse.status === 200,
    `${reverse.status} ${JSON.stringify(reverse.data?.error ?? "")}`);
  check("reversed decision does NOT delete the talk (INV-DOMAIN-001)",
    (await prisma.session.count({ where: { id: convertedSessionId } })) === 1);

  const afterReverse = await req("GET", "/admin/abstracts", null, admin);
  check("declined-but-scheduled abstract is flagged 'Still on the programme'",
    afterReverse.text.includes("Still on the programme"));

  // Restore ACCEPTED so later checks see the pipeline in its expected state.
  const restore = await req("POST", "/api/evaluations/decisions", {
    abstractId: convertedAbstractId, decision: "ACCEPTED",
  }, admin);
  check("decision can be changed back → 200", restore.status === 200, `got ${restore.status}`);
  await req("DELETE", `/api/agenda/slots?sessionId=${convertedSessionId}`, null, admin);

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

  // The drag-and-drop move (B6) posts this exact shape for an ALREADY-scheduled
  // session: same slot, new room and start, duration preserved. The endpoint must
  // not treat the slot as conflicting with itself.
  const dragMove = await req("POST", "/api/agenda/slots", {
    eventId: EVENT_ID,
    sessionId: fx.sessionB.id,
    roomId: fx.roomA.id,
    trackId: fx.track.id,
    startsAt: `${fx.dayKey}T20:00:00.000Z`,
    endsAt: `${fx.dayKey}T20:30:00.000Z`,
  }, admin);
  check("drag move of a scheduled session → 200", dragMove.status === 200, `${dragMove.status} ${JSON.stringify(dragMove.data?.error ?? "")}`);
  check("drag move landed in the new room", dragMove.data?.data?.slot?.roomId === fx.roomA.id,
    JSON.stringify(dragMove.data?.data?.slot ?? {}));
  check("drag move landed at the new time", dragMove.data?.data?.slot?.startsAt === `${fx.dayKey}T20:00:00.000Z`,
    dragMove.data?.data?.slot?.startsAt ?? "none");

  const unsched = await req("DELETE", `/api/agenda/slots?sessionId=${fx.sessionB.id}`, null, admin);
  check("unschedule → 200", unsched.status === 200, `got ${unsched.status}`);

  // --- embed snippet page (B2) ---
  const embedsPage = await req("GET", "/admin/embeds", null, admin);
  check("embeds page offers an absolute schedule iframe",
    embedsPage.text.includes(`&lt;iframe`) && embedsPage.text.includes(`/embed/schedule?event=${EVENT_ID}`));
  check("embeds page offers the speaker gallery snippet", embedsPage.text.includes(`/embed/speakers?event=${EVENT_ID}`));
  check("embeds page reports live counts", embedsPage.text.includes("Scheduled sessions"));

  // --- role-aware navigation (B1) ---
  // Presentation only: the sidebar must not advertise pages the role's own
  // server-side guard would bounce.
  const adminNav = await req("GET", "/admin/forms", null, admin);
  check("admin nav shows agenda builder", adminNav.text.includes("Agenda builder"));
  check("admin nav shows embeds", adminNav.text.includes("/admin/embeds"));
  check("admin nav shows speaker onboarding",
    adminNav.text.includes("/admin/speakers") && adminNav.text.includes("Speaker onboarding"));

  const speakerNav = await req("GET", "/portal", null, speaker);
  check("speaker portal renders → 200", speakerNav.status === 200, `got ${speakerNav.status}`);
  check("speaker nav hides admin-only links",
    !speakerNav.text.includes("/admin/forms") && !speakerNav.text.includes("/admin/agenda")
    && !speakerNav.text.includes("/admin/speakers"));
  check("speaker nav keeps portal + public links",
    speakerNav.text.includes("/portal") && speakerNav.text.includes("/embed/schedule"));

  const evaluatorNav = await req("GET", "/admin/evaluations", null, evaluator);
  check("evaluator nav hides CFP forms, agenda and speaker onboarding",
    !evaluatorNav.text.includes("/admin/forms") && !evaluatorNav.text.includes("/admin/agenda")
    && !evaluatorNav.text.includes("/admin/speakers"));
  check("evaluator nav keeps evaluations + abstracts",
    evaluatorNav.text.includes("/admin/evaluations") && evaluatorNav.text.includes("/admin/abstracts"));

  // --- F2: admin evaluation setup panel -----------------------------------
  const setupPage = await req("GET", "/admin/evaluations", null, admin);
  check("admin evaluations page → 200", setupPage.status === 200, `got ${setupPage.status}`);
  check("admin sees the round list", setupPage.text.includes("Review rounds"));
  check("admin sees the assignment panel", setupPage.text.includes("Assign proposals to reviewers"));
  check("admin sees review coverage", setupPage.text.includes("Review coverage"));
  check("reviewer picker lists a real event evaluator", setupPage.text.includes("Ravi Patel"));
  check("evaluation setup payload omits unused reviewer emails",
    !setupPage.text.includes("ravi@greenroom.demo"));

  // Role-aware: an evaluator must get the scoring queue, never the setup panel.
  const evaluatorEval = await req("GET", "/admin/evaluations", null, evaluator);
  check("evaluator does NOT see the setup panel",
    !evaluatorEval.text.includes("Assign proposals to reviewers")
    && !evaluatorEval.text.includes("Review coverage"));

  // Fresh event: the empty states must tell the admin what to do next.
  const freshAdmin = { ...admin, event: { id: FRESH_EVENT_ID, name: "Scratch Fresh", slug: FRESH_EVENT_ID } };
  const freshPage = await req("GET", "/admin/evaluations", null, freshAdmin);
  check("fresh event evaluations page → 200", freshPage.status === 200, `got ${freshPage.status}`);
  check("fresh event offers an actionable first step",
    freshPage.text.includes("No review round yet") && freshPage.text.includes("Create the first round"));
  check("fresh event does not show a coverage table", !freshPage.text.includes("Review coverage"));

  // The two mutations the panel drives, against the real routes.
  const newRound = await req("POST", "/api/evaluations/plans", {
    eventId: FRESH_EVENT_ID,
    name: "Round 1 — Program Committee",
    ordinal: 1,
    isBlind: false,
    rubric: [{ key: "relevance", label: "Relevance", min: 1, max: 5, weight: 1.5 }],
  }, freshAdmin);
  check("setup panel can create a round → 201", newRound.status === 201,
    `${newRound.status} ${JSON.stringify(newRound.data?.error ?? "")}`);

  const freshAfterRound = await req("GET", "/admin/evaluations", null, freshAdmin);
  check("a fresh event with a round but no proposals says so",
    freshAfterRound.text.includes("No proposals to review yet"));

  // Assigning must move a genuinely SUBMITTED proposal to UNDER_REVIEW, with
  // the team key routed from its category (teamKey omitted on purpose). S5 now
  // correctly refuses the inherited smoke's old ACCEPTED fixture.
  const blindSpeaker = await prisma.user.upsert({
    where: { email: BLIND_SPEAKER_EMAIL },
    update: { name: "Blind Boundary Speaker" },
    create: { email: BLIND_SPEAKER_EMAIL, name: "Blind Boundary Speaker" },
  });
  const setupAbstract = await prisma.abstract.create({
    data: {
      eventId: EVENT_ID,
      formConfigId: fx.form.id,
      submitterId: fx.users.speaker,
      title: "Scratch: Ready for reviewer assignment",
      abstract: "A submitted proposal for the setup panel.",
      categoryId: fx.category.id,
      status: "SUBMITTED",
      submittedAt: new Date(),
      speakers: { create: [{ userId: blindSpeaker.id, isPrimary: true }] },
    },
  });
  const freshAssign = await req("POST", "/api/evaluations/assignments", {
    planId: fx.plan.id,
    abstractIds: [setupAbstract.id],
    evaluatorIds: [fx.users.evaluator],
  }, admin);
  check("setup panel can assign reviewers → 201", freshAssign.status === 201,
    `${freshAssign.status} ${JSON.stringify(freshAssign.data?.error ?? "")}`);
  check("assignment moves the submitted proposal to UNDER_REVIEW",
    (await prisma.abstract.findUnique({
      where: { id: setupAbstract.id },
      select: { status: true },
    }))?.status === "UNDER_REVIEW");
  check("assignment inherits the category's review team",
    (await prisma.reviewAssignment.findFirst({
      where: { planId: fx.plan.id, abstractId: setupAbstract.id },
      select: { teamKey: true },
    }))?.teamKey === "team-ai");
  check("re-assigning the same pair is idempotent",
    (await req("POST", "/api/evaluations/assignments", {
      planId: fx.plan.id,
      abstractIds: [setupAbstract.id],
      evaluatorIds: [fx.users.evaluator],
    }, admin)).status === 201
    && (await prisma.reviewAssignment.count({
      where: { planId: fx.plan.id, abstractId: setupAbstract.id },
    })) === 1);

  // --- F3 (frontend half): blind rounds must hide identity on /admin/abstracts
  // Not just visually: the names and emails must never reach the client payload.
  const beforeBlind = await req("GET", "/admin/abstracts", null, evaluator);
  check("non-blind round: evaluator sees speaker names",
    beforeBlind.text.includes("Blind Boundary Speaker"));
  check("unused speaker emails never enter the evaluator payload",
    !beforeBlind.text.includes(BLIND_SPEAKER_EMAIL));

  await prisma.evaluationPlan.update({ where: { id: fx.plan.id }, data: { isBlind: true } });
  const blindEvaluator = await req("GET", "/admin/abstracts", null, evaluator);
  check("blind round: evaluator page withholds the speaker name",
    !blindEvaluator.text.includes("Blind Boundary Speaker"));
  check("blind round: evaluator is told profiles are hidden",
    blindEvaluator.text.includes("Profiles hidden"));

  const blindQueue = await req("GET", "/admin/evaluations", null, evaluator);
  check("blind scoring queue withholds the speaker name",
    !blindQueue.text.includes("Blind Boundary Speaker"));
  check("blind scoring queue states the remaining text-identification limit",
    blindQueue.text.includes("Proposal text can still identify a speaker"));

  // Admins run the process and retain names. Email is not rendered anywhere on
  // this surface, so data minimization keeps it out of every client payload.
  const blindAdmin = await req("GET", "/admin/abstracts", null, admin);
  check("blind round: admin still sees speaker names",
    blindAdmin.text.includes("Blind Boundary Speaker"));
  check("unused speaker emails never enter the admin payload",
    !blindAdmin.text.includes(BLIND_SPEAKER_EMAIL));
  await prisma.evaluationPlan.update({ where: { id: fx.plan.id }, data: { isBlind: false } });

  // A speaker can withdraw mid-review (W1), and scoring one is refused 409.
  // The evaluator queue must say so rather than offering a form that will fail.
  // Target the row the page opens on (first not-yet-scored assignment), so both
  // the queue badge and the scoring-panel notice are exercised.
  await prisma.abstract.update({ where: { id: setupAbstract.id }, data: { status: "WITHDRAWN" } });
  const withdrawnQueue = await req("GET", "/admin/evaluations", null, evaluator);
  check("evaluator queue badges a withdrawn proposal", withdrawnQueue.text.includes("Withdrawn"));
  check("scoring panel explains no review is needed",
    withdrawnQueue.text.includes("no longer needs a review"));
  check("withdrawn work does not keep review progress incomplete",
    withdrawnQueue.text.includes("1 of 1 reviewable proposal scored"));
  check("withdrawn scoring panel omits the unusable review form",
    !withdrawnQueue.text.includes("Submit review") && !withdrawnQueue.text.includes("Score every criterion"));

  const withdrawnSetup = await req("GET", "/admin/evaluations", null, admin);
  const historyMarkers = {
    title: withdrawnSetup.text.includes("Scratch: Ready for reviewer assignment"),
    status: withdrawnSetup.text.includes("Withdrawn"),
    archivedAssignment: withdrawnSetup.text.includes("archived"),
    preWithdrawalCount: withdrawnSetup.text.includes("before withdrawal"),
  };
  check("withdrawn proposal remains visible as historical coverage",
    Object.values(historyMarkers).every(Boolean),
    JSON.stringify(historyMarkers));
  check("withdrawn assignment does not keep round progress incomplete",
    withdrawnSetup.text.includes("1/1 reviews done"));
  await prisma.abstract.update({ where: { id: setupAbstract.id }, data: { status: "UNDER_REVIEW" } });

  // --- accessibility regressions (plan B7 / ops-a11y-frontend-findings) ---
  // Deliberately an INDEPENDENT contrast implementation: lib/color-contrast.ts
  // has its own unit tests, so re-using it here would only prove it agrees with
  // itself. This checks what the component actually rendered.
  const srgb = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const luminance = (hex) => {
    const h = hex.replace("#", "");
    const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    return 0.2126 * srgb(parseInt(n.slice(0, 2), 16))
      + 0.7152 * srgb(parseInt(n.slice(2, 4), 16))
      + 0.0722 * srgb(parseInt(n.slice(4, 6), 16));
  };
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  check("embed schedule exposes a main landmark", embedPage.text.includes('<main class="embed-body"'));

  // Every agenda slot chip must declare its own background AND text colour, and
  // the pair must clear WCAG 4.5:1 for small text.
  const chipStyles = [...agendaPage.text.matchAll(/class="slot-block[^"]*"[^>]*style="([^"]*)"/g)]
    .map((m) => m[1].replace(/&quot;/g, '"'));
  check("agenda renders slot chips", chipStyles.length > 0, `found ${chipStyles.length}`);
  const badChips = chipStyles.filter((style) => {
    const bg = /background:\s*(#[0-9a-f]{3,6})/i.exec(style)?.[1];
    const fg = /(?:^|[;"\s])color:\s*(#[0-9a-f]{3,6})/i.exec(style)?.[1];
    return !bg || !fg || ratio(bg, fg) < 4.5;
  });
  check("every agenda slot chip clears 4.5:1 contrast", badChips.length === 0,
    badChips.join(" | ") || "none");

  // --- authorization ---
  // Must be a clean redirect, not a thrown 401 error page: the page's own data
  // read races the layout's requireSession(), so the read has to redirect too.
  const noSession = await fetch(`${BASE}/admin/abstracts`, { redirect: "manual" });
  check("unauthenticated admin page → 307 /login", noSession.status === 307, `got ${noSession.status}`);
  check("redirect points at /login", (noSession.headers.get("location") ?? "").includes("/login"), noSession.headers.get("location") ?? "none");

  // The signed session's role claim is NOT authoritative: getResolvedSession()
  // re-resolves the persisted EventMember role by email. So test with a user
  // whose DB membership is SPEAKER (sofia) — even a forged ADMIN claim in the
  // cookie must not grant access to an admin page.
  const speakerSess = { user: { id: "x", name: "Sofia Marques", email: "sofia@greenroom.demo" }, event: ev, role: "ADMIN" };
  const wrongRole = await fetch(`${BASE}/admin/agenda`, {
    headers: { cookie: cookie(speakerSess) },
    redirect: "manual",
  });
  check("speaker role blocked from /admin/agenda → 307", wrongRole.status === 307, `got ${wrongRole.status}`);
} catch (error) {
  check("smoke run completed", false, String(error));
} finally {
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n[smoke] ${passed}/${results.length} checks passed`);
  await cleanup();
  process.exit(results.every((r) => r.pass) && !cleanupFailed ? 0 : 1);
}
