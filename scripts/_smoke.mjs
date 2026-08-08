import { spawn } from "node:child_process";
import { PrismaClient } from "@prisma/client";

/**
 * Backend E2E smoke.
 *
 * DB CONCURRENCY RULE (STATE.md): `demo-event` is READ-ONLY for workers — it is
 * the judged demo data. Every write below is scoped to the per-worker scratch
 * event `scratch-backend`, which this script wipes and recreates on each run.
 * Never point this script at `demo-event`.
 */
const SCRATCH_EVENT = {
  id: "scratch-backend",
  name: "Backend Scratch Event",
  slug: "scratch-backend",
};

// Session cookies are forged to match lib/auth.ts encodeSession. Scratch-only
// identities (@scratch.test) so demo personas are never touched.
const admin = {
  user: { id: "scratch-admin", name: "Scratch Admin", email: "admin@scratch.test" },
  event: SCRATCH_EVENT,
  role: "ADMIN",
};
const speaker = { ...admin, user: { id: "scratch-speaker", name: "Scratch Speaker", email: "speaker@scratch.test" }, role: "SPEAKER" };
const evalr = { ...admin, user: { id: "scratch-evaluator", name: "Scratch Evaluator", email: "evaluator@scratch.test" }, role: "EVALUATOR" };
const enc = (s) => Buffer.from(JSON.stringify(s), "utf8").toString("base64url");
const cookie = (s) => `sb_session=${enc(s)}`;

const PORT = process.env.SMOKE_PORT || "3212";
const BASE = `http://127.0.0.1:${PORT}`;
// The spawned server receives this scratch-only key even when the shell does
// not have one configured. It exercises the optional v1 read surface without
// changing any shared environment or touching the judged event.
const V1_API_KEY = process.env.GREENROOM_API_KEY || "scratch-v1-api-key-for-local-only-0001";
const j = async (method, path, body, sess) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(sess ? { cookie: cookie(sess) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
};
const v1 = async (path) => {
  const res = await fetch(BASE + path, { headers: { authorization: `Bearer ${V1_API_KEY}` } });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
};

const server = spawn("npx", ["next", "start", "-p", PORT], {
  cwd: process.cwd(), shell: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GREENROOM_API_KEY: V1_API_KEY },
});
console.log(`[smoke] server pid ${server.pid} on port ${PORT}`);
let ready = false;
server.stdout.on("data", (d) => { if (/Ready|started server|Local:/i.test(d.toString())) ready = true; });
server.stderr.on("data", (d) => process.stderr.write(d));

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + "/api/agenda/public"); if (r.status) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
}

const results = [];
const check = (name, cond, extra) => { results.push({ name, ok: !!cond, extra }); console.log(`${cond ? "PASS" : "FAIL"} ${name}`, extra ?? ""); };

const prisma = new PrismaClient();

/**
 * Wipe + recreate the scratch event so runs are idempotent and isolated.
 * Deleting the Event cascades to forms, abstracts, sessions, slots, plans and
 * memberships. Guarded so this can never target the judged demo event.
 */
async function resetScratchEvent() {
  if (SCRATCH_EVENT.id === "demo-event" || SCRATCH_EVENT.slug === "forward-2026") {
    throw new Error("Refusing to run: smoke must never target the demo event.");
  }
  await prisma.event.deleteMany({ where: { id: SCRATCH_EVENT.id } });
  await prisma.event.create({
    data: {
      ...SCRATCH_EVENT,
      timezone: "UTC",
      rooms: {
        create: [
          { name: "Scratch Room A", capacity: 100, sortOrder: 0 },
          { name: "Scratch Room B", capacity: 60, sortOrder: 1 },
        ],
      },
      tracks: { create: [{ name: "Scratch Track", color: "#3b82f6", sortOrder: 0 }] },
    },
  });
  console.log(`[smoke] scratch event '${SCRATCH_EVENT.id}' reset (demo-event untouched)`);
}

let fatalError = false;
try {
  await resetScratchEvent();
  await prisma.category.createMany({
    data: [
      { eventId: SCRATCH_EVENT.id, name: "Systems", sortOrder: 2 },
      { eventId: SCRATCH_EVENT.id, name: "AI", sortOrder: 0 },
      { eventId: SCRATCH_EVENT.id, name: "Community", sortOrder: 0 },
    ],
  });
  await waitReady();

  // 1. Create + publish a CFP form (admin)
  const formPayload = {
    eventId: SCRATCH_EVENT.id, name: "Smoke CFP", slug: "smoke-cfp-" + Date.now().toString(36),
    minSpeakers: 1, maxSpeakers: 2, maxBioLength: 500, published: true,
    fields: [
      { key: "title_note", label: "Talk note", type: "SHORT_TEXT", required: true, sortOrder: 0 },
      { key: "bio", label: "Speaker bio", type: "LONG_TEXT", required: false, sortOrder: 1 },
      { key: "consent", label: "Consent", type: "CHECKBOX", required: true, sortOrder: 2 },
      { key: "audience", label: "Audience", type: "SELECT", required: false, options: [{ label: "Beginner", value: "beginner" }, { label: "Advanced", value: "advanced" }], sortOrder: 3 },
      { key: "topics", label: "Topics", type: "MULTI_SELECT", required: false, options: [{ label: "AI", value: "ai" }, { label: "Community", value: "community" }], sortOrder: 4 },
      { key: "rating", label: "Rating", type: "NUMBER", required: false, sortOrder: 5 },
      { key: "website", label: "Website", type: "URL", required: false, sortOrder: 6 },
    ],
  };
  const form = await j("POST", "/api/cfp/forms", formPayload, admin);
  check("create form", form.status === 201 && form.data?.ok, form.status);
  const formId = form.data?.data?.id;

  // 2. Public read of the form (null session)
  const pub = await j("GET", `/api/cfp/public/${formId}`);
  check("public form read (no auth)", pub.status === 200 && pub.data?.data?.isOpen === true);
  check(
    "public form includes event categories in stable order",
    JSON.stringify(pub.data?.data?.categories?.map((category) => category.name)) ===
      JSON.stringify(["AI", "Community", "Systems"]),
  );

  const importPayload = {
    eventId: SCRATCH_EVENT.id,
    format: "csv",
    entity: "abstracts",
    mappings: [
      { sourceField: "Title", targetField: "title" },
      { sourceField: "Body", targetField: "abstract" },
      { sourceField: "Email", targetField: "speakerEmail" },
      { sourceField: "Name", targetField: "speakerName" },
      { sourceField: "Category", targetField: "category" },
      { sourceField: "Unused", targetField: "formConfigId", fallback: formId },
      { sourceField: "Title", targetField: "answers.title_note" },
      { sourceField: "Consent", targetField: "answers.consent" },
      { sourceField: "Audience", targetField: "answers.audience" },
      { sourceField: "Topics", targetField: "answers.topics" },
      { sourceField: "Rating", targetField: "answers.rating" },
      { sourceField: "Website", targetField: "answers.website" },
    ],
    payload: "Title,Body,Email,Name,Category,Consent,Audience,Topics,Rating,Website\nImported Talk,Imported body,imported@scratch.test,Imported Speaker,AI,yes,beginner,ai;community,4.5,https://example.test/imported",
  };
  const imported = await j("POST", "/api/integrations/import", importPayload, admin);
  check(
    "mapped CSV import creates completed abstract job",
    imported.status === 201 &&
      imported.data?.data?.job?.status === "COMPLETED" &&
      imported.data?.data?.summary?.created === 1,
    imported.status,
  );
  const importedAgain = await j("POST", "/api/integrations/import", importPayload, admin);
  check(
    "mapped CSV import is idempotent for matching abstract identity",
    importedAgain.status === 201 && importedAgain.data?.data?.summary?.updated === 1,
    importedAgain.status,
  );
  const importedRecord = await prisma.abstract.findFirst({
    where: { eventId: SCRATCH_EVENT.id, title: "Imported Talk" },
    include: { answers: { include: { formField: true } } },
  });
  const importedAnswers = Object.fromEntries(
    (importedRecord?.answers ?? []).map((answer) => [answer.formField.key, answer.value]),
  );
  check(
    "mapped CSV answers are coerced by field type",
    importedAnswers.consent === true &&
      importedAnswers.audience === "beginner" &&
      JSON.stringify(importedAnswers.topics) === JSON.stringify(["ai", "community"]) &&
      importedAnswers.rating === 4.5 &&
      importedAnswers.website === "https://example.test/imported",
  );

  // 3. Reject submit with missing required field
  const bad = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId, title: "My talk", speakers: [{ email: "SPK@x.com", name: "Spk", isPrimary: true }],
    answers: {}, intent: "submit",
  });
  check("submit rejects missing required field", bad.status === 422 && bad.data?.error?.fieldErrors?.title_note, bad.data?.error?.code);

  // 4. Valid submit (public)
  const sub = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId, title: "My great talk", abstract: "About stuff",
    speakers: [{ email: "spk@x.com", name: "Spk One", isPrimary: true }, { email: "co@x.com", name: "Co Two", isPrimary: false }],
    answers: { title_note: "hello", bio: "a short bio", consent: true }, intent: "submit",
  });
  check("valid submit", sub.status === 201 && sub.data?.data?.status === "SUBMITTED", sub.status);
  const abstractId = sub.data?.data?.id;
  check("co-speaker upserted by email", sub.data?.data?.speakers?.length === 2);

  // 5. Admin lists abstracts
  const list = await j("GET", "/api/cfp/submissions?status=SUBMITTED", null, admin);
  check("admin lists submitted abstracts", list.status === 200 && list.data?.data?.some(a => a.id === abstractId));

  // 6. Create evaluation plan
  const plan = await j("POST", "/api/evaluations/plans", {
    eventId: SCRATCH_EVENT.id, name: "Round 1 Smoke", ordinal: 1,
    rubric: [{ key: "relevance", label: "Relevance", min: 1, max: 5, weight: 1 }],
  }, admin);
  check("create plan", plan.status === 201, plan.status);
  const planId = plan.data?.data?.id;

  // 7. Evaluator touches an authed route so context.ts upserts their User +
  // EventMember rows, then admin resolves the real DB id via /evaluators.
  await j("GET", "/api/evaluations/plans", null, evalr);
  const eva = await j("GET", "/api/evaluations/evaluators", null, admin);
  const evaluatorId = eva.data?.data?.find((e) => e.email === evalr.user.email.toLowerCase())?.userId;
  check("resolve evaluator id", eva.status === 200 && !!evaluatorId, evaluatorId);

  // 8. Assign the abstract to the evaluator -> abstract moves to UNDER_REVIEW
  const assign = await j("POST", "/api/evaluations/assignments", {
    planId, abstractIds: [abstractId], evaluatorIds: [evaluatorId],
  }, admin);
  check("create assignment", assign.status === 201 && assign.data?.data?.assignments === 1, assign.status);

  const queue = await j("GET", `/api/evaluations/assignments?planId=${planId}`, null, evalr);
  check("evaluator sees own queue", queue.status === 200 && queue.data?.data?.some(a => a.abstractId === abstractId));

  // 9. Scoring: out-of-range rejected, unassigned evaluator rejected, valid accepted
  const badScore = await j("POST", "/api/evaluations/scores", {
    planId, abstractId, scores: [{ rubricKey: "relevance", score: 99 }], complete: false,
  }, evalr);
  check("score out of rubric range rejected", badScore.status === 422, badScore.data?.error?.code);

  const unknownKey = await j("POST", "/api/evaluations/scores", {
    planId, abstractId, scores: [{ rubricKey: "not_a_criterion", score: 3 }], complete: false,
  }, evalr);
  check("unknown rubric key rejected", unknownKey.status === 422, unknownKey.data?.error?.code);

  const notAssigned = await j("POST", "/api/evaluations/scores", {
    planId, abstractId, scores: [{ rubricKey: "relevance", score: 4 }], complete: true,
  }, { ...evalr, user: { id: "x", name: "Stranger", email: "stranger@x.com" } });
  check("unassigned evaluator refused", notAssigned.status === 403, notAssigned.data?.error?.code);

  const score = await j("POST", "/api/evaluations/scores", {
    planId, abstractId, scores: [{ rubricKey: "relevance", score: 5, comment: "strong" }], complete: true,
  }, evalr);
  check("valid score recorded + assignment completed", score.status === 200 && score.data?.data?.complete === true, score.status);

  const reviewedList = await j("GET", "/api/cfp/submissions", null, admin);
  const reviewedAbstract = reviewedList.data?.data?.find((item) => item.id === abstractId);
  check(
    "abstract list includes completed review progress and average score",
    reviewedList.status === 200 &&
      reviewedAbstract?.reviewsComplete === 1 &&
      reviewedAbstract?.reviewsTotal === 1 &&
      reviewedAbstract?.avgScore === 5,
  );

  // 10. Convert before acceptance must fail (INV-DOMAIN-001)
  const early = await j("POST", "/api/evaluations/convert", { abstractId, durationMinutes: 45 }, admin);
  check("convert before acceptance refused", early.status === 409, early.data?.error?.code);

  // 11. Accept, then convert to a Session
  const decision = await j("POST", "/api/evaluations/decisions", { abstractId, decision: "ACCEPTED" }, admin);
  check("accept abstract", decision.status === 200 && decision.data?.data?.status === "ACCEPTED", decision.status);

  const conv = await j("POST", "/api/evaluations/convert", { abstractId, durationMinutes: 45 }, admin);
  check("convert to session", conv.status === 201 && conv.data?.data?.created === true, conv.status);
  const sessionId = conv.data?.data?.sessionId;

  const conv2 = await j("POST", "/api/evaluations/convert", { abstractId, durationMinutes: 45 }, admin);
  check("convert is idempotent", conv2.data?.data?.created === false && conv2.data?.data?.sessionId === sessionId);

  // 12. Agenda: rooms come from the builder read
  const agenda = await j("GET", "/api/agenda", null, admin);
  check("agenda read exposes rooms + backlog", agenda.status === 200 && agenda.data?.data?.rooms?.length > 0, agenda.data?.data?.rooms?.length);
  const rooms = agenda.data?.data?.rooms ?? [];
  const roomA = rooms[0]?.id, roomB = rooms[1]?.id ?? rooms[0]?.id;

  const t0 = new Date(Date.now() + 86400000); t0.setUTCMinutes(0, 0, 0);
  const iso = (d) => new Date(d).toISOString();
  const start = iso(t0), end = iso(t0.getTime() + 45 * 60000);

  // 13. Place the session
  const place = await j("POST", "/api/agenda/slots", {
    eventId: SCRATCH_EVENT.id, sessionId, roomId: roomA, startsAt: start, endsAt: end,
  }, admin);
  check("place session on schedule", place.status === 200 && !!place.data?.data?.slot?.id, place.status);

  // 14. Room conflict: a second session in the same room at the same time
  const sub2 = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId, title: "Second talk", abstract: "More stuff",
    speakers: [{ email: "other@x.com", name: "Other Person", isPrimary: true }],
    answers: { title_note: "hi", consent: true }, intent: "submit",
  });
  const abstractId2 = sub2.data?.data?.id;
  await j("POST", "/api/evaluations/decisions", { abstractId: abstractId2, decision: "ACCEPTED" }, admin);
  const conv3 = await j("POST", "/api/evaluations/convert", { abstractId: abstractId2, durationMinutes: 45 }, admin);
  const sessionId2 = conv3.data?.data?.sessionId;

  const roomClash = await j("POST", "/api/agenda/slots", {
    eventId: SCRATCH_EVENT.id, sessionId: sessionId2, roomId: roomA, startsAt: start, endsAt: end,
  }, admin);
  check("room conflict refused (409)", roomClash.status === 409 && /ROOM_OVERLAP/.test(JSON.stringify(roomClash.data)), roomClash.data?.error?.code);

  // 15. Speaker conflict: same speaker, different room, overlapping time
  const sub3 = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId, title: "Third talk", abstract: "Even more",
    speakers: [{ email: "spk@x.com", name: "Spk One", isPrimary: true }],
    answers: { title_note: "hi", consent: true }, intent: "submit",
  });
  const abstractId3 = sub3.data?.data?.id;
  await j("POST", "/api/evaluations/decisions", { abstractId: abstractId3, decision: "ACCEPTED" }, admin);
  const conv4 = await j("POST", "/api/evaluations/convert", { abstractId: abstractId3, durationMinutes: 45 }, admin);
  const speakerClash = await j("POST", "/api/agenda/slots", {
    eventId: SCRATCH_EVENT.id, sessionId: conv4.data?.data?.sessionId, roomId: roomB,
    startsAt: start, endsAt: end,
  }, admin);
  check("speaker double-booking refused", speakerClash.status === 409 && /SPEAKER_OVERLAP/.test(JSON.stringify(speakerClash.data)), speakerClash.data?.error?.code);

  // 16. Non-overlapping placement succeeds
  const later = iso(t0.getTime() + 60 * 60000), laterEnd = iso(t0.getTime() + 105 * 60000);
  const okPlace = await j("POST", "/api/agenda/slots", {
    eventId: SCRATCH_EVENT.id, sessionId: sessionId2, roomId: roomA, startsAt: later, endsAt: laterEnd,
  }, admin);
  check("non-overlapping placement succeeds", okPlace.status === 200 && !!okPlace.data?.data?.slot?.id, okPlace.status);

  // 17. Moving a session doesn't conflict with itself
  const move = await j("POST", "/api/agenda/slots", {
    eventId: SCRATCH_EVENT.id, sessionId: sessionId2, roomId: roomA,
    startsAt: iso(t0.getTime() + 65 * 60000), endsAt: iso(t0.getTime() + 110 * 60000),
  }, admin);
  check("move own slot without self-conflict", move.status === 200, move.status);

  // 18. Public embed shows placed sessions with a null session
  const pubAgenda = await j("GET", `/api/agenda/public?event=${SCRATCH_EVENT.slug}`);
  check("public agenda (no auth) lists placed sessions", pubAgenda.status === 200 && pubAgenda.data?.data?.sessions?.length === 2, pubAgenda.data?.data?.sessions?.length);

  // 19. Key-protected v1 reads remain explicitly event-scoped and return only
  // the intended read models (no reviewer data or unplaced sessions).
  const v1Submissions = await v1(`/api/v1/submissions?event=${SCRATCH_EVENT.slug}`);
  check("v1 submissions read is key-gated and event-scoped", v1Submissions.status === 200 && v1Submissions.data?.version === "v1" && v1Submissions.data?.data?.some((item) => item.id === abstractId), v1Submissions.status);
  const v1Speakers = await v1(`/api/v1/speakers?event=${SCRATCH_EVENT.slug}`);
  check("v1 speakers are derived from scratch event records", v1Speakers.status === 200 && v1Speakers.data?.data?.some((item) => item.email === "spk@x.com"), v1Speakers.status);
  const v1Schedule = await v1(`/api/v1/schedule?event=${SCRATCH_EVENT.slug}`);
  check("v1 schedule lists placed sessions only", v1Schedule.status === 200 && v1Schedule.data?.data?.length === 2, v1Schedule.status);

  // 19b. Cross-event scoping: a scratch-scoped session must not accept a body
  // claiming the demo event (INV-EVENT-001), and must not read demo data.
  const crossEvent = await j("POST", "/api/agenda/slots", {
    eventId: "demo-event", sessionId, roomId: roomA, startsAt: start, endsAt: end,
  }, admin);
  check("cross-event write refused (EVENT_SCOPE)", crossEvent.status === 403, crossEvent.data?.error?.code);

  // 19. Authorization: speaker persona cannot reach admin surfaces
  const forbidden = await j("GET", "/api/agenda", null, speaker);
  check("speaker blocked from admin agenda", forbidden.status === 403, forbidden.status);
  const anon = await j("GET", "/api/agenda");
  check("anonymous blocked from admin agenda", anon.status === 401, anon.status);

  // 20. Unschedule path still works (data itself is dropped by the next reset)
  const unschedule = await j("DELETE", `/api/agenda/slots?sessionId=${sessionId}`, null, admin);
  check("unschedule session", unschedule.status === 200 && unschedule.data?.data?.unscheduled === true, unschedule.status);

  // 21. Guard: the run must not have touched the judged demo event.
  const demoTouch = await prisma.formConfig.count({
    where: { eventId: "demo-event", name: "Smoke CFP" },
  });
  check("demo-event untouched by smoke", demoTouch === 0, `stray demo rows: ${demoTouch}`);

  console.log("IDS", JSON.stringify({ planId, abstractId, formId, sessionId }));
} catch (e) {
  fatalError = true;
  console.error("SMOKE ERROR", e);
} finally {
  const failed = results.filter(r => r.ok === false);
  console.log(`\n=== ${results.filter(r=>r.ok).length} passed, ${failed.length} failed ===`);
  await prisma.$disconnect().catch(() => {});
  // Kill ONLY the process tree we spawned (never by image name — see STATE.md incident rule).
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], { shell: true, stdio: "ignore" });
  } else {
    server.kill();
  }
  setTimeout(() => process.exit(fatalError || failed.length ? 1 : 0), 1500);
}
