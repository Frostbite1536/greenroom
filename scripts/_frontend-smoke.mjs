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
import { createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { SMOKE_SESSION_SECRET, cookieForSession } from "./_signed-session.mjs";

const prisma = new PrismaClient();
const EVENT_ID = "scratch-frontend";
const BLIND_SPEAKER_EMAIL = "blind-boundary@scratch.test";
const SECOND_EVALUATOR_EMAIL = "second-evaluator@scratch.test";
const C17_REVIEWER_EMAIL = "c17-reviewer@scratch.test";
// A second, deliberately empty event: the fresh-event empty states are the
// first thing a judge driving the product live will see, so they are asserted
// rather than assumed.
const FRESH_EVENT_ID = "scratch-frontend-fresh";
// S20 also needs an event-scoping boundary target. It is created only by this
// scratch fixture and deleted with the other disposable events.
const S20_OTHER_EVENT_ID = "scratch-frontend-s20-other";
// S2 creates a separate event with the same published form slug. It proves
// canonical public URLs remain event-scoped and the legacy slug route fails
// closed instead of choosing one candidate.
const S2_OTHER_EVENT_ID = "scratch-frontend-s2-other";
const PORT = process.env.SMOKE_PORT || "3222";
const BASE = `http://127.0.0.1:${PORT}`;
const REVIEWER_INVITE_APP_URL = "https://greenroom-hq.test";

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
const evaluatorTwo = { user: { id: "x", name: "Casey Morgan", email: SECOND_EVALUATOR_EMAIL }, event: ev, role: "EVALUATOR" };
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
  return { status: res.status, data, text, headers: res.headers };
}

async function reqManual(path, sess) {
  const res = await fetch(BASE + path, {
    headers: sess ? { cookie: cookie(sess) } : undefined,
    redirect: "manual",
  });
  return { status: res.status, location: res.headers.get("location") ?? "", text: await res.text() };
}

async function postManual(path, body, sess) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(sess ? { cookie: cookie(sess) } : {}) },
    body: JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (error) {
    console.warn("[smoke] postManual JSON parse failed", error instanceof Error ? error.name : "unknown");
    data = text;
  }
  return { status: res.status, data, location: res.headers.get("location") ?? "", headers: res.headers };
}

/** Scratch-only signing mirrors the forced-mock server secret; it is never logged. */
function reviewerInviteBearer(invite, nonce = "r".repeat(43)) {
  const exp = Math.floor(new Date(invite.expiresAt).getTime() / 1_000);
  const message = `greenroom:reviewer-invite:v1:${invite.id}:${invite.tokenVersion}:${exp}:${nonce}`;
  const signature = createHmac("sha256", SMOKE_SESSION_SECRET).update(message).digest("base64url");
  return `v1.${invite.id}.${invite.tokenVersion}.${exp}.${nonce}.${signature}`;
}

// ---- scratch fixture -------------------------------------------------------

async function resetScratch() {
  // Delete children first; the event cascade covers most, but be explicit.
  await prisma.event.deleteMany({ where: { id: { in: [EVENT_ID, FRESH_EVENT_ID, S20_OTHER_EVENT_ID, S2_OTHER_EVENT_ID] } } });
  await prisma.user.deleteMany({ where: { email: { in: [BLIND_SPEAKER_EMAIL, SECOND_EVALUATOR_EMAIL, C17_REVIEWER_EMAIL] } } });

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
    evaluatorTwo: [SECOND_EVALUATOR_EMAIL, "Casey Morgan"],
    speaker: ["sofia@greenroom.demo", "Sofia Marques"],
  })) {
    const role = key === "admin" ? "ADMIN" : key.startsWith("evaluator") ? "EVALUATOR" : "SPEAKER";
    const u = await prisma.user.upsert({ where: { email }, update: { name }, create: { email, name } });
    users[key] = u.id;
    await prisma.eventMember.upsert({
      where: { eventId_userId: { eventId: EVENT_ID, userId: u.id } },
      update: { role },
      create: { eventId: EVENT_ID, userId: u.id, role },
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
  await prisma.reviewAssignment.create({
    data: { planId: plan.id, abstractId: abstract.id, evaluatorId: users.evaluatorTwo, teamKey: "team-ai", status: "ASSIGNED" },
  });

  // C34: MAYBE remains historical setup coverage. Its existing admin review
  // stays scoreable, but it must never enter the new-assignment picker.
  const maybeSetupAbstract = await prisma.abstract.create({
    data: {
      eventId: EVENT_ID, formConfigId: form.id, submitterId: users.speaker,
      title: "Scratch: Maybe historical coverage", abstract: "More review is still useful.", format: "Talk",
      durationMinutes: 30, categoryId: category.id, status: "MAYBE",
      submittedAt: new Date(),
      speakers: { create: [{ userId: users.speaker, isPrimary: true }] },
    },
  });
  await prisma.reviewAssignment.create({
    data: {
      planId: plan.id, abstractId: maybeSetupAbstract.id, evaluatorId: users.admin,
      teamKey: "team-ai", status: "ASSIGNED",
    },
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

  return {
    event, form, abstract, maybeSetupAbstract, acceptedAbstract, plan, sessionA, sessionB,
    roomA, roomB, track, category, users, dayKey,
  };
}

// ---- checks ---------------------------------------------------------------

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${detail && !pass ? ` — ${detail}` : ""}`);
};

const server = spawn("npx", ["next", "start", "-p", PORT], {
  cwd: process.cwd(), shell: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, SESSION_SECRET: SMOKE_SESSION_SECRET, APP_URL: REVIEWER_INVITE_APP_URL },
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
      await prisma.event.deleteMany({ where: { id: { in: [EVENT_ID, FRESH_EVENT_ID, S20_OTHER_EVENT_ID, S2_OTHER_EVENT_ID] } } });
      await prisma.user.deleteMany({ where: { email: { in: [BLIND_SPEAKER_EMAIL, SECOND_EVALUATOR_EMAIL, C17_REVIEWER_EMAIL] } } });
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

  // --- S2: event-scoped public form resolution ----------------------------
  // Same form slugs are legitimate across events, so only the two-segment
  // route may resolve either. The old single-slug route must not pick one.
  const s2OtherEvent = await prisma.event.create({
    data: { id: S2_OTHER_EVENT_ID, name: "Scratch S2 Other", slug: S2_OTHER_EVENT_ID, timezone: "UTC" },
  });
  const s2OtherForm = await prisma.formConfig.create({
    data: {
      eventId: s2OtherEvent.id,
      name: "S2 Other CFP",
      slug: fx.form.slug,
      published: true,
      minSpeakers: 1,
      maxSpeakers: 1,
    },
  });
  const s2UniqueLegacyForm = await prisma.formConfig.create({
    data: {
      eventId: EVENT_ID,
      name: "S2 Unique Legacy CFP",
      slug: "s2-legacy-unique",
      published: true,
      minSpeakers: 1,
      maxSpeakers: 1,
    },
  });
  const s2UnpublishedForm = await prisma.formConfig.create({
    data: {
      eventId: EVENT_ID,
      name: "S2 Unpublished CFP",
      slug: "s2-unpublished",
      published: false,
      minSpeakers: 1,
      maxSpeakers: 1,
    },
  });
  const canonicalCfpPath = `/cfp/${EVENT_ID}/${fx.form.slug}`;
  const canonicalOtherCfpPath = `/cfp/${S2_OTHER_EVENT_ID}/${s2OtherForm.slug}`;

  // --- page renders ---
  for (const [name, path, sess] of [
    ["page /admin/forms", "/admin/forms", admin],
    ["page /admin/forms/[id]", `/admin/forms/${fx.form.id}`, admin],
    ["page /admin/abstracts", "/admin/abstracts", admin],
    ["page /admin/agenda", "/admin/agenda", admin],
    ["page /admin/evaluations (evaluator)", "/admin/evaluations", evaluator],
    ["page /cfp/[eventSlug]/[formSlug] (public)", canonicalCfpPath, null],
    ["page /embed/schedule (public)", `/embed/schedule?event=${EVENT_ID}`, null],
    ["page /admin/embeds", "/admin/embeds", admin],
    ["page /admin/settings", "/admin/settings", admin],
  ]) {
    const r = await req("GET", path, null, sess);
    check(`${name} → 200`, r.status === 200, `got ${r.status}`);
  }

  // --- real data actually rendered ---
  const formsPage = await req("GET", "/admin/forms", null, admin);
  check("forms page shows scratch form name", formsPage.text.includes("Scratch CFP"));

  const canonicalCfp = await req("GET", canonicalCfpPath, null, null);
  const canonicalOtherCfp = await req("GET", canonicalOtherCfpPath, null, null);
  const canonicalCfpApi = await req("GET", `/api/cfp/public/${EVENT_ID}/${fx.form.slug}`, null, null);
  const legacyByExactId = await reqManual(`/cfp/${fx.form.id}`, null);
  const legacyByUniqueSlug = await reqManual(`/cfp/${s2UniqueLegacyForm.slug}`, null);
  const ambiguousLegacySlug = await req("GET", `/cfp/${fx.form.slug}`, null, null);
  const unpublishedCanonical = await req("GET", `/cfp/${EVENT_ID}/${s2UnpublishedForm.slug}`, null, null);
  check("S2 canonical public URLs resolve same form slugs in their own events",
    canonicalCfp.status === 200
    && canonicalCfp.text.includes("Scratch CFP")
    && canonicalOtherCfp.status === 200
    && canonicalOtherCfp.text.includes("S2 Other CFP"));
  check("S2 canonical public API shares the event-scoped form resolution",
    canonicalCfpApi.status === 200 && canonicalCfpApi.data?.data?.id === fx.form.id);
  check("S2 legacy exact form ID redirects to its canonical public URL",
    legacyByExactId.status === 307 && legacyByExactId.location === canonicalCfpPath,
    `${legacyByExactId.status} ${legacyByExactId.location}`);
  check("S2 unique legacy slug redirects to its canonical public URL",
    legacyByUniqueSlug.status === 307
    && legacyByUniqueSlug.location === `/cfp/${EVENT_ID}/${s2UniqueLegacyForm.slug}`,
    `${legacyByUniqueSlug.status} ${legacyByUniqueSlug.location}`);
  check("S2 ambiguous legacy slug and unpublished canonical form fail closed",
    ambiguousLegacySlug.status === 404 && unpublishedCanonical.status === 404,
    `ambiguous ${ambiguousLegacySlug.status}; unpublished ${unpublishedCanonical.status}`);

  const absPage = await req("GET", "/admin/abstracts", null, admin);
  check("abstracts page shows seeded abstract", absPage.text.includes("Scratch: Agents in Production"));

  // --- M5: event identity and safe room settings --------------------------
  const settingsPage = await req("GET", "/admin/settings", null, admin);
  check("settings page explains the event essentials", settingsPage.text.includes("Event details") && settingsPage.text.includes("Tracks &amp; Categories"));
  check("settings page renders the event name and rooms", settingsPage.text.includes("Scratch Frontend") && settingsPage.text.includes("Hall A"));

  const settingsRead = await req("GET", "/api/admin/settings", null, admin);
  check("settings API returns only the active event", settingsRead.status === 200 && settingsRead.data?.data?.event?.id === EVENT_ID,
    `${settingsRead.status} ${JSON.stringify(settingsRead.data?.error ?? "")}`);
  check("settings API serializes local event dates", typeof settingsRead.data?.data?.event?.startsOn === "string" && typeof settingsRead.data?.data?.event?.endsOn === "string");
  check("settings API returns stable rooms, tracks, and categories",
    settingsRead.data?.data?.rooms?.map((room) => room.name).join(",") === "Hall A,Hall B"
    && settingsRead.data?.data?.tracks?.map((track) => track.name).join(",") === "Mainstage"
    && settingsRead.data?.data?.categories?.map((category) => category.name).join(",") === "Applied AI");

  const originalSettingsEvent = settingsRead.data?.data?.event;
  const settingsNameUpdate = await req("PATCH", "/api/admin/settings", {
    name: "Scratch Frontend Settings",
  }, admin);
  check("name-only settings PATCH preserves timezone and local dates",
    settingsNameUpdate.status === 200
    && settingsNameUpdate.data?.data?.event?.name === "Scratch Frontend Settings"
    && settingsNameUpdate.data?.data?.event?.timezone === originalSettingsEvent?.timezone
    && settingsNameUpdate.data?.data?.event?.startsOn === originalSettingsEvent?.startsOn
    && settingsNameUpdate.data?.data?.event?.endsOn === originalSettingsEvent?.endsOn,
    `${settingsNameUpdate.status} ${JSON.stringify(settingsNameUpdate.data?.error ?? "")}`);

  const settingsTimezoneUpdate = await req("PATCH", "/api/admin/settings", {
    timezone: "America/Denver",
  }, admin);
  check("timezone-only settings PATCH preserves concurrent name and local dates",
    settingsTimezoneUpdate.status === 200
    && settingsTimezoneUpdate.data?.data?.event?.name === "Scratch Frontend Settings"
    && settingsTimezoneUpdate.data?.data?.event?.timezone === "America/Denver"
    && settingsTimezoneUpdate.data?.data?.event?.startsOn === originalSettingsEvent?.startsOn
    && settingsTimezoneUpdate.data?.data?.event?.endsOn === originalSettingsEvent?.endsOn,
    `${settingsTimezoneUpdate.status} ${JSON.stringify(settingsTimezoneUpdate.data?.error ?? "")}`);

  const settingsDateUpdate = await req("PATCH", "/api/admin/settings", {
    startsOn: "2032-05-12", endsOn: "2032-05-14",
  }, admin);
  check("paired event-date PATCH preserves concurrent name and timezone",
    settingsDateUpdate.status === 200
    && settingsDateUpdate.data?.data?.event?.name === "Scratch Frontend Settings"
    && settingsDateUpdate.data?.data?.event?.timezone === "America/Denver"
    && settingsDateUpdate.data?.data?.event?.startsOn === "2032-05-12"
    && settingsDateUpdate.data?.data?.event?.endsOn === "2032-05-14",
    `${settingsDateUpdate.status} ${JSON.stringify(settingsDateUpdate.data?.error ?? "")}`);

  const settingsRoom = await req("POST", "/api/admin/settings/rooms", {
    name: "Settings Studio", capacity: 85,
  }, admin);
  const settingsRoomId = settingsRoom.data?.data?.room?.id;
  check("settings API adds a room", settingsRoom.status === 201 && Boolean(settingsRoomId),
    `${settingsRoom.status} ${JSON.stringify(settingsRoom.data?.error ?? "")}`);

  const settingsRoomUpdate = await req("PATCH", "/api/admin/settings/rooms", {
    id: settingsRoomId, name: "Settings Studio West", capacity: 90,
  }, admin);
  check("settings API updates a room", settingsRoomUpdate.status === 200 && settingsRoomUpdate.data?.data?.room?.name === "Settings Studio West",
    `${settingsRoomUpdate.status} ${JSON.stringify(settingsRoomUpdate.data?.error ?? "")}`);

  const usedRoomDelete = await req("DELETE", `/api/admin/settings/rooms?roomId=${fx.roomA.id}`, null, admin);
  check("settings API refuses to remove a scheduled room with guidance",
    usedRoomDelete.status === 409
    && usedRoomDelete.data?.error?.code === "ROOM_IN_USE"
    && /move or unschedule/i.test(usedRoomDelete.data?.error?.message ?? ""),
    `${usedRoomDelete.status} ${JSON.stringify(usedRoomDelete.data?.error ?? "")}`);
  const unusedRoomDelete = await req("DELETE", `/api/admin/settings/rooms?roomId=${settingsRoomId}`, null, admin);
  check("settings API removes an unused room", unusedRoomDelete.status === 200 && unusedRoomDelete.data?.data?.room?.id === settingsRoomId,
    `${unusedRoomDelete.status} ${JSON.stringify(unusedRoomDelete.data?.error ?? "")}`);

  const settingsCategory = await req("POST", "/api/cfp/categories", {
    eventId: EVENT_ID, name: "Settings category", description: "Made from event settings", sortOrder: 0,
  }, admin);
  check("settings category action uses the existing authorized route", settingsCategory.status === 201 && settingsCategory.data?.data?.name === "Settings category",
    `${settingsCategory.status} ${JSON.stringify(settingsCategory.data?.error ?? "")}`);

  const agendaPage = await req("GET", "/admin/agenda", null, admin);
  check("agenda shows scheduled session", agendaPage.text.includes("Scratch Session A"));
  check("agenda shows unscheduled backlog", agendaPage.text.includes("Scratch Session B"));
  check("agenda offers day, week, tracks and conflicts views",
    ["Day", "Week", "Tracks", "Conflicts"].every((t) => agendaPage.text.includes(t)));
  // Drag-and-drop itself needs a browser; these assert the affordance ships and
  // the underlying move is the same POST /api/agenda/slots covered below.
  check("day grid renders draggable slot blocks", agendaPage.text.includes('draggable="true"'));
  check("day grid explains the drag affordance", agendaPage.text.includes("Drag a session to another room or time"));

  const cfpPage = await req("GET", canonicalCfpPath, null, null);
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
  check("builder surfaces the new form's canonical event-scoped public URL",
    builderPage.text.includes(`/cfp/${EVENT_ID}/scratch-new-form`));

  const listAfterCreate = await req("GET", "/admin/forms", null, admin);
  check("forms list shows the new form", listAfterCreate.text.includes("Scratch New Form"));
  check("forms list offers the New form action", listAfterCreate.text.includes("New form"));

  // Unpublished forms must stay invisible publicly until the builder publishes.
  const unpublishedPublic = await req("GET", `/cfp/${EVENT_ID}/scratch-new-form`, null, null);
  check("unpublished new form is not public yet → 404", unpublishedPublic.status === 404, `got ${unpublishedPublic.status}`);

  // A duplicate slug must not silently create a second form.
  const duplicate = await req("POST", "/api/cfp/forms", createdPayload, admin);
  check("duplicate slug is rejected", duplicate.status >= 400,
    `got ${duplicate.status} ${duplicate.data?.error?.code ?? ""}`);
  // Documented so the dialog's fallback copy stays honest: the API surfaces the
  // unique (eventId, slug) violation as a generic error, so NewFormDialog
  // pre-checks slugs client-side. Backend: a 409 FORM_SLUG_TAKEN would be nicer.
  console.log(`  note duplicate-slug response: ${duplicate.status} ${duplicate.data?.error?.code ?? "?"}`);

  // --- S7: resumable CFP draft capability and revision flow ---------------
  // This mirrors the public form's body-only recovery contract. The raw
  // capability appears exactly once at draft creation, then stays local to the
  // browser/recovery body while revisions advance.
  const recoveryDraftInput = {
    formConfigId: fx.form.id,
    title: "Smoke recovery draft",
    abstract: "Draft body",
    format: "Talk",
    durationMinutes: 30,
    categoryId: fx.category.id,
    speakers: [{ email: "smoke.speaker@example.com", name: "Smoke Speaker", isPrimary: true }],
    answers: { audience_level: "beginner", learning_objectives: "" },
    intent: "saveDraft",
  };
  const draft = await req("POST", "/api/cfp/submissions", recoveryDraftInput, null);
  const draftId = draft.data?.data?.id;
  const draftCapability = draft.data?.data?.draftCapability;
  check("S7 CFP save draft issues one capability at revision 1 → 201",
    draft.status === 201
      && draft.data?.data?.status === "DRAFT"
      && typeof draftCapability === "string"
      && /^[A-Za-z0-9_-]{43}$/.test(draftCapability)
      && draft.data?.data?.draftRevision === 1,
    `${draft.status}/${typeof draftCapability}/${draft.data?.data?.draftRevision}`);

  const resume = await req("POST", "/api/cfp/submissions/resume", {
    formConfigId: fx.form.id, abstractId: draftId, draftCapability,
  }, null);
  check("S7 body-only resume is no-store and returns editable draft state",
    resume.status === 200
      && resume.headers.get("cache-control") === "no-store"
      && resume.data?.data?.id === draftId
      && resume.data?.data?.draftRevision === 1
      && resume.data?.data?.title === recoveryDraftInput.title,
    `${resume.status}/${resume.headers.get("cache-control") ?? "none"}`);

  const savedDraft = await req("POST", "/api/cfp/submissions", {
    ...recoveryDraftInput,
    abstractId: draftId,
    draftCapability,
    expectedDraftRevision: 1,
    title: "Smoke recovery draft, saved",
  }, null);
  check("S7 save advances revision without reissuing the capability",
    savedDraft.status === 200
      && savedDraft.data?.data?.draftRevision === 2
      && !("draftCapability" in (savedDraft.data?.data ?? {})),
    `${savedDraft.status}/${savedDraft.data?.data?.draftRevision}`);

  const invalidResume = await req("POST", "/api/cfp/submissions/resume", {
    formConfigId: fx.form.id, abstractId: draftId, draftCapability: "x".repeat(43),
  }, null);
  const crossFormResume = await req("POST", "/api/cfp/submissions/resume", {
    formConfigId: newFormId, abstractId: draftId, draftCapability,
  }, null);
  const staleSave = await req("POST", "/api/cfp/submissions", {
    ...recoveryDraftInput,
    abstractId: draftId,
    draftCapability,
    expectedDraftRevision: 1,
  }, null);
  check("S7 invalid and cross-form resume fail closed with one generic 404",
    invalidResume.status === 404 && invalidResume.data?.error?.code === "DRAFT_NOT_FOUND"
      && crossFormResume.status === 404 && crossFormResume.data?.error?.code === "DRAFT_NOT_FOUND",
    `${invalidResume.status}/${crossFormResume.status}`);
  check("S7 stale revision returns 409 for an explicit reload choice",
    staleSave.status === 409 && staleSave.data?.error?.code === "DRAFT_CONFLICT",
    `${staleSave.status}/${staleSave.data?.error?.code ?? ""}`);

  const recoveredSubmit = await req("POST", "/api/cfp/submissions", {
    ...recoveryDraftInput,
    abstractId: draftId,
    draftCapability,
    expectedDraftRevision: 2,
    title: "Smoke recovered submission",
    abstract: "Full body",
    speakers: [
      { email: "smoke.speaker@example.com", name: "Smoke Speaker", isPrimary: true },
      { email: "smoke.cospeaker@example.com", name: "Smoke Co", isPrimary: false },
    ],
    answers: { audience_level: "beginner", learning_objectives: "Three takeaways." },
    intent: "submit",
  }, null);
  const revokedResume = await req("POST", "/api/cfp/submissions/resume", {
    formConfigId: fx.form.id, abstractId: draftId, draftCapability,
  }, null);
  check("S7 submit revokes recovery and a replay is unavailable",
    recoveredSubmit.status === 200
      && recoveredSubmit.data?.data?.status === "SUBMITTED"
      && !("draftCapability" in (recoveredSubmit.data?.data ?? {}))
      && revokedResume.status === 404
      && revokedResume.data?.error?.code === "DRAFT_NOT_FOUND",
    `${recoveredSubmit.status}/${revokedResume.status}`);

  // Existing direct public submit remains a capability-free golden path.
  const submit = await req("POST", "/api/cfp/submissions", {
    formConfigId: fx.form.id,
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
  check("CFP direct submit remains capability-free → 201", submit.status === 201, `${submit.status} ${JSON.stringify(submit.data?.error ?? "")}`);
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

  // M4: MAYBE is a pre-confirmation review state. It never provisions a
  // Session, but it remains available for an unconfirmed proposal.
  const maybeSubmit = await req("POST", "/api/cfp/submissions", {
    formConfigId: fx.form.id,
    title: "Scratch: Maybe before confirmation",
    abstract: "A proposal deliberately held for more review.",
    format: "Talk",
    durationMinutes: 30,
    categoryId: fx.category.id,
    speakers: [{ email: "maybe.speaker@example.com", name: "Maybe Speaker", isPrimary: true }],
    answers: { audience_level: "beginner", learning_objectives: "One more review pass." },
    intent: "submit",
  }, null);
  const maybeAbstractId = maybeSubmit.data?.data?.id;
  check("M4 creates an unconfirmed proposal for Maybe", maybeSubmit.status === 201 && Boolean(maybeAbstractId),
    `${maybeSubmit.status} ${JSON.stringify(maybeSubmit.data?.error ?? "")}`);
  const maybe = await req("POST", "/api/evaluations/decisions", {
    abstractId: maybeAbstractId, decision: "MAYBE",
  }, admin);
  check("maybe decision → 200", maybe.status === 200,
    `${maybe.status} ${JSON.stringify(maybe.data?.error ?? "")}`);
  check("unconfirmed maybe remains non-final and creates no talk",
    maybe.data?.data?.status === "MAYBE"
    && maybe.data?.data?.decidedAt === null
    && maybe.data?.data?.sessionCreated === false
    && maybe.data?.data?.tasksAssigned === 0
    && maybe.data?.data?.session === null,
    JSON.stringify(maybe.data?.data ?? {}));
  check("unconfirmed maybe never provisions a session",
    (await prisma.session.count({ where: { sourceAbstractId: maybeAbstractId } })) === 0);

  const afterMaybe = await req("GET", "/admin/abstracts", null, admin);
  check("pipeline renders a Maybe status pill",
    /class="pill warn">Maybe<\/span>/.test(afterMaybe.text));
  check("Maybe status filter exposes its pressed state",
    /aria-pressed="false"[^>]*>Maybe(?:<!-- -->)? <span class="count">2<\/span>/.test(afterMaybe.text));
  check("unconfirmed maybe is not presented as a programme mismatch",
    !afterMaybe.text.includes("Still on the programme"));

  // A confirmed Session is programme truth: the API blocks MAYBE and the UI
  // exposes the same unavailable action state to assistive technology.
  const confirmedMaybe = await req("POST", "/api/evaluations/decisions", {
    abstractId: convertedAbstractId, decision: "MAYBE",
  }, admin);
  check("confirmed proposal refuses Maybe → 409 MAYBE_NOT_AVAILABLE",
    confirmedMaybe.status === 409 && confirmedMaybe.data?.error?.code === "MAYBE_NOT_AVAILABLE",
    `${confirmedMaybe.status} ${JSON.stringify(confirmedMaybe.data?.error ?? "")}`);
  check("confirmed proposal UI has no Maybe action",
    afterMaybe.text.includes("Maybe is unavailable because this talk is confirmed."));

  // The table's accessible row text is useful, but the decision controls live
  // in a client drawer. Open its server-rendered deep-link states so this
  // smoke proves the confirmed drawer itself retains the legal choices only.
  const confirmedDrawer = await req("GET", `/admin/abstracts?abstractId=${encodeURIComponent(convertedAbstractId)}`, null, admin);
  const confirmedDecisionDrawer = await req("GET", `/admin/abstracts?abstractId=${encodeURIComponent(convertedAbstractId)}&mode=decide`, null, admin);
  const drawerButtons = (html) => {
    const drawerIndex = html.indexOf('role="dialog"');
    if (drawerIndex === -1) return [];
    const drawer = html.slice(drawerIndex);
    return [...drawer.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)]
      .map((match) => match[1].replace(/<[^>]+>/g, "").replace(/&[^;]+;/g, "").trim());
  };
  const normalDrawerButtons = drawerButtons(confirmedDrawer.text);
  const decisionDrawerButtons = drawerButtons(confirmedDecisionDrawer.text);
  check("confirmed proposal drawer renders its normal change-decision control",
    confirmedDrawer.status === 200 && normalDrawerButtons.includes("Change decision"));
  check("confirmed proposal decision drawer keeps Accept and Decline but omits Maybe",
    confirmedDecisionDrawer.status === 200
    && decisionDrawerButtons.includes("Accept")
    && decisionDrawerButtons.includes("Decline")
    && !decisionDrawerButtons.includes("Maybe"),
    JSON.stringify(decisionDrawerButtons));

  // The W2 safeguard remains for the final decision that can legally change a
  // confirmed proposal: declining it does not delete the existing Session.
  const reverse = await req("POST", "/api/evaluations/decisions", {
    abstractId: convertedAbstractId, decision: "REJECTED",
  }, admin);
  check("a confirmed proposal can later be declined → 200", reverse.status === 200,
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

  const scoreOmission = await req("POST", "/api/evaluations/scores", {
    planId: fx.plan.id,
    abstractId: fx.abstract.id,
    scores: [
      { rubricKey: "relevance", score: 4 },
      { rubricKey: "clarity", score: 5 },
    ],
    complete: true,
  }, evaluator);
  check("omitted review comment preserves the saved note", scoreOmission.status === 200
    && (await prisma.reviewScore.findUnique({
      where: { planId_abstractId_evaluatorId_rubricKey: { planId: fx.plan.id, abstractId: fx.abstract.id, evaluatorId: fx.users.evaluator, rubricKey: "relevance" } },
      select: { comment: true },
    }))?.comment === "Strong.");

  const textareaValue = (html) => html.match(/<textarea\b[^>]*name="reviewComment"[^>]*>([\s\S]*?)<\/textarea>/)?.[1] ?? null;
  const reviewNotesSection = (html) => {
    const start = html.indexOf('<section class="review-notes"');
    if (start === -1) return null;
    const end = html.indexOf("</section>", start);
    return end === -1 ? null : html.slice(start, end + "</section>".length);
  };
  const renderedText = (html) => html
    ?.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&[^;]+;/g, "")
    .trim() ?? null;
  const evaluatorCommentPage = await req("GET", "/admin/evaluations", null, evaluator);
  check("evaluator textarea pre-fills the recovered own comment",
    evaluatorCommentPage.status === 200 && textareaValue(evaluatorCommentPage.text) === "Strong.");

  const organizerCommentDrawer = await req("GET", `/admin/abstracts?abstractId=${encodeURIComponent(fx.abstract.id)}`, null, admin);
  const organizerReviewNotes = reviewNotesSection(organizerCommentDrawer.text);
  const organizerReviewNotesText = renderedText(organizerReviewNotes);
  check("organizer drawer renders a de-identified review block",
    organizerCommentDrawer.status === 200
    && organizerReviewNotesText?.includes("Review notes")
    && organizerReviewNotesText.includes("Review 1")
    && organizerReviewNotesText.includes("Strong.")
    && !organizerReviewNotesText.includes("Ravi Patel"));
  const scoreClear = await req("POST", "/api/evaluations/scores", {
    planId: fx.plan.id,
    abstractId: fx.abstract.id,
    scores: [
      { rubricKey: "relevance", score: 4, comment: null },
      { rubricKey: "clarity", score: 5 },
    ],
    complete: true,
  }, evaluator);
  check("explicit null clears the evaluator review comment", scoreClear.status === 200
    && (await prisma.reviewScore.count({
      where: { planId: fx.plan.id, abstractId: fx.abstract.id, evaluatorId: fx.users.evaluator, comment: { not: null } },
    })) === 0);

  // Simulate a pre-C5 evaluator review with divergent criterion comments. The
  // organizer must keep both texts in one de-identified review block, while a
  // normal second evaluator remains a separate block.
  await prisma.reviewScore.update({
    where: { planId_abstractId_evaluatorId_rubricKey: { planId: fx.plan.id, abstractId: fx.abstract.id, evaluatorId: fx.users.evaluator, rubricKey: "relevance" } },
    data: { comment: "Legacy first note" },
  });
  await prisma.reviewScore.update({
    where: { planId_abstractId_evaluatorId_rubricKey: { planId: fx.plan.id, abstractId: fx.abstract.id, evaluatorId: fx.users.evaluator, rubricKey: "clarity" } },
    data: { comment: "Legacy second note" },
  });
  const secondReviewerScore = await req("POST", "/api/evaluations/scores", {
    planId: fx.plan.id,
    abstractId: fx.abstract.id,
    scores: [
      { rubricKey: "relevance", score: 3, comment: "Second review note" },
      { rubricKey: "clarity", score: 3 },
    ],
    complete: true,
  }, evaluatorTwo);
  check("second evaluator review submission → 200", secondReviewerScore.status === 200,
    `${secondReviewerScore.status} ${JSON.stringify(secondReviewerScore.data?.error ?? "")}`);

  const groupedOrganizerDrawer = await req("GET", `/admin/abstracts?abstractId=${encodeURIComponent(fx.abstract.id)}`, null, admin);
  const groupedOrganizerReviewNotes = reviewNotesSection(groupedOrganizerDrawer.text);
  const groupedOrganizerReviewNotesText = renderedText(groupedOrganizerReviewNotes);
  check("organizer drawer groups legacy texts by de-identified review",
    groupedOrganizerDrawer.status === 200
    && groupedOrganizerReviewNotesText?.includes("Review 1")
    && groupedOrganizerReviewNotesText.includes("Review 2")
    && groupedOrganizerReviewNotesText.includes("Legacy first note")
    && groupedOrganizerReviewNotesText.includes("Legacy second note")
    && groupedOrganizerReviewNotesText.includes("Second review note")
    && !groupedOrganizerReviewNotesText.includes("Ravi Patel")
    && !groupedOrganizerReviewNotesText.includes("Casey Morgan"));
  const recoveredEvaluatorPage = await req("GET", "/admin/evaluations", null, evaluator);
  check("evaluator textarea recovers the evaluator-owned legacy comment",
    textareaValue(recoveredEvaluatorPage.text) === "Legacy first note");
  const evaluatorAbstractRedirect = await reqManual(
    `/admin/abstracts?abstractId=${encodeURIComponent(fx.abstract.id)}`,
    evaluator,
  );
  check("evaluator is redirected from the global abstracts pipeline before its drawer renders",
    evaluatorAbstractRedirect.status === 307
    && evaluatorAbstractRedirect.location.includes("/admin/evaluations")
    && !evaluatorAbstractRedirect.text.includes("Legacy first note"));

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
  check("admin nav shows event settings", adminNav.text.includes("/admin/settings"));
  check("admin nav shows speaker onboarding",
    adminNav.text.includes("/admin/speakers") && adminNav.text.includes("Speaker onboarding"));

  const speakerNav = await req("GET", "/portal", null, speaker);
  check("speaker portal renders → 200", speakerNav.status === 200, `got ${speakerNav.status}`);
  check("speaker nav hides admin-only links",
    !speakerNav.text.includes("/admin/forms") && !speakerNav.text.includes("/admin/agenda")
    && !speakerNav.text.includes("/admin/speakers") && !speakerNav.text.includes("/admin/settings"));
  check("speaker nav keeps portal + public links",
    speakerNav.text.includes("/portal") && speakerNav.text.includes("/embed/schedule"));

  const evaluatorNav = await req("GET", "/admin/evaluations", null, evaluator);
  check("evaluator nav hides CFP forms, agenda and speaker onboarding",
    !evaluatorNav.text.includes("/admin/forms") && !evaluatorNav.text.includes("/admin/agenda")
    && !evaluatorNav.text.includes("/admin/speakers") && !evaluatorNav.text.includes("/admin/settings"));
  check("evaluator nav keeps evaluations and omits the global abstracts pipeline",
    evaluatorNav.text.includes("/admin/evaluations") && !evaluatorNav.text.includes("/admin/abstracts"));

  // --- F2: admin evaluation setup panel -----------------------------------
  const setupPage = await req("GET", "/admin/evaluations", null, admin);
  check("admin evaluations page → 200", setupPage.status === 200, `got ${setupPage.status}`);
  check("admin sees the round list", setupPage.text.includes("Review rounds"));
  check("admin sees the assignment panel", setupPage.text.includes("Assign proposals to reviewers"));
  check("admin sees review coverage", setupPage.text.includes("Review coverage"));
  check("reviewer picker lists a real event evaluator", setupPage.text.includes("Ravi Patel"));
  check("admin-only reviewer setup includes the contact data needed for resends",
    setupPage.text.includes("ravi@greenroom.demo"));
  const proposalPickerStart = setupPage.text.indexOf('<section aria-labelledby="pick-proposals"');
  const proposalPickerEnd = setupPage.text.indexOf('<section aria-labelledby="pick-reviewers"');
  const proposalPicker = proposalPickerStart === -1 || proposalPickerEnd === -1
    ? ""
    : setupPage.text.slice(proposalPickerStart, proposalPickerEnd);
  const setupTableRow = (title) => {
    const titleIndex = setupPage.text.indexOf(title);
    if (titleIndex === -1) return "";
    const start = setupPage.text.lastIndexOf("<tr", titleIndex);
    const end = setupPage.text.indexOf("</tr>", titleIndex);
    return start === -1 || end === -1 ? "" : setupPage.text.slice(start, end + "</tr>".length);
  };
  const maybeSetupRow = setupTableRow(fx.maybeSetupAbstract.title);
  check("C34 MAYBE stays in historical coverage with its existing assignment count",
    renderedText(maybeSetupRow)?.includes("Maybe")
    && renderedText(maybeSetupRow)?.includes("0/1"));
  check("C34 MAYBE has no new-assignment checkbox or row action",
    !proposalPicker.includes(fx.maybeSetupAbstract.title)
    && !maybeSetupRow.includes("<input")
    && !maybeSetupRow.includes("<button"));
  check("C34 keeps under-review proposals in the assignment picker",
    proposalPicker.includes(fx.abstract.title) && proposalPicker.includes('name="proposalIds"'));

  const maybeExistingScore = await req("POST", "/api/evaluations/scores", {
    planId: fx.plan.id,
    abstractId: fx.maybeSetupAbstract.id,
    scores: [
      { rubricKey: "relevance", score: 4 },
      { rubricKey: "clarity", score: 4 },
    ],
    complete: true,
  }, admin);
  check("C34 existing MAYBE assignment remains scoreable → 200", maybeExistingScore.status === 200,
    `${maybeExistingScore.status} ${JSON.stringify(maybeExistingScore.data?.error ?? "")}`);
  const maybeNewAssignment = await req("POST", "/api/evaluations/assignments", {
    planId: fx.plan.id,
    abstractIds: [fx.maybeSetupAbstract.id],
    evaluatorIds: [fx.users.evaluatorTwo],
  }, admin);
  check("C34 assignment route refuses a new MAYBE assignment → 409",
    maybeNewAssignment.status === 409 && maybeNewAssignment.data?.error?.code === "ABSTRACT_NOT_REVIEWABLE",
    `${maybeNewAssignment.status} ${JSON.stringify(maybeNewAssignment.data?.error ?? "")}`);
  const setupAfterMaybeScore = await req("GET", "/admin/evaluations", null, admin);
  const scoredMaybeTitleIndex = setupAfterMaybeScore.text.indexOf(fx.maybeSetupAbstract.title);
  const scoredMaybeRow = scoredMaybeTitleIndex === -1
    ? ""
    : setupAfterMaybeScore.text.slice(
      setupAfterMaybeScore.text.lastIndexOf("<tr", scoredMaybeTitleIndex),
      setupAfterMaybeScore.text.indexOf("</tr>", scoredMaybeTitleIndex) + "</tr>".length,
    );
  check("C34 MAYBE coverage preserves completed review counts", renderedText(scoredMaybeRow)?.includes("1/1"));

  // Role-aware: an evaluator must get the scoring queue, never the setup panel.
  const evaluatorEval = await req("GET", "/admin/evaluations", null, evaluator);
  check("evaluator does NOT see the setup panel",
    !evaluatorEval.text.includes("Assign proposals to reviewers")
    && !evaluatorEval.text.includes("Review coverage")
    && !evaluatorEval.text.includes("ravi@greenroom.demo"));

  // Fresh event: the empty states must tell the admin what to do next.
  const freshAdmin = { ...admin, event: { id: FRESH_EVENT_ID, name: "Scratch Fresh", slug: FRESH_EVENT_ID } };
  const freshPage = await req("GET", "/admin/evaluations", null, freshAdmin);
  check("fresh event evaluations page → 200", freshPage.status === 200, `got ${freshPage.status}`);
  check("fresh event offers an actionable first step",
    freshPage.text.includes("No review round yet")
    && freshPage.text.includes("Create the first round")
    && freshPage.text.includes("Invite a reviewer")
    && freshPage.text.includes('name="reviewerEmail"'));
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

  // --- C17: event-scoped reviewer invitations -----------------------------
  // This fresh identity is provisioned through the ADMIN route, so the UI must
  // present its token-free lifecycle without hiding a pending reviewer from
  // assignment selection.
  const c17Invite = await req("POST", "/api/evaluations/reviewer-invites", {
    email: C17_REVIEWER_EMAIL, name: "C17 Pending Reviewer",
  }, admin);
  const c17Reviewer = await prisma.user.findUnique({
    where: { email: C17_REVIEWER_EMAIL }, select: { id: true },
  });
  const c17StoredInvite = c17Reviewer
    ? await prisma.reviewerInvite.findUnique({
      where: { eventId_userId: { eventId: EVENT_ID, userId: c17Reviewer.id } },
      select: { id: true, tokenVersion: true, expiresAt: true },
    })
    : null;
  check("C17 invite response is token-free and includes active access plus resend availability",
    c17Invite.status === 200
    && c17Invite.data?.data?.state === "invited"
    && c17Invite.data?.data?.access === "active"
    && typeof c17Invite.data?.data?.resendAvailableAt === "string"
    && !JSON.stringify(c17Invite.data).includes("draftCapability")
    && !Object.prototype.hasOwnProperty.call(c17Invite.data?.data ?? {}, "token"),
    `${c17Invite.status}/${c17Invite.data?.data?.state ?? "?"}`);

  const c17Setup = await req("GET", "/admin/evaluations", null, admin);
  const c17ReviewerMarkup = c17Setup.text.slice(
    Math.max(0, c17Setup.text.indexOf(C17_REVIEWER_EMAIL) - 700),
    c17Setup.text.indexOf(C17_REVIEWER_EMAIL) + 900,
  );
  check("C17 admin setup renders the compact invite form and a pending selectable reviewer",
    c17Setup.status === 200
    && c17Setup.text.includes("Invite a reviewer")
    && c17Setup.text.includes('name="reviewerName"')
    && c17Setup.text.includes('name="reviewerEmail"')
    && c17ReviewerMarkup.includes("Invitation pending acceptance")
    && c17ReviewerMarkup.includes('name="reviewerIds"')
    && !/name="reviewerIds"[^>]*disabled/.test(c17ReviewerMarkup));

  const c17Evaluators = await req("GET", "/api/evaluations/evaluators", null, admin);
  check("C17 admin evaluator projection exposes lifecycle metadata but no bearer",
    c17Evaluators.status === 200
    && c17Evaluators.data?.data?.some((row) => row.email === C17_REVIEWER_EMAIL
      && row.access === "active"
      && row.invite?.state === "pending"
      && typeof row.invite?.resendAvailableAt === "string"
      && !Object.prototype.hasOwnProperty.call(row.invite, "token"))
    && !JSON.stringify(c17Evaluators.data).includes("draftCapability"));

  const c17Cooldown = await req("POST", "/api/evaluations/reviewer-invites", {
    email: C17_REVIEWER_EMAIL, name: "C17 Pending Reviewer", resend: true,
  }, admin);
  const c17SpeakerConflict = await req("POST", "/api/evaluations/reviewer-invites", {
    email: speaker.user.email, name: "Do not overwrite", resend: false,
  }, admin);
  check("C17 resend cooldown and speaker-role conflict remain actionable server authority",
    c17Cooldown.status === 429 && c17Cooldown.data?.error?.code === "INVITE_RESEND_COOLDOWN"
    && c17SpeakerConflict.status === 409 && c17SpeakerConflict.data?.error?.code === "REVIEWER_ROLE_CONFLICT",
    `${c17Cooldown.status}/${c17SpeakerConflict.status}`);

  const c17AssignmentAbstract = await prisma.abstract.create({
    data: {
      eventId: EVENT_ID, formConfigId: fx.form.id, submitterId: fx.users.speaker,
      title: "Scratch: Pending reviewer can be assigned", abstract: "C17 assignment boundary.",
      format: "Talk", durationMinutes: 30, categoryId: fx.category.id, status: "SUBMITTED",
      submittedAt: new Date(), speakers: { create: [{ userId: fx.users.speaker, isPrimary: true }] },
    },
  });
  const c17PendingAssignment = await req("POST", "/api/evaluations/assignments", {
    planId: fx.plan.id, abstractIds: [c17AssignmentAbstract.id], evaluatorIds: c17Reviewer ? [c17Reviewer.id] : [],
  }, admin);
  check("C17 pending reviewer membership is assignment-eligible → 201", c17PendingAssignment.status === 201,
    `${c17PendingAssignment.status} ${c17PendingAssignment.data?.error?.code ?? ""}`);

  const c17PublicInvite = await req("GET", "/reviewer-invite", null, null);
  check("C17 public invite page projects no event, reviewer, or bearer data",
    c17PublicInvite.status === 200
    && c17PublicInvite.text.includes("Reviewer invitation")
    && !c17PublicInvite.text.includes(EVENT_ID)
    && !c17PublicInvite.text.includes(C17_REVIEWER_EMAIL));

  const c17Token = c17StoredInvite ? reviewerInviteBearer(c17StoredInvite) : "";
  const c17Accept = await postManual("/api/auth/reviewer-invites/accept", { token: c17Token }, null);
  const c17Replay = await postManual("/api/auth/reviewer-invites/accept", { token: c17Token }, null);
  check("C17 accept uses the protected no-store 303 and a replay stays generic",
    c17Accept.status === 303
    && c17Accept.location === `${REVIEWER_INVITE_APP_URL}/admin/evaluations`
    && c17Accept.headers.get("cache-control") === "no-store"
    && c17Accept.headers.get("referrer-policy") === "no-referrer"
    && (c17Accept.headers.get("set-cookie") ?? "").includes("sb_session=")
    && c17Replay.status === 404 && c17Replay.data?.error?.code === "INVITE_NOT_FOUND",
    `${c17Accept.status}/${c17Replay.status}`);

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
  const setupWithSubmitted = await req("GET", "/admin/evaluations", null, admin);
  const submittedPickerStart = setupWithSubmitted.text.indexOf('<section aria-labelledby="pick-proposals"');
  const submittedPickerEnd = setupWithSubmitted.text.indexOf('<section aria-labelledby="pick-reviewers"');
  const submittedPicker = submittedPickerStart === -1 || submittedPickerEnd === -1
    ? ""
    : setupWithSubmitted.text.slice(submittedPickerStart, submittedPickerEnd);
  check("C34 keeps submitted proposals in the assignment picker",
    submittedPicker.includes(setupAbstract.title) && submittedPicker.includes('name="proposalIds"'));
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

  // --- C15: the global proposal pipeline is ADMIN-only -------------------
  // An evaluator receives a server redirect before any proposal RSC data can
  // render. Their one allowed review surface is still assignment-scoped.
  const evaluatorPipeline = await reqManual("/admin/abstracts", evaluator);
  check("evaluator global abstracts route redirects to the assignment workspace",
    evaluatorPipeline.status === 307 && evaluatorPipeline.location.includes("/admin/evaluations"));
  const evaluatorSubmissions = await req("GET", "/api/cfp/submissions", null, evaluator);
  check("evaluator global submissions API is forbidden → 403",
    evaluatorSubmissions.status === 403 && !evaluatorSubmissions.text.includes("Scratch: Agents in Production"));

  // Blind policy remains attached to the evaluator's assigned plan. This queue
  // must not expose the speaker, email, custom CFP answers, organizer notes,
  // global score summaries, or a proposal assigned only to another evaluator.
  const audienceFieldId = fx.form.fields.find((field) => field.key === "audience_level")?.id;
  if (!audienceFieldId) throw new Error("C15 fixture requires the audience-level form field");
  await prisma.formAnswer.upsert({
    where: { abstractId_formFieldId: { abstractId: fx.abstract.id, formFieldId: audienceFieldId } },
    update: { value: "advanced" },
    create: { abstractId: fx.abstract.id, formFieldId: audienceFieldId, value: "advanced" },
  });
  const evaluatorTwoOnly = await prisma.abstract.create({
    data: {
      eventId: EVENT_ID,
      formConfigId: fx.form.id,
      submitterId: fx.users.speaker,
      title: "Scratch: Evaluator Two Only",
      abstract: "This proposal is not assigned to Ravi.",
      status: "UNDER_REVIEW",
      submittedAt: new Date(),
      speakers: { create: [{ userId: fx.users.speaker, isPrimary: true }] },
    },
  });
  await prisma.reviewAssignment.create({
    data: { planId: fx.plan.id, abstractId: evaluatorTwoOnly.id, evaluatorId: fx.users.evaluatorTwo, status: "ASSIGNED" },
  });
  await prisma.evaluationPlan.update({ where: { id: fx.plan.id }, data: { isBlind: true } });
  const blindQueue = await req("GET", "/admin/evaluations", null, evaluator);
  check("blind assigned queue withholds identity and keeps the text-identification limit",
    !blindQueue.text.includes("Sofia Marques")
    && !blindQueue.text.includes("Blind Boundary Speaker")
    && !blindQueue.text.includes("sofia@greenroom.demo")
    && blindQueue.text.includes("Proposal text can still identify a speaker"));
  check("evaluator queue excludes custom answers, organizer data, decisions, and another evaluator's proposal",
    !blindQueue.text.includes("Audience level")
    && !blindQueue.text.includes("Review notes")
    && !blindQueue.text.includes("Decision summary")
    && !blindQueue.text.includes("Change decision")
    && !blindQueue.text.includes("Scratch: Evaluator Two Only"));

  const blindAdmin = await req("GET", `/admin/abstracts?abstractId=${encodeURIComponent(fx.abstract.id)}`, null, admin);
  check("admin global drawer retains identities, custom answers, and de-identified notes",
    blindAdmin.text.includes("Sofia Marques")
    && blindAdmin.text.includes("Audience level")
    && blindAdmin.text.includes("Advanced")
    && blindAdmin.text.includes("Review notes")
    && blindAdmin.text.includes("Legacy first note"));
  await prisma.evaluationPlan.update({ where: { id: fx.plan.id }, data: { isBlind: false } });

  // Exactly one plan selects itself. A second plan intentionally creates an
  // ambiguous organizer state; the page must ask for a URL-backed round rather
  // than falling back to the highest ordinal. The extra plan's completed score
  // must not affect Round 1's weighted two-review result (3.70).
  const onePlanSummary = await req("GET", `/admin/abstracts?abstractId=${encodeURIComponent(fx.abstract.id)}`, null, admin);
  const onePlanSummaryText = renderedText(onePlanSummary.text) ?? "";
  check("one decision round auto-selects its completed weighted summary",
    onePlanSummaryText.includes("Decision scores include only valid, completed reviews from this round.")
    && onePlanSummaryText.includes("3.70")
    && onePlanSummaryText.includes("2 of 2 completed"));
  const otherPlan = await prisma.evaluationPlan.create({
    data: {
      eventId: EVENT_ID,
      name: "Scratch Round 2",
      ordinal: 2,
      isBlind: false,
      rubric: [
        { key: "relevance", label: "Relevance", min: 1, max: 5, weight: 1.5 },
        { key: "clarity", label: "Clarity", min: 1, max: 5, weight: 1 },
      ],
    },
  });
  await prisma.reviewAssignment.create({
    data: { planId: otherPlan.id, abstractId: fx.abstract.id, evaluatorId: fx.users.evaluatorTwo, status: "COMPLETED" },
  });
  await prisma.reviewScore.createMany({
    data: [
      { planId: otherPlan.id, abstractId: fx.abstract.id, evaluatorId: fx.users.evaluatorTwo, rubricKey: "relevance", score: 1 },
      { planId: otherPlan.id, abstractId: fx.abstract.id, evaluatorId: fx.users.evaluatorTwo, rubricKey: "clarity", score: 1 },
    ],
  });
  const partialReview = await prisma.abstract.create({
    data: {
      eventId: EVENT_ID,
      formConfigId: fx.form.id,
      submitterId: fx.users.speaker,
      title: "Scratch: Partial completed review",
      abstract: "Only one rubric score is stored.",
      status: "UNDER_REVIEW",
      submittedAt: new Date(),
    },
  });
  await prisma.reviewAssignment.create({
    data: { planId: fx.plan.id, abstractId: partialReview.id, evaluatorId: fx.users.evaluator, status: "COMPLETED" },
  });
  await prisma.reviewScore.create({
    data: { planId: fx.plan.id, abstractId: partialReview.id, evaluatorId: fx.users.evaluator, rubricKey: "relevance", score: 5 },
  });
  const multiplePlanPage = await req("GET", "/admin/abstracts", null, admin);
  check("multiple decision rounds require an explicit choice and show no numeric summary",
    multiplePlanPage.text.includes("Choose a decision round")
    && multiplePlanPage.text.includes("Choose a round")
    && !multiplePlanPage.text.includes("3.70"));
  const selectedRoundPage = await req("GET", `/admin/abstracts?planId=${encodeURIComponent(fx.plan.id)}`, null, admin);
  const selectedRoundText = renderedText(selectedRoundPage.text) ?? "";
  check("selected plan stays in the URL and excludes another plan's completed score",
    selectedRoundText.includes("Round 1 — Scratch Round 1")
    && selectedRoundText.includes("3.70")
    && selectedRoundText.includes("2/2 completed reviews included"));
  const partialRoundPage = await req(
    "GET",
    `/admin/abstracts?abstractId=${encodeURIComponent(partialReview.id)}&planId=${encodeURIComponent(fx.plan.id)}`,
    null,
    admin,
  );
  const partialRoundText = renderedText(partialRoundPage.text) ?? "";
  check("partial completed review is counted but withheld from the decision score",
    partialRoundText.includes("No included reviews")
    && partialRoundText.includes("0 of 1 completed"));
  const adminSubmissions = await req("GET", `/api/cfp/submissions?planId=${encodeURIComponent(fx.plan.id)}`, null, admin);
  const apiSummary = adminSubmissions.data?.data?.decisionSummary;
  const apiAbstract = (adminSubmissions.data?.data?.abstracts ?? []).find((abstract) => abstract.id === fx.abstract.id);
  check("admin submissions API returns the selected server-owned summary without legacy aggregates",
    adminSubmissions.status === 200
    && apiSummary?.selectedPlan?.id === fx.plan.id
    && apiSummary?.summariesByAbstractId?.[fx.abstract.id]?.weightedAverage === 3.7
    && !("avgScore" in (apiAbstract ?? {}))
    && !("reviewsComplete" in (apiAbstract ?? {}))
    && !("reviewsTotal" in (apiAbstract ?? {})));
  const missingPlanPage = await req("GET", "/admin/abstracts?planId=missing-plan", null, admin);
  check("unknown decision round is a route-level 404", missingPlanPage.status === 404, `got ${missingPlanPage.status}`);
  // The later withdrawn-queue regression is intentionally scoped to its
  // original single-round fixture, so remove this C15-only ambiguity fixture.
  await prisma.abstract.delete({ where: { id: partialReview.id } });
  await prisma.evaluationPlan.delete({ where: { id: otherPlan.id } });

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
  const activeAssignments = await prisma.reviewAssignment.groupBy({
    by: ["status"],
    where: { planId: fx.plan.id, abstract: { status: { not: "WITHDRAWN" } } },
    _count: { _all: true },
  });
  const activeAssignmentCount = activeAssignments.reduce((total, row) => total + row._count._all, 0);
  const completedAssignmentCount = activeAssignments
    .filter((row) => row.status === "COMPLETED")
    .reduce((total, row) => total + row._count._all, 0);
  check("withdrawn assignment does not keep round progress incomplete",
    withdrawnSetup.text.includes(`${completedAssignmentCount}/${activeAssignmentCount} reviews done`));
  await prisma.abstract.update({ where: { id: setupAbstract.id }, data: { status: "UNDER_REVIEW" } });

  // --- S20: bounded abstracts RSC read ------------------------------------
  // Create the overflow directly in scratch rather than slowly driving public
  // writes. The submitted proposal must outrank every NULL submittedAt draft;
  // the oldest draft is a valid direct-link target but outside the newest page.
  const S20_CAP = 100;
  const S20_DRAFT_COUNT = 110;
  const S20_FLOOD_ANSWER_COUNT = 5_001;
  const s20Stamp = Date.now() + 7 * 86400000;
  const s20SubmittedId = "s20-submitted-boundary";
  const s20FloodedId = "s20-draft-flooded";
  const s20OlderId = `s20-draft-${String(S20_DRAFT_COUNT - 1).padStart(3, "0")}`;
  const s20CrossEventId = "s20-cross-event-proposal";
  await prisma.abstract.create({
    data: {
      id: s20SubmittedId,
      eventId: EVENT_ID,
      formConfigId: fx.form.id,
      submitterId: fx.users.speaker,
      title: "S20 submitted boundary proposal",
      status: "SUBMITTED",
      submittedAt: new Date(s20Stamp),
      createdAt: new Date(s20Stamp),
      updatedAt: new Date(s20Stamp),
    },
  });
  await prisma.abstract.createMany({
    data: Array.from({ length: S20_DRAFT_COUNT }, (_, index) => {
      const id = index === 0 ? s20FloodedId : `s20-draft-${String(index).padStart(3, "0")}`;
      const createdAt = new Date(s20Stamp - (index + 1) * 1000);
      return {
        id,
        eventId: EVENT_ID,
        formConfigId: fx.form.id,
        submitterId: fx.users.speaker,
        title: index === 0 ? "S20 flooded draft proposal" : `S20 draft ${String(index).padStart(3, "0")}`,
        status: "DRAFT",
        createdAt,
        updatedAt: createdAt,
      };
    }),
  });
  const s20OtherEvent = await prisma.event.create({
    data: {
      id: S20_OTHER_EVENT_ID,
      name: "Scratch Frontend S20 Boundary",
      slug: S20_OTHER_EVENT_ID,
      timezone: "UTC",
    },
  });
  const s20OtherForm = await prisma.formConfig.create({
    data: {
      eventId: s20OtherEvent.id,
      name: "S20 boundary form",
      slug: "s20-boundary-form",
    },
  });
  await prisma.abstract.create({
    data: {
      id: s20CrossEventId,
      eventId: s20OtherEvent.id,
      formConfigId: s20OtherForm.id,
      submitterId: fx.users.speaker,
      title: "S20 cross-event proposal",
      status: "SUBMITTED",
      submittedAt: new Date(s20Stamp + 1),
    },
  });

  const normalAnswerField = await prisma.formField.create({
    data: {
      formConfigId: fx.form.id,
      key: "s20-retained-answer",
      label: "S20 retained normal answer",
      type: "SHORT_TEXT",
      sortOrder: 10_000,
    },
  });
  await prisma.formAnswer.create({
    data: { abstractId: s20SubmittedId, formFieldId: normalAnswerField.id, value: "S20 normal answer value" },
  });
  await prisma.formField.createMany({
    data: Array.from({ length: S20_FLOOD_ANSWER_COUNT }, (_, index) => ({
      formConfigId: fx.form.id,
      key: `s20-flood-answer-${index}`,
      label: `S20 flood answer ${index}`,
      type: "SHORT_TEXT",
      sortOrder: 10_001 + index,
    })),
  });
  const floodFields = await prisma.formField.findMany({
    where: { formConfigId: fx.form.id, key: { startsWith: "s20-flood-answer-" } },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    take: S20_FLOOD_ANSWER_COUNT + 1,
    select: { id: true },
  });
  if (floodFields.length !== S20_FLOOD_ANSWER_COUNT) {
    throw new Error(`S20 flood fixture expected exactly ${S20_FLOOD_ANSWER_COUNT} fields; refusing a partial or unbounded answer allocation`);
  }
  await prisma.formAnswer.createMany({
    data: floodFields.map((field, index) => ({
      abstractId: s20FloodedId,
      formFieldId: field.id,
      value: `flood-${index}`,
    })),
  });
  await prisma.reviewScore.create({
    data: {
      planId: fx.plan.id,
      abstractId: s20OlderId,
      evaluatorId: fx.users.evaluator,
      rubricKey: "relevance",
      score: 3,
      comment: "S20 older scoped review note",
    },
  });

  const s20StatusGroups = await prisma.abstract.groupBy({
    by: ["status"],
    where: { eventId: EVENT_ID },
    _count: { _all: true },
  });
  const s20Total = s20StatusGroups.reduce((total, group) => total + group._count._all, 0);
  const s20Accepted = s20StatusGroups.find((group) => group.status === "ACCEPTED")?._count._all ?? 0;
  const s20Pending = s20StatusGroups
    .filter((group) => ["SUBMITTED", "UNDER_REVIEW", "MAYBE"].includes(group.status))
    .reduce((total, group) => total + group._count._all, 0);
  const s20Page = await req("GET", "/admin/abstracts", null, admin);
  const s20PageText = renderedText(s20Page.text) ?? "";
  const s20Table = s20Page.text.slice(s20Page.text.indexOf("<tbody>"), s20Page.text.indexOf("</tbody>") + "</tbody>".length);
  const s20OlderDrawer = await req("GET", `/admin/abstracts?abstractId=${encodeURIComponent(s20OlderId)}`, null, admin);
  const s20OlderNotes = renderedText(reviewNotesSection(s20OlderDrawer.text)) ?? "";
  const s20FloodedDrawer = await req("GET", `/admin/abstracts?abstractId=${encodeURIComponent(s20FloodedId)}`, null, admin);
  const s20NormalDrawer = await req("GET", `/admin/abstracts?abstractId=${encodeURIComponent(s20SubmittedId)}`, null, admin);
  const s20CrossEventDrawer = await req("GET", `/admin/abstracts?abstractId=${encodeURIComponent(s20CrossEventId)}`, null, admin);
  const s20UnknownDrawer = await req("GET", "/admin/abstracts?abstractId=s20-missing-proposal", null, admin);
  check("S20 table renders exactly the newest bounded collection",
    s20Page.status === 200
    && (s20Table.match(/<tr/g) ?? []).length === S20_CAP
    && s20Page.text.includes("S20 submitted boundary proposal")
    && !s20Page.text.includes(`S20 draft ${String(S20_DRAFT_COUNT - 1).padStart(3, "0")}`));
  check("S20 reports global counts and an honest bounded-order notice",
    s20PageText.includes(`Showing first ${S20_CAP} of ${s20Total} proposals.`)
    && s20PageText.includes("Submitted proposals are ordered newest first; drafts follow.")
    && s20PageText.includes("Tabs and search cover only these loaded proposals.")
    && new RegExp(`Total\\s*${s20Total}`).test(s20PageText)
    && new RegExp(`Pending review\\s*${s20Pending}`).test(s20PageText)
    && new RegExp(`Accepted\\s*${s20Accepted}`).test(s20PageText));
  check("S20 keeps an older event-scoped proposal reachable by direct link",
    s20OlderDrawer.status === 200
    && s20OlderDrawer.text.includes(`S20 draft ${String(S20_DRAFT_COUNT - 1).padStart(3, "0")}`)
    && (renderedText(s20OlderDrawer.text) ?? "").includes(`Showing first ${S20_CAP} of ${s20Total} proposals.`));
  const hasSelectedDecisionControls = (html) => /role="dialog"/.test(html)
    || /<button[^>]*>Accept<\/button>/.test(html)
    || /<button[^>]*>Maybe<\/button>/.test(html)
    || /<button[^>]*>Decline<\/button>/.test(html);
  check("S20 omits cross-event and unknown deep-link drawers",
    s20CrossEventDrawer.status === 200
    && s20UnknownDrawer.status === 200
    && !s20CrossEventDrawer.text.includes("S20 cross-event proposal")
    && !hasSelectedDecisionControls(s20CrossEventDrawer.text)
    && !hasSelectedDecisionControls(s20UnknownDrawer.text));
  check("S20 scopes organizer notes to materialized abstracts",
    !s20Page.text.includes("S20 older scoped review note")
    && s20OlderNotes.includes("S20 older scoped review note"));
  check("S20 isolates one flooded proposal's answers",
    s20FloodedDrawer.text.includes("This proposal has too many answers to load safely in this view. Its answers are unavailable rather than partially shown.")
    && !s20FloodedDrawer.text.includes("S20 flood answer 0")
    && s20NormalDrawer.text.includes("S20 retained normal answer")
    && s20NormalDrawer.text.includes("S20 normal answer value")
    && !s20NormalDrawer.text.includes("Its answers are unavailable rather than partially shown."));

  // --- C16: "Submit a talk" discoverability (D-C5-3) -----------------------
  // The scratch event has TWO open published forms by this point (the windowed
  // "Scratch CFP" and the window-less "S2 Unique Legacy CFP"), plus one
  // unpublished form. That is the `many` state: every open call must be listed,
  // ordered closesAt-ascending with nulls last, and none may be silently chosen.
  const c16LegacyPath = `/cfp/${EVENT_ID}/${s2UniqueLegacyForm.slug}`;
  const c16UnpublishedPath = `/cfp/${EVENT_ID}/${s2UnpublishedForm.slug}`;
  const c16Portal = await req("GET", "/portal", null, speaker);
  const c16PortalText = renderedText(c16Portal.text) ?? "";
  check("C16 speaker portal renders → 200", c16Portal.status === 200, `got ${c16Portal.status}`);
  check("C16 nav offers a Submit a talk entry per open call",
    c16Portal.text.includes("Submit a talk: Scratch CFP")
    && c16Portal.text.includes(`Submit a talk: ${s2UniqueLegacyForm.name}`)
    && c16Portal.text.includes(`href="${canonicalCfpPath}"`)
    && c16Portal.text.includes(`href="${c16LegacyPath}"`));
  check("C16 chooser lists every open call and never collapses to one",
    c16PortalText.includes("Choose which call for proposals you want to submit to.")
    && !c16PortalText.includes("There is no open call for proposals"));
  check("C16 chooser order is closesAt ascending with nulls last",
    c16Portal.text.indexOf(`href="${canonicalCfpPath}"`) < c16Portal.text.indexOf(`href="${c16LegacyPath}"`));
  check("C16 never exposes an unpublished form",
    !c16Portal.text.includes(c16UnpublishedPath) && !c16Portal.text.includes(s2UnpublishedForm.name));

  const c16Resource = await prisma.resourceWiki.create({
    data: {
      eventId: EVENT_ID,
      slug: "c16-speaker-handbook",
      title: "C16 Speaker Handbook",
      summary: "Logistics for confirmed speakers.",
      htmlContent: "<p>Arrive thirty minutes early.</p>",
      published: true,
    },
  });
  const c16ResourcePage = await req("GET", `/portal/resources/${c16Resource.slug}`, null, speaker);
  check("C16 resource page carries the same entry", c16ResourcePage.status === 200
    && c16ResourcePage.text.includes(c16Resource.title)
    && c16ResourcePage.text.includes(`href="${canonicalCfpPath}"`)
    && c16ResourcePage.text.includes(`href="${c16LegacyPath}"`), `got ${c16ResourcePage.status}`);

  // Zero open calls: the entry stays visible and honest instead of vanishing or
  // linking nowhere. The fresh event has no forms at all.
  const c16FreshAdmin = { ...admin, event: { id: FRESH_EVENT_ID, name: "Scratch Fresh", slug: FRESH_EVENT_ID } };
  const c16Zero = await req("GET", "/portal", null, c16FreshAdmin);
  const c16ZeroText = renderedText(c16Zero.text) ?? "";
  check("C16 zero open calls renders an honest visible state", c16Zero.status === 200
    && c16ZeroText.includes("No open call for proposals")
    && c16ZeroText.includes("There is no open call for proposals for Scratch Fresh right now."),
    `got ${c16Zero.status}`);
  check("C16 zero open calls offers no CFP link at all", !/href="\/cfp\//.test(c16Zero.text));

  // Exactly one open call: a direct link, no chooser.
  const c16OnlyForm = await prisma.formConfig.create({
    data: {
      eventId: FRESH_EVENT_ID,
      name: "Fresh Only CFP",
      slug: "fresh-only-cfp",
      published: true,
      minSpeakers: 1,
      maxSpeakers: 1,
      closesAt: new Date(Date.now() + 7 * 86400000),
    },
  });
  const c16OnlyPath = `/cfp/${FRESH_EVENT_ID}/${c16OnlyForm.slug}`;
  const c16One = await req("GET", "/portal", null, c16FreshAdmin);
  const c16OneText = renderedText(c16One.text) ?? "";
  check("C16 exactly one open call links straight to the canonical path",
    c16One.status === 200
    && c16One.text.includes(`href="${c16OnlyPath}"`)
    && c16OneText.includes(`Submit to ${c16OnlyForm.name}`), `got ${c16One.status}`);
  check("C16 a single open call shows no chooser and no empty state",
    !c16OneText.includes("Choose which call for proposals you want to submit to.")
    && !c16OneText.includes("No open call for proposals"));

  // --- public landing page + embed aliases (eval P0 0.1) ------------------
  // A logged-out visitor must reach the public schedule and speaker pages from
  // `/` without signing in; the same D-C5-3 entry states apply here too.
  const landing = await fetch(`${BASE}/?event=${encodeURIComponent(EVENT_ID)}`, { redirect: "manual" });
  const landingHtml = await landing.text();
  const landingText = renderedText(landingHtml) ?? "";
  check("landing page serves logged-out visitors → 200", landing.status === 200, `got ${landing.status}`);
  check("landing page links both embed surfaces prominently",
    landingHtml.includes('href="/embed/schedule')
    && landingHtml.includes('href="/embed/speakers')
    && landingText.includes("View the schedule")
    && landingText.includes("Meet the speakers")
    && landingText.includes("/embed/schedule")
    && landingText.includes("/embed/speakers"));
  check("landing page names the event and its real programme size",
    landingText.includes("Scratch Frontend") && landingText.includes("Scheduled sessions"));
  check("landing page carries the same open-CFP chooser",
    landingHtml.includes(`href="${canonicalCfpPath}"`)
    && landingHtml.includes(`href="${c16LegacyPath}"`)
    && landingText.includes("Choose which call for proposals you want to submit to."));

  const landingOne = await fetch(`${BASE}/?event=${encodeURIComponent(FRESH_EVENT_ID)}`, { redirect: "manual" });
  const landingOneHtml = await landingOne.text();
  check("landing page shows the single open call for a one-call event",
    landingOne.status === 200 && landingOneHtml.includes(`href="${c16OnlyPath}"`), `got ${landingOne.status}`);

  const landingSignedIn = await fetch(`${BASE}/`, { headers: { cookie: cookie(admin) }, redirect: "manual" });
  check("signed-in visitors keep their workspace redirect from /",
    landingSignedIn.status === 307
    && (landingSignedIn.headers.get("location") ?? "").includes("/admin/forms"),
    `${landingSignedIn.status} ${landingSignedIn.headers.get("location") ?? "none"}`);

  for (const [alias, target] of [
    ["/schedule", "/embed/schedule"],
    ["/agenda", "/embed/schedule"],
    ["/sessions", "/embed/schedule"],
    ["/speakers", "/embed/speakers"],
  ]) {
    const aliasRes = await reqManual(alias, null);
    check(`alias ${alias} → ${target}`,
      aliasRes.status === 307 && aliasRes.location === target,
      `${aliasRes.status} ${aliasRes.location || "none"}`);
  }
  const aliasWithEvent = await reqManual(`/schedule?event=${encodeURIComponent(EVENT_ID)}`, null);
  check("an alias carries an explicit event through the redirect",
    aliasWithEvent.status === 307 && aliasWithEvent.location === `/embed/schedule?event=${EVENT_ID}`,
    `${aliasWithEvent.status} ${aliasWithEvent.location || "none"}`);

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
