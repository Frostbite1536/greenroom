import { spawn, spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { SMOKE_SESSION_SECRET, cookieForSession } from "./_signed-session.mjs";

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

// Signed scratch-only identities (@scratch.test) so demo personas are never touched.
const admin = {
  user: { id: "scratch-admin", name: "Scratch Admin", email: "admin@scratch.test" },
  event: SCRATCH_EVENT,
  role: "ADMIN",
};
const speaker = { ...admin, user: { id: "scratch-speaker", name: "Scratch Speaker", email: "speaker@scratch.test" }, role: "SPEAKER" };
const evalr = { ...admin, user: { id: "scratch-evaluator", name: "Scratch Evaluator", email: "evaluator@scratch.test" }, role: "EVALUATOR" };
const cookie = cookieForSession;

const PORT = process.env.SMOKE_PORT || "3212";
const BASE = `http://127.0.0.1:${PORT}`;
// Refuse a pre-existing listener: otherwise this run can silently verify a
// server it did not spawn and report a misleading pass.
const occupiedPort = await fetch(`${BASE}/login`).then(() => true).catch(() => false);
if (occupiedPort) {
  console.error(`[smoke] port ${PORT} is already serving. Find and stop that exact PID first:\n` +
    `  netstat -ano | findstr :${PORT}\n  taskkill /F /PID <pid>`);
  process.exit(1);
}
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
  // Smoke must never reach a real provider, even when the caller's shell is
  // configured for live integrations.
  env: {
    ...process.env,
    GREENROOM_API_KEY: V1_API_KEY,
    MOCK_EXTERNAL_APIS: "true",
    SESSION_SECRET: SMOKE_SESSION_SECRET,
  },
});
console.log(`[smoke] server pid ${server.pid} on port ${PORT}`);
const prisma = new PrismaClient();
let ready = false;
server.stdout.on("data", (d) => { if (/Ready|started server|Local:/i.test(d.toString())) ready = true; });
server.stderr.on("data", (d) => process.stderr.write(d));

let cleanupFailed = false;
let cleanupPromise;
let fatalError = false;
function stopServer() {
  if (!server.pid || server.exitCode !== null) return true;
  if (process.platform === "win32") {
    // `server.pid` is the shell wrapper; /T limits termination to its exact tree.
    const result = spawnSync("taskkill", ["/F", "/T", "/PID", String(server.pid)], { encoding: "utf8" });
    if (result.error || result.status !== 0) {
      cleanupFailed = true;
      console.error(`[smoke] failed to stop server tree for pid ${server.pid}: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`);
      return false;
    }
    return true;
  }
  if (!server.kill("SIGTERM")) {
    cleanupFailed = true;
    console.error(`[smoke] failed to stop server pid ${server.pid}`);
    return false;
  }
  return true;
}

function cleanup() {
  cleanupPromise ??= (async () => {
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
  fatalError = true;
  void cleanup().finally(() => process.exit(130));
});

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + "/api/agenda/public"); if (r.status) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
}

const results = [];
const check = (name, cond, extra) => { results.push({ name, ok: !!cond, extra }); console.log(`${cond ? "PASS" : "FAIL"} ${name}`, extra ?? ""); };

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
      // Accepting a talk assigns this checklist to every speaker on it (B1).
      onboardingTasks: {
        create: [
          { title: "Scratch task: confirm travel", required: true, sortOrder: 0 },
          { title: "Scratch task: send headshot", required: false, sortOrder: 1 },
        ],
      },
    },
  });
  for (const identity of [admin, speaker, evalr]) {
    const user = await prisma.user.upsert({
      where: { email: identity.user.email },
      update: { name: identity.user.name },
      create: { email: identity.user.email, name: identity.user.name },
    });
    await prisma.eventMember.upsert({
      where: { eventId_userId: { eventId: SCRATCH_EVENT.id, userId: user.id } },
      update: { role: identity.role },
      create: { eventId: SCRATCH_EVENT.id, userId: user.id, role: identity.role },
    });
  }
  console.log(`[smoke] scratch event '${SCRATCH_EVENT.id}' reset (demo-event untouched)`);
}

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
      // B2: required, but only asked when audience = advanced.
      { key: "workshop_needs", label: "Workshop needs", type: "SHORT_TEXT", required: true, sortOrder: 7,
        conditionalLogic: { match: "all", rules: [{ fieldKey: "audience", operator: "equals", value: "advanced" }] } },
    ],
  };
  const form = await j("POST", "/api/cfp/forms", formPayload, admin);
  check("create form", form.status === 201 && form.data?.ok, form.status);
  const formId = form.data?.data?.id;

  // 1b. Create-new-form guards (the admin "New form" flow depends on these)
  const dupSlug = await j("POST", "/api/cfp/forms", { ...formPayload, name: "Duplicate slug" }, admin);
  check("duplicate slug refused (409 SLUG_TAKEN)", dupSlug.status === 409 && dupSlug.data?.error?.code === "SLUG_TAKEN", dupSlug.status);

  const shadowSlug = await j("POST", "/api/cfp/forms", { ...formPayload, name: "Shadow", slug: formId }, admin);
  check("slug shadowing another form id refused", shadowSlug.status === 409 && shadowSlug.data?.error?.code === "SLUG_TAKEN", shadowSlug.status);

  const dupKeys = await j("POST", "/api/cfp/forms", {
    ...formPayload,
    name: "Duplicate keys",
    slug: formPayload.slug + "-dupkeys",
    fields: [...formPayload.fields, { key: "bio", label: "Bio again", type: "LONG_TEXT", required: false, sortOrder: 7 }],
  }, admin);
  check("duplicate field key refused (422)", dupKeys.status === 422 && !!dupKeys.data?.error?.fieldErrors?.fields, dupKeys.data?.error?.code);

  const resaved = await j("POST", "/api/cfp/forms", { ...formPayload, id: formId, name: "Smoke CFP v2" }, admin);
  check("update keeps own slug and returns 200", resaved.status === 200 && resaved.data?.data?.name === "Smoke CFP v2", resaved.status);

  // 2. Public read of the form (null session)
  const pub = await j("GET", `/api/cfp/public/${formId}`);
  check("public form read (no auth)", pub.status === 200 && pub.data?.data?.isOpen === true);
  const pubBySlug = await j("GET", `/api/cfp/public/${formPayload.slug}`);
  check("public form resolves by slug to the same form", pubBySlug.status === 200 && pubBySlug.data?.data?.id === formId, pubBySlug.status);
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

  // 2b. B2 — server-side conditional visibility + typed answers (audit2#3).
  const b2Base = {
    formConfigId: formId, title: "Conditional logic talk",
    speakers: [{ email: "b2@scratch.test", name: "B2 Speaker", isPrimary: true }],
    intent: "submit",
  };
  const b2Hidden = await j("POST", "/api/cfp/submissions", {
    ...b2Base, answers: { title_note: "n", consent: true, audience: "beginner" },
  });
  check("B2 a required field that was never shown does not block submission",
    b2Hidden.status === 201, `${b2Hidden.status} ${JSON.stringify(b2Hidden.data?.error?.fieldErrors ?? {})}`);

  const b2Revealed = await j("POST", "/api/cfp/submissions", {
    ...b2Base, answers: { title_note: "n", consent: true, audience: "advanced" },
  });
  check("B2 the same field is required once its condition is met",
    b2Revealed.status === 422 && !!b2Revealed.data?.error?.fieldErrors?.workshop_needs,
    b2Revealed.data?.error?.code);

  const b2Answered = await j("POST", "/api/cfp/submissions", {
    ...b2Base, answers: { title_note: "n", consent: true, audience: "advanced", workshop_needs: "Two power sockets" },
  });
  check("B2 answering the revealed field submits cleanly", b2Answered.status === 201, b2Answered.status);

  const b2BadOption = await j("POST", "/api/cfp/submissions", {
    ...b2Base, answers: { title_note: "n", consent: true, audience: "smuggled-option" },
  });
  check("B2 a select answer outside the options is refused",
    b2BadOption.status === 422 && !!b2BadOption.data?.error?.fieldErrors?.audience, b2BadOption.data?.error?.code);

  const b2BadMulti = await j("POST", "/api/cfp/submissions", {
    ...b2Base, answers: { title_note: "n", consent: true, topics: ["ai", "quantum"] },
  });
  check("B2 a multi-select answer outside the options is refused",
    b2BadMulti.status === 422 && !!b2BadMulti.data?.error?.fieldErrors?.topics, b2BadMulti.data?.error?.code);

  const b2BadNumber = await j("POST", "/api/cfp/submissions", {
    ...b2Base, answers: { title_note: "n", consent: true, rating: "not a number" },
  });
  check("B2 a non-numeric answer to a number field is refused",
    b2BadNumber.status === 422 && !!b2BadNumber.data?.error?.fieldErrors?.rating, b2BadNumber.data?.error?.code);

  const b2BadUrl = await j("POST", "/api/cfp/submissions", {
    ...b2Base, answers: { title_note: "n", consent: true, website: "definitely not a url" },
  });
  check("B2 an invalid URL answer is refused",
    b2BadUrl.status === 422 && !!b2BadUrl.data?.error?.fieldErrors?.website, b2BadUrl.data?.error?.code);

  const b2UnsafeUrl = await j("POST", "/api/cfp/submissions", {
    ...b2Base, answers: { title_note: "n", consent: true, website: "javascript:alert(1)" },
  });
  check("B2 a non-HTTP URL scheme is refused",
    b2UnsafeUrl.status === 422 && !!b2UnsafeUrl.data?.error?.fieldErrors?.website, b2UnsafeUrl.data?.error?.code);

  const b2Unticked = await j("POST", "/api/cfp/submissions", {
    ...b2Base, answers: { title_note: "n", consent: false },
  });
  check("B2 a required checkbox must be ticked, not merely answered",
    b2Unticked.status === 422 && !!b2Unticked.data?.error?.fieldErrors?.consent, b2Unticked.data?.error?.code);

  const b2WrongType = await j("POST", "/api/cfp/submissions", {
    ...b2Base, answers: { title_note: "n", consent: "yes" },
  });
  check("B2 a checkbox answered with a string is refused",
    b2WrongType.status === 422 && !!b2WrongType.data?.error?.fieldErrors?.consent, b2WrongType.data?.error?.code);

  // 2c. B5 — form edits must not silently delete submitted answers (audit2#1).
  // At this point b2Hidden/b2Answered have answered title_note, consent and audience.
  const b5Relabel = await j("POST", "/api/cfp/forms", {
    ...formPayload, id: formId,
    fields: formPayload.fields.map((f) => f.key === "title_note" ? { ...f, label: "Talk note (reworded)", helpText: "Say more" } : f),
  }, admin);
  check("B5 rewording an answered question is still allowed", b5Relabel.status === 200, b5Relabel.status);

  const b5Remove = await j("POST", "/api/cfp/forms", {
    ...formPayload, id: formId, fields: formPayload.fields.filter((f) => f.key !== "title_note"),
  }, admin);
  check("B5 deleting an answered question is refused (409 FIELD_IN_USE)",
    b5Remove.status === 409 && b5Remove.data?.error?.code === "FIELD_IN_USE" &&
    !!b5Remove.data?.error?.fieldErrors?.title_note, b5Remove.status);
  check("B5 the refusal explains itself in plain language",
    !/[A-Z_]{4,}/.test(b5Remove.data?.error?.fieldErrors?.title_note?.[0] ?? "CODE_LIKE"),
    b5Remove.data?.error?.fieldErrors?.title_note?.[0]);

  const b5Rename = await j("POST", "/api/cfp/forms", {
    ...formPayload, id: formId,
    fields: formPayload.fields.map((f) => f.key === "title_note" ? { ...f, key: "talk_note" } : f),
  }, admin);
  check("B5 renaming an answered question's key is refused",
    b5Rename.status === 409 && !!b5Rename.data?.error?.fieldErrors?.title_note, b5Rename.status);

  const b5Retype = await j("POST", "/api/cfp/forms", {
    ...formPayload, id: formId,
    fields: formPayload.fields.map((f) => f.key === "title_note" ? { ...f, type: "NUMBER" } : f),
  }, admin);
  check("B5 changing an answered question's type is refused",
    b5Retype.status === 409 && !!b5Retype.data?.error?.fieldErrors?.title_note, b5Retype.status);

  const b5DropUsedOption = await j("POST", "/api/cfp/forms", {
    ...formPayload, id: formId,
    fields: formPayload.fields.map((f) => f.key === "audience" ? { ...f, options: [{ label: "Advanced", value: "advanced" }] } : f),
  }, admin);
  check("B5 removing an option someone chose is refused",
    b5DropUsedOption.status === 409 && !!b5DropUsedOption.data?.error?.fieldErrors?.audience, b5DropUsedOption.status);

  // Adding an option is never destructive, and removing one nobody picked is fine.
  const withExtraOption = formPayload.fields.map((f) => f.key === "audience"
    ? { ...f, options: [...f.options, { label: "Expert", value: "expert" }] } : f);
  const b5AddOption = await j("POST", "/api/cfp/forms", { ...formPayload, id: formId, fields: withExtraOption }, admin);
  check("B5 adding an option is always allowed", b5AddOption.status === 200, b5AddOption.status);
  const b5DropUnusedOption = await j("POST", "/api/cfp/forms", { ...formPayload, id: formId }, admin);
  check("B5 removing an option nobody chose is allowed", b5DropUnusedOption.status === 200, b5DropUnusedOption.status);

  // `bio` has no answers at this point, so it is still free to delete.
  const b5DropUnanswered = await j("POST", "/api/cfp/forms", {
    ...formPayload, id: formId, fields: formPayload.fields.filter((f) => f.key !== "bio"),
  }, admin);
  check("B5 deleting a question nobody answered is allowed", b5DropUnanswered.status === 200, b5DropUnanswered.status);

  const b5Answers = await prisma.formAnswer.count({ where: { formField: { formConfigId: formId } } });
  check("B5 no submitted answer was destroyed by any of those edits", b5Answers >= 6, b5Answers);

  // Restore the full field set for the checks that follow.
  const b5Restore = await j("POST", "/api/cfp/forms", { ...formPayload, id: formId }, admin);
  check("B5 setup: restore the full field set", b5Restore.status === 200, b5Restore.status);

  // O2: the shared delivery path requires a template row for its dispatch FK.
  // Use the legacy accepted key here to prove an already-running event keeps
  // sending during the short code-deploy -> coordinated-reseed interval. The
  // dedicated cfp-submitted key is preferred once the new seed is applied.
  // The server is forced into mock mode above, so these checks cannot reach
  // Resend even if the local shell happens to carry live credentials.
  const commsTemplate = await prisma.emailTemplate.create({
    data: {
      eventId: SCRATCH_EVENT.id,
      key: "cfp-accepted",
      subject: "Scratch decision",
      htmlBody: "<p>Scratch only</p>",
      trigger: "manual",
    },
  });

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
  const submissionDispatches = await prisma.emailDispatch.findMany({
    where: { templateId: commsTemplate.id },
    select: { recipient: true, status: true, providerId: true },
    orderBy: { recipient: "asc" },
  });
  check(
    "O2 legacy template fallback records receipt, co-speaker notice, and admin alert",
    JSON.stringify(submissionDispatches.map((row) => row.recipient)) ===
      JSON.stringify(["admin@scratch.test", "co@x.com", "spk@x.com"]),
    JSON.stringify(submissionDispatches.map((row) => row.recipient)),
  );
  check(
    "O2 smoke delivery is mocked before any provider call",
    submissionDispatches.every((row) => row.status === "mocked" && row.providerId?.startsWith("mock:")),
  );

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

  // 7. Evaluator has a pre-existing scratch membership; resolve the real DB id.
  await j("GET", "/api/evaluations/plans", null, evalr);
  const eva = await j("GET", "/api/evaluations/evaluators", null, admin);
  const evaluatorId = eva.data?.data?.find((e) => e.email === evalr.user.email.toLowerCase())?.userId;
  check("resolve evaluator id", eva.status === 200 && !!evaluatorId, evaluatorId);
  const [adminMembership, speakerMembership] = await Promise.all([
    prisma.eventMember.findFirst({
      where: { eventId: SCRATCH_EVENT.id, user: { email: admin.user.email } },
      select: { userId: true },
    }),
    prisma.eventMember.findFirst({
      where: { eventId: SCRATCH_EVENT.id, user: { email: speaker.user.email } },
      select: { userId: true },
    }),
  ]);
  const adminUserId = adminMembership?.userId;
  const speakerUserId = speakerMembership?.userId;
  check("resolve assignment-role fixtures", !!adminUserId && !!speakerUserId);

  const assignSpeaker = await j("POST", "/api/evaluations/assignments", {
    planId, abstractIds: [abstractId], evaluatorIds: [speakerUserId],
  }, admin);
  check("S5 speaker event member cannot be assigned as reviewer",
    assignSpeaker.status === 422 && assignSpeaker.data?.error?.code === "INVALID_EVALUATORS",
    assignSpeaker.data?.error?.code);
  check("S5 refused speaker assignment creates no row",
    await prisma.reviewAssignment.count({
      where: { planId, abstractId, evaluatorId: speakerUserId },
    }) === 0);

  // Deterministic TOCTOU regression: a competing terminal writer owns the
  // shared abstract lock and updates the status without committing yet. The
  // assignment request starts while that row still looks SUBMITTED to another
  // transaction; it must wait, then re-read REJECTED and refuse the write.
  const raceSubmit = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId, title: "Assignment race proposal",
    speakers: [{ email: "race-speaker@scratch.test", name: "Race Speaker", isPrimary: true }],
    answers: { title_note: "race", consent: true }, intent: "submit",
  });
  const raceAbstractId = raceSubmit.data?.data?.id;
  check("S5 race setup: submitted proposal created", raceSubmit.status === 201 && !!raceAbstractId);

  let signalLockHeld;
  let releaseTerminalWriter;
  const lockHeld = new Promise((resolve) => { signalLockHeld = resolve; });
  const terminalWriterGate = new Promise((resolve) => { releaseTerminalWriter = resolve; });
  const terminalWriter = prisma.$transaction(async (tx) => {
    const key = `abstract-write:${raceAbstractId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    await tx.abstract.update({
      where: { id: raceAbstractId },
      data: { status: "REJECTED", decidedAt: new Date() },
    });
    signalLockHeld();
    await terminalWriterGate;
  });
  await lockHeld;
  const racingAssignment = j("POST", "/api/evaluations/assignments", {
    planId, abstractIds: [raceAbstractId], evaluatorIds: [adminUserId],
  }, admin);
  await new Promise((resolve) => setTimeout(resolve, 150));
  releaseTerminalWriter();
  await terminalWriter;
  const raceResult = await racingAssignment;
  check("S5 assignment waits for a competing decision and then refuses",
    raceResult.status === 409 && raceResult.data?.error?.code === "ABSTRACT_NOT_REVIEWABLE",
    raceResult.data?.error?.code);
  check("S5 race preserves the decision and creates no assignment",
    (await prisma.abstract.findUnique({ where: { id: raceAbstractId }, select: { status: true } }))?.status === "REJECTED" &&
      await prisma.reviewAssignment.count({
        where: { planId, abstractId: raceAbstractId, evaluatorId: adminUserId },
      }) === 0);

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

  const unprovisioned = await j("POST", "/api/evaluations/scores", {
    planId, abstractId, scores: [{ rubricKey: "relevance", score: 4 }], complete: true,
  }, { ...evalr, user: { id: "x", name: "Stranger", email: "stranger@x.com" } });
  check("unprovisioned evaluator refused", unprovisioned.status === 401, unprovisioned.data?.error?.code);

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

  const assignAccepted = await j("POST", "/api/evaluations/assignments", {
    planId, abstractIds: [abstractId], evaluatorIds: [adminUserId],
  }, admin);
  check("S5 accepted proposal cannot gain a new assignment",
    assignAccepted.status === 409 && assignAccepted.data?.error?.code === "ABSTRACT_NOT_REVIEWABLE",
    assignAccepted.data?.error?.code);
  check("S5 accepted status and assignments survive the refused write",
    (await prisma.abstract.findUnique({ where: { id: abstractId }, select: { status: true } }))?.status === "ACCEPTED" &&
      await prisma.reviewAssignment.count({
        where: { planId, abstractId, evaluatorId: adminUserId },
      }) === 0);

  const decisionPreview = await j("POST", "/api/comms/decision", {
    abstractId,
    includeFeedback: true,
  }, admin);
  check(
    "O2 decision preview includes comments but never scores or reviewer identities",
    decisionPreview.status === 200 &&
      decisionPreview.data?.data?.preview === true &&
      decisionPreview.data?.data?.feedbackCount === 1 &&
      decisionPreview.data?.data?.html?.includes("strong") &&
      !decisionPreview.data?.data?.html?.includes("5/5") &&
      !/reviewer|evaluator/i.test(decisionPreview.data?.data?.html ?? ""),
    decisionPreview.status,
  );
  check(
    "O2 decision preview names every proposal recipient",
    JSON.stringify([...(decisionPreview.data?.data?.recipients ?? [])].sort()) ===
      JSON.stringify(["co@x.com", "spk@x.com"]),
    JSON.stringify(decisionPreview.data?.data?.recipients),
  );

  const unpreviewedDecisionSend = await j("POST", "/api/comms/decision", {
    abstractId,
    preview: false,
    includeFeedback: true,
  }, admin);
  check(
    "O2 decision delivery refuses a send without server-issued preview proof",
    unpreviewedDecisionSend.status === 409 &&
      unpreviewedDecisionSend.data?.error?.code === "PREVIEW_REQUIRED",
    unpreviewedDecisionSend.data?.error?.code,
  );

  const changedAfterPreview = await j("POST", "/api/comms/decision", {
    abstractId,
    preview: false,
    previewToken: decisionPreview.data?.data?.previewToken,
    includeFeedback: true,
    personalNote: "This note was not in the preview.",
  }, admin);
  check(
    "O2 preview proof is invalid when message content changes",
    changedAfterPreview.status === 409 && changedAfterPreview.data?.error?.code === "PREVIEW_REQUIRED",
    changedAfterPreview.data?.error?.code,
  );

  const decisionSend = await j("POST", "/api/comms/decision", {
    abstractId,
    preview: false,
    previewToken: decisionPreview.data?.data?.previewToken,
    includeFeedback: true,
  }, admin);
  check(
    "O2 decision send records one mocked dispatch per proposal speaker",
    decisionSend.status === 200 &&
      decisionSend.data?.data?.sent === 0 &&
      decisionSend.data?.data?.mocked === 2 &&
      decisionSend.data?.data?.failed === 0,
    JSON.stringify(decisionSend.data?.data),
  );

  // B1: accepting is the moment the talk becomes real — session + checklist.
  const sessionId = decision.data?.data?.session?.id;
  check("B1 accept auto-creates the confirmed session",
    decision.data?.data?.sessionCreated === true && !!sessionId, JSON.stringify(decision.data?.data?.session));
  check("B1 accept assigns the checklist to every speaker (2 tasks x 2 speakers)",
    decision.data?.data?.tasksAssigned === 4, decision.data?.data?.tasksAssigned);

  const autoSpeakers = await prisma.sessionSpeaker.count({ where: { sessionId } });
  const autoTasks = await prisma.speakerTask.findMany({
    where: { task: { eventId: SCRATCH_EVENT.id } }, select: { taskId: true, userId: true, status: true },
  });
  check("B1 the auto-created session carries both speakers", autoSpeakers === 2, autoSpeakers);
  check("B1 every assignment starts as TODO",
    autoTasks.length === 4 && autoTasks.every((t) => t.status === "TODO"), autoTasks.length);

  const reAccept = await j("POST", "/api/evaluations/decisions", { abstractId, decision: "ACCEPTED" }, admin);
  check("B1 re-accepting creates nothing new (idempotent)",
    reAccept.status === 200 && reAccept.data?.data?.sessionCreated === false &&
    reAccept.data?.data?.tasksAssigned === 0 && reAccept.data?.data?.session?.id === sessionId,
    JSON.stringify({ created: reAccept.data?.data?.sessionCreated, tasks: reAccept.data?.data?.tasksAssigned }));

  const conv = await j("POST", "/api/evaluations/convert", { abstractId, durationMinutes: 45 }, admin);
  check("convert after auto-provisioning is an idempotent backfill",
    conv.status === 200 && conv.data?.data?.created === false && conv.data?.data?.sessionId === sessionId, conv.status);

  // B1 backfill: a checklist item added after acceptance reaches existing talks.
  const lateTask = await prisma.onboardingTask.create({
    data: { eventId: SCRATCH_EVENT.id, title: "Scratch task: added after acceptance", sortOrder: 2 },
  });
  const backfill = await j("POST", "/api/evaluations/convert", { abstractId, durationMinutes: 45 }, admin);
  check("B1 convert backfills a checklist item added after acceptance",
    backfill.data?.data?.tasksAssigned === 2 && backfill.data?.data?.created === false,
    backfill.data?.data?.tasksAssigned);
  const backfilled = await prisma.speakerTask.count({ where: { taskId: lateTask.id } });
  check("B1 the backfilled item reaches both speakers", backfilled === 2, backfilled);

  const conv2 = await j("POST", "/api/evaluations/convert", { abstractId, durationMinutes: 45 }, admin);
  check("convert is idempotent", conv2.data?.data?.created === false && conv2.data?.data?.sessionId === sessionId);

  // O3: a linked onboarding form renders, merges validated progress, gates
  // completion, and is protected from destructive form-builder edits.
  const taskFormPayload = {
    eventId: SCRATCH_EVENT.id,
    name: "Scratch hotel form",
    slug: "scratch-hotel-" + Date.now().toString(36),
    minSpeakers: 1,
    maxSpeakers: 1,
    maxBioLength: 500,
    published: false,
    fields: [
      {
        key: "needs_hotel", label: "Do you need a room?", type: "SELECT", required: true, sortOrder: 0,
        options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
      },
      {
        key: "check_in", label: "Check-in date", type: "SHORT_TEXT", required: true, sortOrder: 1,
        conditionalLogic: { match: "all", rules: [{ fieldKey: "needs_hotel", operator: "equals", value: "yes" }] },
      },
      {
        key: "receipt_url", label: "Receipt", type: "URL", required: false, sortOrder: 2,
        conditionalLogic: { match: "all", rules: [{ fieldKey: "needs_hotel", operator: "equals", value: "yes" }] },
      },
    ],
  };
  const taskFormCreate = await j("POST", "/api/cfp/forms", taskFormPayload, admin);
  check("O3 setup: unpublished task form created", taskFormCreate.status === 201, taskFormCreate.status);
  const taskFormId = taskFormCreate.data?.data?.id;
  const taskTemplate = await prisma.onboardingTask.create({
    data: {
      eventId: SCRATCH_EVENT.id,
      title: "Scratch task: hotel form",
      description: "Tell us which nights you need.",
      required: true,
      formConfigId: taskFormId,
      sortOrder: 3,
    },
  });
  const taskSpeaker = await prisma.user.findUniqueOrThrow({ where: { email: speaker.user.email } });
  await prisma.speakerTask.create({
    data: { taskId: taskTemplate.id, userId: taskSpeaker.id, status: "TODO" },
  });

  const taskPage = await j("GET", `/portal/tasks/${taskTemplate.id}`, null, speaker);
  check("O3 assigned speaker can render the linked task form",
    taskPage.status === 200 && String(taskPage.data).includes("Scratch hotel form"), taskPage.status);
  const otherTaskPage = await j("GET", `/portal/tasks/${taskTemplate.id}`, null, admin);
  check("O3 someone else's task is not disclosed", otherTaskPage.status === 404, otherTaskPage.status);

  const emptyTaskComplete = await j("PATCH", "/api/portal/tasks", {
    taskId: taskTemplate.id, status: "COMPLETED", responses: {},
  }, speaker);
  check("O3 empty task form cannot be marked complete",
    emptyTaskComplete.status === 422 && !!emptyTaskComplete.data?.error?.fieldErrors?.needs_hotel,
    emptyTaskComplete.data?.error?.code);

  const selfWaiveTask = await j("PATCH", "/api/portal/tasks", {
    taskId: taskTemplate.id, status: "WAIVED",
  }, speaker);
  check("O3 speakers cannot bypass a required form by waiving their own task",
    selfWaiveTask.status === 422 && selfWaiveTask.data?.error?.code === "VALIDATION_ERROR",
    selfWaiveTask.data?.error?.code);

  const invalidTaskProgress = await j("PATCH", "/api/portal/tasks", {
    taskId: taskTemplate.id, status: "IN_PROGRESS", responses: { needs_hotel: "maybe" },
  }, speaker);
  check("O3 progress saves still enforce stored select options",
    invalidTaskProgress.status === 422 && !!invalidTaskProgress.data?.error?.fieldErrors?.needs_hotel,
    invalidTaskProgress.data?.error?.code);

  const taskProgress = await j("PATCH", "/api/portal/tasks", {
    taskId: taskTemplate.id, status: "IN_PROGRESS", responses: { needs_hotel: "yes" },
  }, speaker);
  check("O3 partial task-form progress is saved without requiring the revealed follow-up",
    taskProgress.status === 200 && taskProgress.data?.data?.responses?.needs_hotel === "yes",
    taskProgress.status);

  const destructiveTaskFormEdit = await j("POST", "/api/cfp/forms", {
    ...taskFormPayload,
    id: taskFormId,
    fields: [
      { ...taskFormPayload.fields[0], options: [{ label: "No", value: "no" }] },
      ...taskFormPayload.fields.slice(1),
    ],
  }, admin);
  check("O3 task responses participate in B5 option-removal protection",
    destructiveTaskFormEdit.status === 409 && destructiveTaskFormEdit.data?.error?.code === "FIELD_IN_USE",
    destructiveTaskFormEdit.data?.error?.code);

  const taskComplete = await j("PATCH", "/api/portal/tasks", {
    taskId: taskTemplate.id,
    status: "COMPLETED",
    responses: { check_in: "May 11", receipt_url: "https://example.com/receipt.pdf", unknown_key: "drop me" },
  }, speaker);
  check("O3 valid completion merges prior answers and prunes unknown keys",
    taskComplete.status === 200 &&
    taskComplete.data?.data?.status === "COMPLETED" &&
    taskComplete.data?.data?.responses?.needs_hotel === "yes" &&
    taskComplete.data?.data?.responses?.check_in === "May 11" &&
    !("unknown_key" in (taskComplete.data?.data?.responses ?? {})),
    taskComplete.status);

  const taskPortal = await j("GET", "/portal", null, speaker);
  check("O3 completed task form becomes reviewable from the portal",
    taskPortal.status === 200 && String(taskPortal.data).includes("Review your answers"), taskPortal.status);

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

  // 21. R1 — an authorized speaker edits their own submission after acceptance
  // (requirements delta 2026-08-08). The scratch SPEAKER identity is used as the
  // primary speaker because the portal requires a persisted event membership.
  const r1Speakers = [
    { email: speaker.user.email, name: speaker.user.name, isPrimary: true },
    { email: "r1co@scratch.test", name: "R1 Co", isPrimary: false },
  ];
  const r1Submit = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId, title: "Editable talk", abstract: "Original body",
    speakers: r1Speakers,
    answers: { title_note: "original note", bio: "original bio", consent: true }, intent: "submit",
  });
  check("R1 setup: speaker submits an abstract", r1Submit.status === 201, r1Submit.status);
  const r1Id = r1Submit.data?.data?.id;
  const r1SubmittedAt = r1Submit.data?.data?.submittedAt;

  const mineAnon = await j("GET", "/api/cfp/submissions/mine");
  check("R1 anonymous cannot list submissions", mineAnon.status === 401, mineAnon.data?.error?.code);

  const mine = await j("GET", "/api/cfp/submissions/mine", null, speaker);
  const mineRow = mine.data?.data?.submissions?.find((s) => s.id === r1Id);
  check("R1 speaker lists own submissions with edit affordances",
    mine.status === 200 && mineRow?.canEdit === true && mineRow?.speakersLocked === false && mineRow?.lockReason === null,
    mine.status);
  check("R1 speaker read never exposes review data",
    mineRow?.avgScore === null && mineRow?.reviewsTotal === 0 && !("reviewScores" in (mineRow ?? {})));

  const notMine = await j("GET", `/api/cfp/submissions/${r1Id}`, null, evalr);
  check("R1 non-speaker refused (403 NOT_YOUR_SUBMISSION)",
    notMine.status === 403 && notMine.data?.error?.code === "NOT_YOUR_SUBMISSION", notMine.status);
  const patchAnon = await j("PATCH", `/api/cfp/submissions/${r1Id}`, { title: "Anonymous edit" });
  check("R1 anonymous PATCH refused", patchAnon.status === 401, patchAnon.status);
  const patchStranger = await j("PATCH", `/api/cfp/submissions/${r1Id}`, { title: "Not yours" }, evalr);
  check("R1 non-speaker PATCH refused", patchStranger.status === 403, patchStranger.data?.error?.code);
  const patchMissing = await j("PATCH", "/api/cfp/submissions/does-not-exist", { title: "Ghost" }, speaker);
  check("R1 unknown abstract returns 404", patchMissing.status === 404, patchMissing.data?.error?.code);

  const edit1 = await j("PATCH", `/api/cfp/submissions/${r1Id}`, {
    title: "Edited talk title", answers: { title_note: "updated note" },
  }, speaker);
  check("R1 speaker edits a SUBMITTED abstract",
    edit1.status === 200 && edit1.data?.data?.submission?.title === "Edited talk title", edit1.status);
  check("R1 partial answer patch merges instead of replacing",
    edit1.data?.data?.answersByKey?.title_note === "updated note" &&
    edit1.data?.data?.answersByKey?.bio === "original bio");
  check("R1 edit never moves the abstract in the pipeline",
    edit1.data?.data?.submission?.status === "SUBMITTED" &&
    edit1.data?.data?.submission?.submittedAt === r1SubmittedAt);
  check("R1 edit response carries the field spec for the renderer",
    Array.isArray(edit1.data?.data?.form?.fields) && edit1.data?.data?.form?.fields.length === 8 &&
    !("isOpen" in (edit1.data?.data?.form ?? {})));

  const b2EditReveal = await j("PATCH", `/api/cfp/submissions/${r1Id}`, {
    answers: { audience: "advanced" },
  }, speaker);
  check("B2 speaker edit enforces a newly revealed required field",
    b2EditReveal.status === 422 && !!b2EditReveal.data?.error?.fieldErrors?.workshop_needs,
    b2EditReveal.data?.error?.code);

  const b2EditAnswered = await j("PATCH", `/api/cfp/submissions/${r1Id}`, {
    answers: { audience: "advanced", workshop_needs: "A projector" },
  }, speaker);
  check("B2 speaker edit accepts the revealed field once answered",
    b2EditAnswered.status === 200, b2EditAnswered.status);

  const b2EditHide = await j("PATCH", `/api/cfp/submissions/${r1Id}`, {
    answers: { audience: "beginner" },
  }, speaker);
  check("B2 speaker edit ignores a now-hidden required field",
    b2EditHide.status === 200, b2EditHide.status);

  const b2EditHiddenForge = await j("PATCH", `/api/cfp/submissions/${r1Id}`, {
    answers: { workshop_needs: ["forged"] },
  }, speaker);
  check("B2 speaker edit rejects a forged hidden answer with the wrong type",
    b2EditHiddenForge.status === 422 && !!b2EditHiddenForge.data?.error?.fieldErrors?.workshop_needs,
    b2EditHiddenForge.data?.error?.code);

  const clearRequired = await j("PATCH", `/api/cfp/submissions/${r1Id}`, { answers: { title_note: null } }, speaker);
  check("R1 clearing a required answer refused (422 FIELD_ERRORS)",
    clearRequired.status === 422 && !!clearRequired.data?.error?.fieldErrors?.title_note,
    clearRequired.data?.error?.code);

  // Terminal statuses stay locked.
  const r1Reject = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId, title: "Rejected talk",
    speakers: [{ email: speaker.user.email, name: speaker.user.name, isPrimary: true }],
    answers: { title_note: "n", consent: true }, intent: "submit",
  });
  const rejectId = r1Reject.data?.data?.id;
  await j("POST", "/api/evaluations/decisions", { abstractId: rejectId, decision: "REJECTED" }, admin);
  const editRejected = await j("PATCH", `/api/cfp/submissions/${rejectId}`, { title: "Trying anyway" }, speaker);
  check("R1 rejected abstract is locked (409 ABSTRACT_LOCKED)",
    editRejected.status === 409 && editRejected.data?.error?.code === "ABSTRACT_LOCKED", editRejected.status);
  const mineAfterReject = await j("GET", "/api/cfp/submissions/mine", null, speaker);
  const rejectedRow = mineAfterReject.data?.data?.submissions?.find((s) => s.id === rejectId);
  check("R1 locked submission reports canEdit=false with plain-language copy",
    rejectedRow?.canEdit === false && typeof rejectedRow?.lockReason === "string" &&
    rejectedRow.lockReason.length > 10 && !/[A-Z_]{4,}/.test(rejectedRow.lockReason));

  // Accept + convert, then prove the confirmed Session is untouched by an edit.
  await j("POST", "/api/evaluations/decisions", { abstractId: r1Id, decision: "ACCEPTED" }, admin);
  const r1Conv = await j("POST", "/api/evaluations/convert", { abstractId: r1Id, durationMinutes: 30 }, admin);
  const r1SessionId = r1Conv.data?.data?.sessionId;
  check("R1 setup: accepted abstract has its session (auto-provisioned by accept)",
    r1Conv.status === 200 && r1Conv.data?.data?.created === false && !!r1SessionId, r1Conv.status);
  const sessionBefore = await prisma.session.findUnique({ where: { id: r1SessionId }, include: { speakers: true } });

  const editAccepted = await j("PATCH", `/api/cfp/submissions/${r1Id}`, {
    title: "Accepted and edited", abstract: "Rewritten body",
  }, speaker);
  check("R1 ACCEPTED abstract is editable (the required behaviour)",
    editAccepted.status === 200 && editAccepted.data?.data?.submission?.status === "ACCEPTED" &&
    editAccepted.data?.data?.submission?.title === "Accepted and edited", editAccepted.status);

  const sessionAfter = await prisma.session.findUnique({ where: { id: r1SessionId }, include: { speakers: true } });
  check("R1 edit does not touch the linked Session (INV-DOMAIN-001)",
    sessionAfter?.title === sessionBefore?.title &&
    sessionAfter?.description === sessionBefore?.description &&
    sessionAfter?.durationMinutes === sessionBefore?.durationMinutes &&
    sessionAfter?.updatedAt?.getTime() === sessionBefore?.updatedAt?.getTime() &&
    sessionAfter?.speakers.length === sessionBefore?.speakers.length,
    `${sessionBefore?.title} -> ${sessionAfter?.title}`);

  const rosterEdit = await j("PATCH", `/api/cfp/submissions/${r1Id}`, {
    speakers: [{ email: speaker.user.email, name: speaker.user.name, isPrimary: true }],
  }, speaker);
  check("R1 roster change after conversion refused (409 SPEAKERS_LOCKED)",
    rosterEdit.status === 409 && rosterEdit.data?.error?.code === "SPEAKERS_LOCKED", rosterEdit.status);
  const rosterSame = await j("PATCH", `/api/cfp/submissions/${r1Id}`, {
    speakers: [r1Speakers[1], { ...r1Speakers[0], name: "Renamed Speaker" }],
  }, speaker);
  check("R1 resending the same roster (reordered/renamed) is allowed", rosterSame.status === 200, rosterSame.status);

  // The CFP window must not gate edits: no edit-lock window (delta Q2).
  const closeForm = await j("POST", "/api/cfp/forms", {
    ...formPayload, id: formId, closesAt: new Date(Date.now() - 86_400_000).toISOString(),
  }, admin);
  check("R1 setup: CFP window closed", closeForm.status === 200, closeForm.status);
  const closedSubmit = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId, title: "Too late",
    speakers: [{ email: "late@scratch.test", name: "Late", isPrimary: true }],
    answers: { title_note: "x", consent: true }, intent: "submit",
  });
  check("R1 public submission is still refused after the window closes",
    closedSubmit.status === 422 && closedSubmit.data?.error?.code === "FORM_CLOSED", closedSubmit.data?.error?.code);
  const editAfterClose = await j("PATCH", `/api/cfp/submissions/${r1Id}`, {
    title: "Edited after the window closed",
  }, speaker);
  check("R1 speaker can still edit after the CFP window closes", editAfterClose.status === 200, editAfterClose.status);

  // Regression guard: the public, unauthenticated path must NOT have gained the
  // ability to overwrite a submitted/accepted abstract.
  const publicOverwrite = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId, abstractId: r1Id, title: "Anonymous overwrite",
    speakers: [{ email: "attacker@scratch.test", name: "Attacker", isPrimary: true }],
    answers: {}, intent: "saveDraft",
  });
  check("R1 public path still refuses to edit a non-DRAFT abstract",
    publicOverwrite.status === 409 && publicOverwrite.data?.error?.code === "ABSTRACT_LOCKED",
    publicOverwrite.data?.error?.code);

  // 22. W1 — speaker self-withdraw, and the states it makes reachable for the
  // first time (nothing wrote WITHDRAWN before this).
  // The R1 block above closed this form's window, so reopen it to submit again.
  const reopen = await j("POST", "/api/cfp/forms", {
    ...formPayload, id: formId, closesAt: new Date(Date.now() + 86_400_000).toISOString(),
  }, admin);
  check("W1 setup: CFP window reopened", reopen.status === 200, reopen.status);

  const wSubmit = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId, title: "Withdrawable talk",
    speakers: [{ email: speaker.user.email, name: speaker.user.name, isPrimary: true }],
    answers: { title_note: "w", consent: true }, intent: "submit",
  });
  const wId = wSubmit.data?.data?.id;
  check("W1 setup: speaker submits a withdrawable abstract", wSubmit.status === 201 && !!wId, wSubmit.status);

  const wAssign = await j("POST", "/api/evaluations/assignments", {
    planId, abstractIds: [wId], evaluatorIds: [evaluatorId],
  }, admin);
  check("W1 setup: assignment moves it to UNDER_REVIEW", wAssign.status === 201, wAssign.status);

  const wBundled = await j("PATCH", `/api/cfp/submissions/${wId}`, {
    status: "WITHDRAWN", title: "Sneaky rename on the way out",
  }, speaker);
  check("W1 withdraw bundled with a content edit refused (422)", wBundled.status === 422, wBundled.data?.error?.code);

  const wStranger = await j("PATCH", `/api/cfp/submissions/${wId}`, { status: "WITHDRAWN" }, evalr);
  check("W1 only a speaker on the abstract can withdraw it",
    wStranger.status === 403 && wStranger.data?.error?.code === "NOT_YOUR_SUBMISSION", wStranger.status);

  const wDraw = await j("PATCH", `/api/cfp/submissions/${wId}`, { status: "WITHDRAWN" }, speaker);
  check("W1 speaker withdraws an UNDER_REVIEW proposal",
    wDraw.status === 200 && wDraw.data?.data?.submission?.status === "WITHDRAWN", wDraw.status);
  check("W1 withdrawing does not stamp a programme decision",
    wDraw.data?.data?.submission?.decidedAt === null && wDraw.data?.data?.submission?.canEdit === false);

  const assignWithdrawn = await j("POST", "/api/evaluations/assignments", {
    planId, abstractIds: [wId], evaluatorIds: [adminUserId],
  }, admin);
  check("S5 withdrawn proposal cannot gain a new assignment",
    assignWithdrawn.status === 409 && assignWithdrawn.data?.error?.code === "ABSTRACT_NOT_REVIEWABLE",
    assignWithdrawn.data?.error?.code);
  check("S5 withdrawn status and assignments survive the refused write",
    (await prisma.abstract.findUnique({ where: { id: wId }, select: { status: true } }))?.status === "WITHDRAWN" &&
      await prisma.reviewAssignment.count({
        where: { planId, abstractId: wId, evaluatorId: adminUserId },
      }) === 0);

  const wReEdit = await j("PATCH", `/api/cfp/submissions/${wId}`, { title: "Back from the dead" }, speaker);
  check("W1 a withdrawn proposal is locked for further edits",
    wReEdit.status === 409 && wReEdit.data?.error?.code === "ABSTRACT_LOCKED", wReEdit.status);

  const wScore = await j("POST", "/api/evaluations/scores", {
    planId, abstractId: wId, scores: [{ rubricKey: "relevance", score: 4 }], complete: true,
  }, evalr);
  check("W1 evaluators cannot score a withdrawn proposal",
    wScore.status === 409 && wScore.data?.error?.code === "ABSTRACT_WITHDRAWN", wScore.data?.error?.code);

  const wDecide = await j("POST", "/api/evaluations/decisions", { abstractId: wId, decision: "ACCEPTED" }, admin);
  check("W1 admins cannot decide on a withdrawn proposal",
    wDecide.status === 409 && wDecide.data?.error?.code === "ABSTRACT_WITHDRAWN", wDecide.data?.error?.code);

  const wQueue = await j("GET", `/api/evaluations/assignments?planId=${planId}`, null, evalr);
  const wQueueRow = wQueue.data?.data?.find((a) => a.abstractId === wId);
  check("W1 the evaluator queue reports the withdrawn status",
    wQueue.status === 200 && wQueueRow?.abstract?.status === "WITHDRAWN", wQueueRow?.abstract?.status);

  const wAccepted = await j("PATCH", `/api/cfp/submissions/${r1Id}`, { status: "WITHDRAWN" }, speaker);
  check("W1 an accepted, converted talk cannot be self-withdrawn",
    wAccepted.status === 409 && wAccepted.data?.error?.code === "WITHDRAW_NOT_ALLOWED", wAccepted.status);

  // 23. W2 — a decision reports the session it leaves behind, so the admin UI
  // can prompt to unschedule (no auto-deletion: INV-DOMAIN-001).
  const w2NoSession = await j("POST", "/api/evaluations/decisions", { abstractId: rejectId, decision: "REJECTED" }, admin);
  check("W2 decision on an unconverted abstract reports no session",
    w2NoSession.status === 200 && w2NoSession.data?.data?.session === null, w2NoSession.status);
  check("B1 rejecting provisions nothing",
    w2NoSession.data?.data?.sessionCreated === false && w2NoSession.data?.data?.tasksAssigned === 0);

  const rePlace = await j("POST", "/api/agenda/slots", {
    eventId: SCRATCH_EVENT.id, sessionId, roomId: roomA, startsAt: start, endsAt: end,
  }, admin);
  check("W2 setup: the converted session is on the schedule again", rePlace.status === 200, rePlace.status);

  const reversed = await j("POST", "/api/evaluations/decisions", { abstractId, decision: "REJECTED" }, admin);
  check("W2 reversing a decision reports the still-scheduled session",
    reversed.status === 200 &&
    reversed.data?.data?.session?.id === sessionId &&
    reversed.data?.data?.session?.isScheduled === true &&
    typeof reversed.data?.data?.session?.roomName === "string" &&
    typeof reversed.data?.data?.session?.scheduledAt === "string",
    JSON.stringify(reversed.data?.data?.session));

  const stillThere = await prisma.session.findUnique({ where: { id: sessionId }, include: { scheduleSlot: true } });
  check("W2 the reversed decision does not delete the confirmed session (INV-DOMAIN-001)",
    !!stillThere && !!stillThere.scheduleSlot);

  // 24. Guard: the run must not have touched the judged demo event.
  const demoTouch = await prisma.formConfig.count({
    where: { eventId: "demo-event", name: "Smoke CFP" },
  });
  check("demo-event untouched by smoke", demoTouch === 0, `stray demo rows: ${demoTouch}`);

  console.log("IDS", JSON.stringify({ planId, abstractId, formId, sessionId, r1Id, r1SessionId, wId }));
} catch (e) {
  fatalError = true;
  console.error("SMOKE ERROR", e);
} finally {
  const failed = results.filter(r => r.ok === false);
  console.log(`\n=== ${results.filter(r=>r.ok).length} passed, ${failed.length} failed ===`);
  await cleanup();
  process.exit(fatalError || failed.length || cleanupFailed ? 1 : 0);
}
