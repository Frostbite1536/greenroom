import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { SMOKE_SESSION_SECRET, cookieForSession } from "./_signed-session.mjs";
import { observeBeforeDeadline } from "./smoke-deadline.mjs";

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
const OTHER_SCRATCH_EVENT = {
  id: "scratch-backend-other",
  name: "Other Backend Scratch Event",
  slug: "scratch-backend-other",
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
// `next start` runs with NODE_ENV=production, so invite URLs must use the
// configured trusted HTTPS origin even though the smoke server itself is local.
const REVIEWER_INVITE_APP_URL = "https://greenroom-hq.test";
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
let publicSubmissionIpSequence = 1;
function isolatedPublicSubmissionHeaders(method, path) {
  if (method !== "POST" || path !== "/api/cfp/submissions") return {};
  const sequence = publicSubmissionIpSequence++;
  // A valid single-address Vercel header keeps independent smoke examples from
  // sharing the production-safe `unknown` IP throttle bucket.
  return { "x-vercel-forwarded-for": `198.18.${Math.floor(sequence / 250)}.${(sequence % 250) + 1}` };
}

function hasExplicitPublicClientIp(headers) {
  return Object.keys(headers).some((name) => {
    const normalized = name.toLowerCase();
    return normalized === "x-vercel-forwarded-for" || normalized === "x-forwarded-for";
  });
}

function publicSubmissionHeaders(method, path, extraHeaders, sess) {
  const headers = new Headers({ "content-type": "application/json" });
  // An explicit test address must be the only client-IP header supplied. All
  // other public write probes receive a unique valid address for isolation.
  if (!hasExplicitPublicClientIp(extraHeaders)) {
    for (const [name, value] of Object.entries(isolatedPublicSubmissionHeaders(method, path))) {
      headers.set(name, value);
    }
  }
  for (const [name, value] of Object.entries(extraHeaders)) {
    headers.set(name, value);
  }
  if (sess) headers.set("cookie", cookie(sess));
  return headers;
}

// The public rate refusal must name an approximate wait, never a bare
// "please wait". Mirrors describePublicSubmissionRetryWait.
const PUBLIC_RATE_WAIT_PATTERN = /Try again in (about \d+ (minutes?|hours?)|less than a minute)\./;

function publicSubmissionRateFingerprint(domain, value) {
  return createHmac("sha256", SMOKE_SESSION_SECRET)
    .update(`greenroom:public-submission-rate:v1:${domain}\u0000${value}`)
    .digest("hex");
}

function publicDraftCapabilityHash(capability) {
  return createHmac("sha256", SMOKE_SESSION_SECRET)
    .update(`greenroom:cfp-draft-capability:v1:${capability}`)
    .digest("hex");
}

function reviewerInviteBearer(invite, nonce = "r".repeat(43)) {
  const exp = Math.floor(new Date(invite.expiresAt).getTime() / 1000);
  const message = `greenroom:reviewer-invite:v1:${invite.id}:${invite.tokenVersion}:${exp}:${nonce}`;
  const signature = createHmac("sha256", SMOKE_SESSION_SECRET).update(message).digest("base64url");
  return `v1.${invite.id}.${invite.tokenVersion}.${exp}.${nonce}.${signature}`;
}

async function postReviewerInviteAccept(token) {
  const response = await fetch(`${BASE}/api/auth/reviewer-invites/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
    redirect: "manual",
  });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
}

const j = async (method, path, body, sess, extraHeaders = {}, { signal } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: publicSubmissionHeaders(method, path, extraHeaders, sess),
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
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
    APP_URL: REVIEWER_INVITE_APP_URL,
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
    try {
      await prisma.publicSubmissionRateBucket.deleteMany({
        where: { eventId: { in: [SCRATCH_EVENT.id, OTHER_SCRATCH_EVENT.id] } },
      });
      await prisma.$executeRaw`
        DELETE FROM "ReviewerInvite" WHERE "eventId" IN (${SCRATCH_EVENT.id}, ${OTHER_SCRATCH_EVENT.id})
      `;
      const reviewerInviteRows = await prisma.$queryRaw`
        SELECT COUNT(*)::int AS "count" FROM "ReviewerInvite"
        WHERE "eventId" IN (${SCRATCH_EVENT.id}, ${OTHER_SCRATCH_EVENT.id})
      `;
      check(
        "scratch-owned reviewer invite rows are cleared at final teardown",
        reviewerInviteRows[0]?.count === 0,
        reviewerInviteRows[0]?.count,
      );
      const remainingRateBuckets = await prisma.publicSubmissionRateBucket.count({
        where: { eventId: { in: [SCRATCH_EVENT.id, OTHER_SCRATCH_EVENT.id] } },
      });
      check(
        "scratch-owned public rate buckets are cleared at final teardown",
        remainingRateBuckets === 0,
        remainingRateBuckets,
      );
    } catch (error) {
      cleanupFailed = true;
      console.error("[smoke] scratch rate-bucket cleanup failed", error);
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
const fixedIpHeader = publicSubmissionHeaders("POST", "/api/cfp/submissions", {
  "x-vercel-forwarded-for": "198.51.100.91",
});
check(
  "rate smoke explicit client-IP header replaces automatic isolation",
  fixedIpHeader.get("x-vercel-forwarded-for") === "198.51.100.91",
);

/**
 * Wipe + recreate the scratch event so runs are idempotent and isolated.
 * Deleting the Event cascades to forms, abstracts, sessions, slots, plans and
 * memberships. Guarded so this can never target the judged demo event.
 */
async function resetScratchEvent() {
  if (SCRATCH_EVENT.id === "demo-event" || SCRATCH_EVENT.slug === "forward-2026") {
    throw new Error("Refusing to run: smoke must never target the demo event.");
  }
  await prisma.event.deleteMany({ where: { id: { in: [SCRATCH_EVENT.id, OTHER_SCRATCH_EVENT.id] } } });
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
  await prisma.event.create({
    data: {
      ...OTHER_SCRATCH_EVENT,
      timezone: "UTC",
      rooms: { create: [{ name: "Other Scratch Room", sortOrder: 0 }] },
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

  // S1: retained legacy eventId input cannot choose a different event for a
  // form create; the server context is the sole event authority.
  const s1ContextForm = await j("POST", "/api/cfp/forms", {
    ...formPayload,
    eventId: OTHER_SCRATCH_EVENT.id,
    name: "S1 server-scoped form",
    slug: `s1-server-scoped-${Date.now().toString(36)}`,
    fields: [],
  }, admin);
  const s1ContextFormId = s1ContextForm.data?.data?.id;
  const s1ContextStoredForm = s1ContextFormId
    ? await prisma.formConfig.findUnique({ where: { id: s1ContextFormId }, select: { eventId: true } })
    : null;
  check(
    "S1 form create derives event scope from the session, never the body",
    s1ContextForm.status === 201 && s1ContextStoredForm?.eventId === SCRATCH_EVENT.id,
    s1ContextForm.status,
  );
  const otherS1Form = await prisma.formConfig.create({
    data: {
      eventId: OTHER_SCRATCH_EVENT.id,
      name: "Other S1 form",
      slug: `other-s1-${Date.now().toString(36)}`,
    },
  });
  const s1CrossEventFormDelete = await j("DELETE", `/api/cfp/forms/${otherS1Form.id}`, null, admin);
  const s1OtherFormAfterDelete = await prisma.formConfig.findUnique({ where: { id: otherS1Form.id }, select: { id: true } });
  check(
    "S1 form delete keeps unknown and cross-event ids indistinguishable",
    s1CrossEventFormDelete.status === 404 &&
      s1CrossEventFormDelete.data?.error?.code === "FORM_NOT_FOUND" &&
      s1OtherFormAfterDelete?.id === otherS1Form.id,
    s1CrossEventFormDelete.status,
  );
  const s1UnusedFormDelete = await j("DELETE", `/api/cfp/forms/${s1ContextFormId}`, null, admin);
  check(
    "S1 form delete removes only an unused locked active-event form",
    s1UnusedFormDelete.status === 200 && s1UnusedFormDelete.data?.data?.id === s1ContextFormId,
    s1UnusedFormDelete.status,
  );

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

  // C4 (D-C5-2) — a form shape nobody could ever fill in is refused on the same
  // create path, with a stable field-scoped 400. Composes with the duplicate-key
  // guard above rather than replacing it.
  const c4Shape = (suffix, fields, extra = {}) => ({
    ...formPayload, name: `C4 ${suffix}`, slug: `${formPayload.slug}-${suffix}`, published: false, fields, ...extra,
  });
  const c4Cycle = await j("POST", "/api/cfp/forms", c4Shape("c4cycle", [
    { key: "alpha", label: "Alpha", type: "SHORT_TEXT", required: false, sortOrder: 0,
      conditionalLogic: { match: "all", rules: [{ fieldKey: "beta", operator: "isNotEmpty" }] } },
    { key: "beta", label: "Beta", type: "SHORT_TEXT", required: false, sortOrder: 1,
      conditionalLogic: { match: "all", rules: [{ fieldKey: "alpha", operator: "isNotEmpty" }] } },
  ]), admin);
  check("C4 a conditional loop is refused (400 FORM_LOGIC_CYCLE)",
    c4Cycle.status === 400 && c4Cycle.data?.error?.code === "FORM_LOGIC_CYCLE" &&
    !!c4Cycle.data?.error?.fieldErrors?.alpha, c4Cycle.data?.error?.code);
  check("C4 the loop refusal explains itself in plain language",
    !/[A-Z_]{4,}/.test(c4Cycle.data?.error?.fieldErrors?.alpha?.[0] ?? "CODE_LIKE"),
    c4Cycle.data?.error?.fieldErrors?.alpha?.[0]);

  const c4Unknown = await j("POST", "/api/cfp/forms", c4Shape("c4unknown", [
    { key: "gate", label: "Gate", type: "SHORT_TEXT", required: false, sortOrder: 0,
      conditionalLogic: { match: "all", rules: [{ fieldKey: "not_a_question", operator: "equals", value: "x" }] } },
  ]), admin);
  check("C4 a rule on a source that is not on the form is refused (400 FORM_LOGIC_SOURCE_UNKNOWN)",
    c4Unknown.status === 400 && c4Unknown.data?.error?.code === "FORM_LOGIC_SOURCE_UNKNOWN" &&
    !!c4Unknown.data?.error?.fieldErrors?.gate, c4Unknown.data?.error?.code);

  const c4Reserved = await j("POST", "/api/cfp/forms", c4Shape("c4reserved", [
    { key: "format", label: "Preferred format", type: "SHORT_TEXT", required: false, sortOrder: 0 },
  ]), admin);
  check("C4 a question key that collides with a built-in source is refused",
    c4Reserved.status === 400 && c4Reserved.data?.error?.code === "FORM_FIELD_KEY_RESERVED",
    c4Reserved.data?.error?.code);

  // The built-in submission sources are real: a rule on Session format saves.
  const c4BuiltIn = await j("POST", "/api/cfp/forms", c4Shape("c4builtin", [
    { key: "gate", label: "Gate", type: "SHORT_TEXT", required: false, sortOrder: 0,
      conditionalLogic: { match: "all", rules: [{ fieldKey: "format", operator: "isNotEmpty" }] } },
  ]), admin);
  check("C4 a rule on the built-in Session format source is accepted",
    c4BuiltIn.status === 201, c4BuiltIn.data?.error?.code ?? c4BuiltIn.status);
  if (c4BuiltIn.data?.data?.id) {
    const c4Cleanup = await j("DELETE", `/api/cfp/forms/${c4BuiltIn.data.data.id}`, null, admin);
    check("C4 setup: the built-in-source scratch form is removed again", c4Cleanup.status === 200, c4Cleanup.status);
  }

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

  // S19/S20 — public writes are bounded before parsing, strict at the schema
  // boundary, and rate-limited in a short transaction that commits before a
  // later business-validation refusal. Keep these headers/rate rows isolated
  // from the rest of this long-lived scratch smoke.
  const publicCoreCounts = async () => ({
    users: await prisma.user.count(),
    abstracts: await prisma.abstract.count({ where: { eventId: SCRATCH_EVENT.id } }),
    dispatches: await prisma.emailDispatch.count(),
  });
  const publicDraftCoreCounts = async () => ({
    users: await prisma.user.count(),
    abstracts: await prisma.abstract.count({ where: { eventId: SCRATCH_EVENT.id } }),
    roster: await prisma.abstractSpeaker.count({ where: { abstract: { eventId: SCRATCH_EVENT.id } } }),
    answers: await prisma.formAnswer.count({ where: { abstract: { eventId: SCRATCH_EVENT.id } } }),
    dispatches: await prisma.emailDispatch.count(),
  });
  const oversizeBefore = await publicCoreCounts();
  // This is intentionally just over the app-owned 128 KiB limit: sufficiently
  // small for a deterministic local request, but rejected before JSON.parse or
  // any rate/business write.
  const oversizeResponse = await fetch(BASE + "/api/cfp/submissions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-vercel-forwarded-for": "198.51.100.90" },
    body: JSON.stringify({ padding: "x".repeat(128 * 1024) }),
  });
  const oversize = { status: oversizeResponse.status, data: await oversizeResponse.json() };
  const oversizeAfter = await publicCoreCounts();
  check(
    "S19 app-owned 128 KiB rejection is 413 before parsing or writing core rows",
    oversize.status === 413 && oversize.data?.error?.code === "REQUEST_TOO_LARGE" &&
      JSON.stringify(oversizeAfter) === JSON.stringify(oversizeBefore),
    `${oversize.status} ${JSON.stringify(oversize.data)}`,
  );

  const strictBefore = await publicCoreCounts();
  const strictNested = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId,
    title: "S19 strict nested object",
    speakers: [{ email: "s19-strict@scratch.test", name: "Strict", isPrimary: true, ignored: true }],
    answers: {}, intent: "saveDraft",
  });
  const boundedAnswerKey = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId,
    title: "S19 bounded answer key",
    speakers: [{ email: "s19-bounded@scratch.test", name: "Bounded", isPrimary: true }],
    answers: { ["k".repeat(121)]: "too long" }, intent: "saveDraft",
  });
  const duplicateSpeaker = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId,
    title: "S19 duplicate speaker",
    speakers: [
      { email: "s19-duplicate@scratch.test", name: "Primary", isPrimary: true },
      { email: " S19-DUPLICATE@SCRATCH.TEST ", name: "Duplicate", isPrimary: false },
    ],
    answers: {}, intent: "saveDraft",
  });
  const strictAfter = await publicCoreCounts();
  check(
    "S19 public schema rejects strict extras, bounded keys, and duplicate normalized speakers before core writes",
    strictNested.status === 422 && boundedAnswerKey.status === 422 && duplicateSpeaker.status === 422 &&
      JSON.stringify(strictAfter) === JSON.stringify(strictBefore),
    `${strictNested.status}/${boundedAnswerKey.status}/${duplicateSpeaker.status}`,
  );

  const s19UnpublishedForm = await prisma.formConfig.create({
    data: {
      eventId: SCRATCH_EVENT.id, name: "S19 Unpublished", slug: `s19-unpublished-${Date.now()}`,
      published: false,
    },
  });
  const s19ClosedForm = await prisma.formConfig.create({
    data: {
      eventId: SCRATCH_EVENT.id, name: "S19 Closed", slug: `s19-closed-${Date.now()}`,
      published: true, closesAt: new Date(Date.now() - 60_000),
    },
  });
  const s19WindowAttempt = (formConfigId, intent, email) => j("POST", "/api/cfp/submissions", {
    formConfigId, title: `S19 ${intent} window refusal`,
    speakers: [{ email, name: "Window", isPrimary: true }],
    answers: { title_note: "window", consent: true }, intent,
  });
  const [unpublishedDraft, unpublishedSubmit, closedDraft, s19ClosedSubmit] = await Promise.all([
    s19WindowAttempt(s19UnpublishedForm.id, "saveDraft", "s19-unpublished-draft@scratch.test"),
    s19WindowAttempt(s19UnpublishedForm.id, "submit", "s19-unpublished-submit@scratch.test"),
    s19WindowAttempt(s19ClosedForm.id, "saveDraft", "s19-closed-draft@scratch.test"),
    s19WindowAttempt(s19ClosedForm.id, "submit", "s19-closed-submit@scratch.test"),
  ]);
  check(
    "S19 both public drafts and submits require a published, open form",
    unpublishedDraft.status === 422 && unpublishedDraft.data?.error?.code === "FORM_UNPUBLISHED" &&
      unpublishedSubmit.status === 422 && unpublishedSubmit.data?.error?.code === "FORM_UNPUBLISHED" &&
      closedDraft.status === 422 && closedDraft.data?.error?.code === "FORM_CLOSED" &&
      s19ClosedSubmit.status === 422 && s19ClosedSubmit.data?.error?.code === "FORM_CLOSED",
    `${unpublishedDraft.status}/${unpublishedSubmit.status}/${closedDraft.status}/${s19ClosedSubmit.status}`,
  );

  const rateTestIp = "198.51.100.91";
  const rateTestHeaders = { "x-vercel-forwarded-for": rateTestIp };
  const rateTestFingerprint = publicSubmissionRateFingerprint("ip", rateTestIp);
  const rateEmails = Array.from({ length: 21 }, (_, index) => `s19-rate-${index}@scratch.test`);
  const rateCoreBefore = await publicCoreCounts();
  const rateInvalidAttempts = [];
  for (let index = 0; index < 20; index++) {
    rateInvalidAttempts.push(await j("POST", "/api/cfp/submissions", {
      formConfigId: formId, title: `S19 rate business-invalid ${index}`,
      speakers: [{ email: rateEmails[index], name: "Rate", isPrimary: true }],
      answers: {}, intent: "submit",
    }, undefined, rateTestHeaders));
  }
  const rateBucketBeforeLimit = await prisma.$queryRaw`
    SELECT COALESCE(MAX("count"), 0)::int AS "count"
    FROM "PublicSubmissionRateBucket"
    WHERE "eventId" = ${SCRATCH_EVENT.id} AND "scope" = 'public_write_ip_10m'
      AND "fingerprint" = ${rateTestFingerprint}
  `;
  const rateLimited = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId, title: "S19 rate limited after invalid attempts",
    speakers: [{ email: rateEmails[20], name: "Rate", isPrimary: true }],
    answers: {}, intent: "submit",
  }, undefined, rateTestHeaders);
  const rateCoreAfter = await publicCoreCounts();
  // Every public refusal must say when it clears: `Retry-After` seconds plus
  // the same number in the JSON error. This bucket is the 10-minute IP window.
  const rateLimitedRetryAfter = Number(rateLimited.headers?.get("retry-after"));
  check(
    "S19 known-form business-invalid attempts durably consume the intended IP bucket and the next write is 429 without core writes",
    rateInvalidAttempts.every((attempt) => attempt.status === 422 && attempt.data?.error?.code === "FIELD_ERRORS") &&
      rateBucketBeforeLimit[0]?.count === 20 &&
      rateLimited.status === 429 && rateLimited.data?.error?.code === "PUBLIC_SUBMISSION_RATE_LIMITED" &&
      Number.isInteger(rateLimitedRetryAfter) && rateLimitedRetryAfter >= 1 && rateLimitedRetryAfter <= 600 &&
      rateLimited.data?.error?.retryAfterSeconds === rateLimitedRetryAfter &&
      PUBLIC_RATE_WAIT_PATTERN.test(rateLimited.data?.error?.message ?? "") &&
      JSON.stringify(rateCoreAfter) === JSON.stringify(rateCoreBefore),
    `${rateInvalidAttempts.map((attempt) => attempt.status).join(",")}/${rateBucketBeforeLimit[0]?.count}/${rateLimited.status}/${rateLimitedRetryAfter}`,
  );
  await prisma.$executeRaw`
    DELETE FROM "PublicSubmissionRateBucket" WHERE "eventId" = ${SCRATCH_EVENT.id}
  `;
  const rateBucketsAfterCleanup = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS "count" FROM "PublicSubmissionRateBucket" WHERE "eventId" = ${SCRATCH_EVENT.id}
  `;
  check("S19 scratch rate buckets are explicitly cleaned after the isolated throttle assertions", rateBucketsAfterCleanup[0]?.count === 0, rateBucketsAfterCleanup[0]?.count);

  // S19: the primary-email submit budget is 10 per 24h, not 3 — one speaker
  // legitimately submits several proposals plus edits in a sitting. Seed the
  // durable bucket to one below the cap so exactly two real requests prove the
  // boundary: the 10th clears the limiter (and is refused later, on business
  // validation), the 11th is throttled with an honest 24h-window retry moment.
  const s19EmailCapEmail = "s19-email-cap@scratch.test";
  const s19EmailWindowMs = 24 * 60 * 60 * 1_000;
  const s19EmailWindowStart = new Date(Math.floor(Date.now() / s19EmailWindowMs) * s19EmailWindowMs);
  await prisma.publicSubmissionRateBucket.create({
    data: {
      eventId: SCRATCH_EVENT.id,
      scope: "submit_primary_email_24h",
      fingerprint: publicSubmissionRateFingerprint("primary-email", s19EmailCapEmail),
      windowStart: s19EmailWindowStart,
      count: 9,
      expiresAt: new Date(s19EmailWindowStart.getTime() + s19EmailWindowMs),
    },
  });
  const s19EmailCapAttempt = (index) => j("POST", "/api/cfp/submissions", {
    formConfigId: formId, title: `S19 email cap attempt ${index}`,
    speakers: [{ email: s19EmailCapEmail, name: "Cap", isPrimary: true }],
    answers: {}, intent: "submit",
  });
  const s19EmailCoreBefore = await publicCoreCounts();
  const s19EmailAtCap = await s19EmailCapAttempt(10);
  const s19EmailOverCap = await s19EmailCapAttempt(11);
  const s19EmailCoreAfter = await publicCoreCounts();
  const s19EmailRetryAfter = Number(s19EmailOverCap.headers?.get("retry-after"));
  check(
    "S19 the primary-email submit budget admits 10 per 24h and the 11th is 429 with a real retry moment and no core writes",
    s19EmailAtCap.status === 422 && s19EmailAtCap.data?.error?.code === "FIELD_ERRORS" &&
      s19EmailOverCap.status === 429 && s19EmailOverCap.data?.error?.code === "PUBLIC_SUBMISSION_RATE_LIMITED" &&
      Number.isInteger(s19EmailRetryAfter) && s19EmailRetryAfter >= 1 && s19EmailRetryAfter <= s19EmailWindowMs / 1_000 &&
      s19EmailOverCap.data?.error?.retryAfterSeconds === s19EmailRetryAfter &&
      PUBLIC_RATE_WAIT_PATTERN.test(s19EmailOverCap.data?.error?.message ?? "") &&
      JSON.stringify(s19EmailCoreAfter) === JSON.stringify(s19EmailCoreBefore),
    `${s19EmailAtCap.status}/${s19EmailOverCap.status}/${s19EmailRetryAfter}`,
  );
  await prisma.$executeRaw`
    DELETE FROM "PublicSubmissionRateBucket" WHERE "eventId" = ${SCRATCH_EVENT.id}
  `;
  const s19EmailCapBucketsAfterCleanup = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS "count" FROM "PublicSubmissionRateBucket" WHERE "eventId" = ${SCRATCH_EVENT.id}
  `;
  check("S19 scratch primary-email cap buckets are explicitly cleaned after the boundary assertion", s19EmailCapBucketsAfterCleanup[0]?.count === 0, s19EmailCapBucketsAfterCleanup[0]?.count);

  // S20: the event-wide bucket applies to every public intent. Establish the
  // durable count with distinct, smoke-isolated IPs, then set only the scratch
  // bucket to its documented limit so a final HTTP attempt proves the 429
  // boundary without sending 121 real requests.
  const s20EventRateCoreBefore = await publicCoreCounts();
  const s20EventRateAttempts = [];
  for (let index = 0; index < 3; index++) {
    s20EventRateAttempts.push(await j("POST", "/api/cfp/submissions", {
      formConfigId: s19ClosedForm.id, title: `S20 rotating-IP draft ${index}`,
      speakers: [{ email: `s20-event-rate-${index}@scratch.test`, name: "Rate", isPrimary: true }],
      answers: {}, intent: "saveDraft",
    }));
  }
  const s20EventBucket = await prisma.$queryRaw`
    SELECT "id", "count"::int AS "count"
    FROM "PublicSubmissionRateBucket"
    WHERE "eventId" = ${SCRATCH_EVENT.id} AND "scope" = 'public_write_event_1h'
  `;
  const s20IpBuckets = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS "count"
    FROM "PublicSubmissionRateBucket"
    WHERE "eventId" = ${SCRATCH_EVENT.id} AND "scope" = 'public_write_ip_10m'
  `;
  if (s20EventBucket[0]) {
    await prisma.$executeRaw`
      UPDATE "PublicSubmissionRateBucket"
      SET "count" = 120, "updatedAt" = ${new Date()}
      WHERE "id" = ${s20EventBucket[0].id}
    `;
  }
  const s20EventLimited = await j("POST", "/api/cfp/submissions", {
    formConfigId: s19ClosedForm.id, title: "S20 event ceiling",
    speakers: [{ email: "s20-event-rate-limited@scratch.test", name: "Rate", isPrimary: true }],
    answers: {}, intent: "saveDraft",
  });
  const s20EventRateCoreAfter = await publicCoreCounts();
  // The event ceiling refuses on a one-hour window, so its advertised wait
  // must fall inside that hour rather than repeat a generic "please wait".
  const s20EventRetryAfter = Number(s20EventLimited.headers?.get("retry-after"));
  check(
    "S20 rotating-IP invalid drafts durably reach the all-intent event ceiling without core writes",
    s20EventRateAttempts.every((attempt) => attempt.status === 422 && attempt.data?.error?.code === "FORM_CLOSED") &&
      s20EventBucket[0]?.count === 3 && s20IpBuckets[0]?.count === 3 &&
      s20EventLimited.status === 429 && s20EventLimited.data?.error?.code === "PUBLIC_SUBMISSION_RATE_LIMITED" &&
      Number.isInteger(s20EventRetryAfter) && s20EventRetryAfter >= 1 && s20EventRetryAfter <= 3_600 &&
      s20EventLimited.data?.error?.retryAfterSeconds === s20EventRetryAfter &&
      PUBLIC_RATE_WAIT_PATTERN.test(s20EventLimited.data?.error?.message ?? "") &&
      JSON.stringify(s20EventRateCoreAfter) === JSON.stringify(s20EventRateCoreBefore),
    `${s20EventRateAttempts.map((attempt) => attempt.status).join(",")}/${s20EventBucket[0]?.count}/${s20IpBuckets[0]?.count}/${s20EventLimited.status}/${s20EventRetryAfter}`,
  );
  await prisma.$executeRaw`
    DELETE FROM "PublicSubmissionRateBucket" WHERE "eventId" = ${SCRATCH_EVENT.id}
  `;
  const s20RateBucketsAfterCleanup = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS "count" FROM "PublicSubmissionRateBucket" WHERE "eventId" = ${SCRATCH_EVENT.id}
  `;
  check("S20 scratch event-rate buckets are explicitly cleaned after the isolated ceiling assertion", s20RateBucketsAfterCleanup[0]?.count === 0, s20RateBucketsAfterCleanup[0]?.count);

  // S20: seed only scratch drafts to exercise the exact filtered envelope.
  // The future createdAt values leave the existing v1 createdAt-ASC smoke page
  // intact. Null submittedAt still proves these drafts trail submissions in
  // the admin submitted-first order.
  const s20ListSubmitter = await prisma.user.findUniqueOrThrow({
    where: { email: admin.user.email }, select: { id: true },
  });
  await prisma.abstract.createMany({
    data: Array.from({ length: 101 }, (_, index) => ({
      eventId: SCRATCH_EVENT.id,
      formConfigId: formId,
      submitterId: s20ListSubmitter.id,
      title: `S20 bounded draft ${String(index).padStart(3, "0")}`,
      status: "DRAFT",
      createdAt: new Date("2100-01-01T00:00:00.000Z"),
    })),
  });
  const s20BoundedList = await j("GET", `/api/cfp/submissions?status=DRAFT&formConfigId=${formId}`, null, admin);
  check(
    "S20 filtered abstract GET returns a capped, honest envelope",
    s20BoundedList.status === 200 && s20BoundedList.data?.data?.abstracts?.length === 100 &&
      s20BoundedList.data?.data?.total === 101 && s20BoundedList.data?.data?.hasMore === true &&
      s20BoundedList.data?.data?.abstracts?.every((item) => item.title.startsWith("S20 bounded draft ")),
    `${s20BoundedList.status}/${s20BoundedList.data?.data?.abstracts?.length}/${s20BoundedList.data?.data?.total}/${s20BoundedList.data?.data?.hasMore}`,
  );

  // M5: active-event settings are admin-only and use event-local calendar
  // dates, never the browser's timezone. Rooms are scoped server-side too.
  const settingsAnonymous = await j("GET", "/api/admin/settings");
  check("M5 settings require sign-in", settingsAnonymous.status === 401, settingsAnonymous.status);
  const settingsSpeaker = await j("GET", "/api/admin/settings", null, speaker);
  check("M5 settings refuse speakers", settingsSpeaker.status === 403, settingsSpeaker.status);
  const settings = await j("GET", "/api/admin/settings", null, admin);
  check("M5 settings returns only the active event plus rooms, tracks, and categories",
    settings.status === 200 &&
      settings.data?.data?.event?.id === SCRATCH_EVENT.id &&
      settings.data?.data?.event?.timezone === "UTC" &&
      settings.data?.data?.rooms?.length === 2 &&
      settings.data?.data?.tracks?.[0]?.name === "Scratch Track" &&
      JSON.stringify(settings.data?.data?.categories?.map((category) => category.name)) ===
        JSON.stringify(["AI", "Community", "Systems"]),
    JSON.stringify(settings.data?.data));
  const badSettingsZone = await j("PATCH", "/api/admin/settings", { timezone: "Mars/Olympus_Mons" }, admin);
  check("M5 invalid IANA timezone is refused", badSettingsZone.status === 422, badSettingsZone.status);
  const badSettingsRange = await j("PATCH", "/api/admin/settings", {
    startsOn: "2026-05-14", endsOn: "2026-05-12",
  }, admin);
  check("M5 event date range is ordered server-side", badSettingsRange.status === 422, badSettingsRange.status);
  const forgedSettingsEvent = await j("PATCH", "/api/admin/settings", {
    eventId: "demo-event", name: "Forged event update",
  }, admin);
  check("M5 settings derives event scope from the session, not a request id", forgedSettingsEvent.status === 422, forgedSettingsEvent.status);
  const datedSettings = await j("PATCH", "/api/admin/settings", {
    name: "Settings Scratch Event", timezone: "America/Los_Angeles", startsOn: "2026-05-12", endsOn: "2026-05-14",
  }, admin);
  check("M5 settings stores and serializes event-local dates",
    datedSettings.status === 200 &&
      datedSettings.data?.data?.event?.name === "Settings Scratch Event" &&
      datedSettings.data?.data?.event?.timezone === "America/Los_Angeles" &&
      datedSettings.data?.data?.event?.startsOn === "2026-05-12" &&
      datedSettings.data?.data?.event?.endsOn === "2026-05-14",
    JSON.stringify(datedSettings.data?.data));
  const timezoneOnly = await j("PATCH", "/api/admin/settings", { timezone: "America/New_York" }, admin);
  check("M5 timezone-only settings update preserves local event dates",
    timezoneOnly.status === 200 &&
      timezoneOnly.data?.data?.event?.timezone === "America/New_York" &&
      timezoneOnly.data?.data?.event?.startsOn === "2026-05-12" &&
      timezoneOnly.data?.data?.event?.endsOn === "2026-05-14",
    JSON.stringify(timezoneOnly.data?.data));

  const roomsBefore = await j("GET", "/api/admin/settings/rooms", null, admin);
  check("M5 room read is event-scoped and stable", roomsBefore.status === 200 && roomsBefore.data?.data?.rooms?.length === 2, roomsBefore.status);
  const roomSpeaker = await j("POST", "/api/admin/settings/rooms", { name: "No speaker room" }, speaker);
  check("M5 room writes refuse speakers", roomSpeaker.status === 403, roomSpeaker.status);
  const newRoom = await j("POST", "/api/admin/settings/rooms", {
    name: "Settings Room", capacity: 42, sortOrder: 8,
  }, admin);
  const settingsRoomId = newRoom.data?.data?.room?.id;
  check("M5 admin creates an event-scoped room", newRoom.status === 201 && !!settingsRoomId, newRoom.status);
  const duplicateRoom = await j("POST", "/api/admin/settings/rooms", {
    name: "Settings Room", capacity: 42,
  }, admin);
  check("M5 duplicate room names are refused", duplicateRoom.status === 409 && duplicateRoom.data?.error?.code === "ROOM_NAME_TAKEN", duplicateRoom.status);
  const invalidRoom = await j("POST", "/api/admin/settings/rooms", { name: "Bad Room", capacity: 0 }, admin);
  check("M5 invalid room capacity is refused", invalidRoom.status === 422, invalidRoom.status);
  const updatedRoom = await j("PATCH", "/api/admin/settings/rooms", {
    id: settingsRoomId, capacity: null, sortOrder: 9,
  }, admin);
  check("M5 admin updates the active event room", updatedRoom.status === 200 && updatedRoom.data?.data?.room?.capacity === null && updatedRoom.data?.data?.room?.sortOrder === 9, updatedRoom.status);
  const otherRoom = await prisma.room.findFirstOrThrow({ where: { eventId: OTHER_SCRATCH_EVENT.id }, select: { id: true } });
  const crossEventRoom = await j("PATCH", "/api/admin/settings/rooms", { id: otherRoom.id, name: "Nope" }, admin);
  check("M5 room updates cannot target another event", crossEventRoom.status === 404 && crossEventRoom.data?.error?.code === "ROOM_NOT_FOUND", crossEventRoom.status);
  const crossEventRoomDelete = await j("DELETE", `/api/admin/settings/rooms?roomId=${otherRoom.id}`, null, admin);
  const otherRoomAfterCrossEventDelete = await prisma.room.findUnique({ where: { id: otherRoom.id }, select: { id: true } });
  check("M5 room deletion cannot target another event", crossEventRoomDelete.status === 404 && crossEventRoomDelete.data?.error?.code === "ROOM_NOT_FOUND" && otherRoomAfterCrossEventDelete?.id === otherRoom.id, crossEventRoomDelete.status);
  const unusedRoomDelete = await j("DELETE", `/api/admin/settings/rooms?roomId=${settingsRoomId}`, null, admin);
  const deletedRoom = await prisma.room.findUnique({ where: { id: settingsRoomId }, select: { id: true } });
  check("M5 admin deletes an unused event-scoped room", unusedRoomDelete.status === 200 && unusedRoomDelete.data?.data?.room?.id === settingsRoomId && !deletedRoom, unusedRoomDelete.status);

  const m5Category = await j("POST", "/api/cfp/categories", {
    eventId: OTHER_SCRATCH_EVENT.id, name: "Settings Category", sortOrder: 9,
  }, admin);
  check("S1 category create derives event scope from the session, never the body",
    m5Category.status === 201 &&
      m5Category.data?.data?.eventId === SCRATCH_EVENT.id &&
      !!m5Category.data?.data?.id,
    m5Category.status);
  const duplicateM5Category = await j("POST", "/api/cfp/categories", {
    eventId: OTHER_SCRATCH_EVENT.id, name: "Settings Category", sortOrder: 9,
  }, admin);
  check(
    "S1 category duplicate-name races return an actionable conflict",
    duplicateM5Category.status === 409 && duplicateM5Category.data?.error?.code === "CATEGORY_NAME_TAKEN",
    duplicateM5Category.status,
  );
  const otherCategory = await prisma.category.create({
    data: { eventId: OTHER_SCRATCH_EVENT.id, name: "Other Event Category", sortOrder: 0 },
  });
  const crossEventCategory = await j("POST", "/api/cfp/categories", {
    id: otherCategory.id,
    eventId: SCRATCH_EVENT.id,
    name: "Unauthorized category change",
    sortOrder: 0,
  }, admin);
  const otherCategoryAfterCrossEventUpdate = await prisma.category.findUnique({
    where: { id: otherCategory.id },
    select: { name: true },
  });
  check("S1 category update refuses unknown and cross-event ids without changing the other event",
    crossEventCategory.status === 404 &&
      crossEventCategory.data?.error?.code === "CATEGORY_NOT_FOUND" &&
      otherCategoryAfterCrossEventUpdate?.name === "Other Event Category",
    crossEventCategory.status);

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
  let b2SubmissionSequence = 0;
  const b2Submit = (body) => j("POST", "/api/cfp/submissions", {
    ...b2Base,
    ...body,
    // Every example is an independent anonymous attempt. Keep fixture-only
    // identities apart so S20's real per-primary submit ceiling does not turn
    // later content-validation cases into rate-limit cases.
    speakers: [{ email: `b2-${++b2SubmissionSequence}@scratch.test`, name: "B2 Speaker", isPrimary: true }],
  });
  const b2Hidden = await b2Submit({ answers: { title_note: "n", consent: true, audience: "beginner" } });
  check("B2 a required field that was never shown does not block submission",
    b2Hidden.status === 201, `${b2Hidden.status} ${JSON.stringify(b2Hidden.data?.error?.fieldErrors ?? {})}`);

  const b2Revealed = await b2Submit({ answers: { title_note: "n", consent: true, audience: "advanced" } });
  check("B2 the same field is required once its condition is met",
    b2Revealed.status === 422 && !!b2Revealed.data?.error?.fieldErrors?.workshop_needs,
    b2Revealed.data?.error?.code);

  const b2Answered = await b2Submit({ answers: { title_note: "n", consent: true, audience: "advanced", workshop_needs: "Two power sockets" } });
  check("B2 answering the revealed field submits cleanly", b2Answered.status === 201, b2Answered.status);

  const b2BadOption = await b2Submit({ answers: { title_note: "n", consent: true, audience: "smuggled-option" } });
  check("B2 a select answer outside the options is refused",
    b2BadOption.status === 422 && !!b2BadOption.data?.error?.fieldErrors?.audience, b2BadOption.data?.error?.code);

  const b2BadMulti = await b2Submit({ answers: { title_note: "n", consent: true, topics: ["ai", "quantum"] } });
  check("B2 a multi-select answer outside the options is refused",
    b2BadMulti.status === 422 && !!b2BadMulti.data?.error?.fieldErrors?.topics, b2BadMulti.data?.error?.code);

  const b2BadNumber = await b2Submit({ answers: { title_note: "n", consent: true, rating: "not a number" } });
  check("B2 a non-numeric answer to a number field is refused",
    b2BadNumber.status === 422 && !!b2BadNumber.data?.error?.fieldErrors?.rating, b2BadNumber.data?.error?.code);

  const b2BadUrl = await b2Submit({ answers: { title_note: "n", consent: true, website: "definitely not a url" } });
  check("B2 an invalid URL answer is refused",
    b2BadUrl.status === 422 && !!b2BadUrl.data?.error?.fieldErrors?.website, b2BadUrl.data?.error?.code);

  const b2UnsafeUrl = await b2Submit({ answers: { title_note: "n", consent: true, website: "javascript:alert(1)" } });
  check("B2 a non-HTTP URL scheme is refused",
    b2UnsafeUrl.status === 422 && !!b2UnsafeUrl.data?.error?.fieldErrors?.website, b2UnsafeUrl.data?.error?.code);

  const b2Unticked = await b2Submit({ answers: { title_note: "n", consent: false } });
  check("B2 a required checkbox must be ticked, not merely answered",
    b2Unticked.status === 422 && !!b2Unticked.data?.error?.fieldErrors?.consent, b2Unticked.data?.error?.code);

  const b2WrongType = await b2Submit({ answers: { title_note: "n", consent: "yes" } });
  check("B2 a checkbox answered with a string is refused",
    b2WrongType.status === 422 && !!b2WrongType.data?.error?.fieldErrors?.consent, b2WrongType.data?.error?.code);

  const s1UsedFormDelete = await j("DELETE", `/api/cfp/forms/${formId}`, null, admin);
  check(
    "S1 form delete re-runs the existing Abstract-use guard while locked",
    s1UsedFormDelete.status === 409 && s1UsedFormDelete.data?.error?.code === "FORM_HAS_ABSTRACTS",
    s1UsedFormDelete.status,
  );

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

  // C4 + B5 together: answers are stored by an option's value, never by its
  // wording. Rewording a chosen option is always free; changing its stored
  // value is the same destructive edit B5 already refuses.
  const c4Relabel = await j("POST", "/api/cfp/forms", {
    ...formPayload, id: formId,
    fields: formPayload.fields.map((f) => f.key === "audience"
      ? { ...f, options: [{ label: "New to the topic", value: "beginner" }, { label: "Deeply experienced", value: "advanced" }] } : f),
  }, admin);
  check("C4 rewording a chosen option without touching its value is allowed",
    c4Relabel.status === 200, c4Relabel.data?.error?.code ?? c4Relabel.status);

  const c4Revalue = await j("POST", "/api/cfp/forms", {
    ...formPayload, id: formId,
    fields: formPayload.fields.map((f) => f.key === "audience"
      ? { ...f, options: [{ label: "Beginner", value: "beginner_v2" }, { label: "Advanced", value: "advanced" }] } : f),
  }, admin);
  check("C4 changing the stored value of a chosen option is still refused (409 FIELD_IN_USE)",
    c4Revalue.status === 409 && c4Revalue.data?.error?.code === "FIELD_IN_USE" &&
    !!c4Revalue.data?.error?.fieldErrors?.audience, c4Revalue.data?.error?.code);

  const c4BlankOption = await j("POST", "/api/cfp/forms", {
    ...formPayload, id: formId,
    fields: formPayload.fields.map((f) => f.key === "audience"
      ? { ...f, options: [...f.options, { label: "Not sure", value: "  " }] } : f),
  }, admin);
  check("C4 an option with no stored value is refused (400 FORM_OPTION_VALUE_EMPTY)",
    c4BlankOption.status === 400 && c4BlankOption.data?.error?.code === "FORM_OPTION_VALUE_EMPTY" &&
    !!c4BlankOption.data?.error?.fieldErrors?.audience, c4BlankOption.data?.error?.code);

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
  check(
    "valid direct new submit remains compatible without a draft capability",
    sub.status === 201 && sub.data?.data?.status === "SUBMITTED" &&
      !Object.hasOwn(sub.data?.data ?? {}, "draftCapability") && !Object.hasOwn(sub.data?.data ?? {}, "draftRevision"),
    sub.status,
  );
  const abstractId = sub.data?.data?.id;
  check("co-speaker upserted by email", sub.data?.data?.speakers?.length === 2);
  const submissionDispatches = await prisma.emailDispatch.findMany({
    where: { templateId: commsTemplate.id },
    select: { recipient: true, status: true, providerId: true },
    orderBy: { recipient: "asc" },
  });
  check(
    "S19 public submit records exactly one receipt for its primary submitter",
    JSON.stringify(submissionDispatches.map((row) => row.recipient)) ===
      JSON.stringify(["spk@x.com"]),
    JSON.stringify(submissionDispatches.map((row) => row.recipient)),
  );
  check(
    "O2 smoke delivery is mocked before any provider call",
    submissionDispatches.every((row) => row.status === "mocked" && row.providerId?.startsWith("mock:")),
  );

  // S17/S7: a brand-new anonymous draft emits one browser capability, while
  // the database receives only its domain-separated HMAC. Every later write
  // proves the capability/revision under LOCK-ORDER-v1 before any User,
  // roster, answer, or receipt mutation.
  const s17DraftInput = {
    formConfigId: formId,
    title: "S17 resumable draft",
    abstract: "Scratch-only capability recovery",
    speakers: [{ email: "s17-draft@scratch.test", name: "S17 Draft", isPrimary: true }],
    answers: { title_note: "draft", consent: true },
    intent: "saveDraft",
  };
  const s17Create = await j("POST", "/api/cfp/submissions", s17DraftInput);
  const s17DraftId = s17Create.data?.data?.id;
  const s17Capability = s17Create.data?.data?.draftCapability;
  const s17Created = s17DraftId
    ? await prisma.abstract.findUnique({
      where: { id: s17DraftId },
      select: { id: true, submitterId: true, status: true, draftCapabilityHash: true, draftRevision: true },
    })
    : null;
  const s17CapabilityOccurrences = typeof s17Capability === "string"
    ? JSON.stringify(s17Create.data).split(s17Capability).length - 1
    : 0;
  check(
    "S17 new DRAFT emits one 43-character capability and persists only its 64-hex HMAC at revision 1",
    s17Create.status === 201 && typeof s17Capability === "string" && /^[A-Za-z0-9_-]{43}$/.test(s17Capability) &&
      s17CapabilityOccurrences === 1 && s17Created?.status === "DRAFT" && s17Created.draftRevision === 1 &&
      s17Created.draftCapabilityHash === publicDraftCapabilityHash(s17Capability) &&
      /^[a-f0-9]{64}$/.test(s17Created.draftCapabilityHash ?? "") && !s17Created.draftCapabilityHash?.includes(s17Capability),
    `${s17Create.status}/${typeof s17Capability}/${s17Created?.draftRevision}/${s17CapabilityOccurrences}`,
  );

  const s17Resume = await j("POST", "/api/cfp/submissions/resume", {
    formConfigId: formId, abstractId: s17DraftId, draftCapability: s17Capability,
  });
  const s17ResumeKeys = Object.keys(s17Resume.data?.data ?? {}).sort();
  const s17ResumeSpeakerKeys = Object.keys(s17Resume.data?.data?.speakers?.[0] ?? {}).sort();
  check(
    "S17 resume is no-store and returns only narrow editable state plus revision",
    s17Resume.status === 200 && s17Resume.headers.get("cache-control") === "no-store" &&
      JSON.stringify(s17ResumeKeys) === JSON.stringify([
        "abstract", "answersByKey", "categoryId", "draftRevision", "durationMinutes", "format", "id", "speakers", "title",
      ]) &&
      JSON.stringify(s17ResumeSpeakerKeys) === JSON.stringify(["email", "isPrimary", "name"]) &&
      s17Resume.data?.data?.answersByKey?.title_note === "draft" && s17Resume.data?.data?.draftRevision === 1,
    `${s17Resume.status}/${s17Resume.headers.get("cache-control")}/${JSON.stringify(s17ResumeKeys)}`,
  );

  const s17Save = await j("POST", "/api/cfp/submissions", {
    ...s17DraftInput,
    abstractId: s17DraftId,
    draftCapability: s17Capability,
    expectedDraftRevision: 1,
    title: "S17 saved draft",
  });
  const s17Saved = s17DraftId
    ? await prisma.abstract.findUnique({ where: { id: s17DraftId }, select: { draftRevision: true, draftCapabilityHash: true } })
    : null;
  check(
    "S17 valid draft save advances revision 1 to 2 without reissuing the capability",
    s17Save.status === 200 && s17Save.data?.data?.draftRevision === 2 &&
      !Object.hasOwn(s17Save.data?.data ?? {}, "draftCapability") && s17Saved?.draftRevision === 2 &&
      s17Saved.draftCapabilityHash === publicDraftCapabilityHash(s17Capability ?? ""),
    `${s17Save.status}/${s17Save.data?.data?.draftRevision}/${Object.hasOwn(s17Save.data?.data ?? {}, "draftCapability")}`,
  );

  const s17NoWriteBeforeFailures = await publicDraftCoreCounts();
  const s17ExistingDraftInput = {
    ...s17DraftInput,
    abstractId: s17DraftId,
    expectedDraftRevision: 2,
  };
  const s17CapabilityFailures = [];
  for (const draftCapability of [undefined, "", "x".repeat(129), { wrong: true }, "B".repeat(43)]) {
    s17CapabilityFailures.push(await j("POST", "/api/cfp/submissions", {
      ...s17ExistingDraftInput,
      ...(draftCapability === undefined ? {} : { draftCapability }),
    }));
  }
  const s17CrossForm = await j("POST", "/api/cfp/submissions", {
    ...s17ExistingDraftInput, formConfigId: s19ClosedForm.id, draftCapability: s17Capability,
  });
  const s17StaleRevision = await j("POST", "/api/cfp/submissions", {
    ...s17ExistingDraftInput, draftCapability: s17Capability, expectedDraftRevision: 0,
  });
  const s17NoWriteAfterFailures = await publicDraftCoreCounts();
  const isDraftNotFound = (response) => response.status === 404 && response.data?.error?.code === "DRAFT_NOT_FOUND";
  check(
    "S17 missing, empty, oversize, wrong-type, wrong, and cross-form capabilities are one generic no-write 404",
    s17CapabilityFailures.every(isDraftNotFound) && isDraftNotFound(s17CrossForm) &&
      JSON.stringify(s17NoWriteAfterFailures) === JSON.stringify(s17NoWriteBeforeFailures),
    `${s17CapabilityFailures.map((response) => response.status).join(",")}/${s17CrossForm.status}/${JSON.stringify(s17NoWriteAfterFailures)}`,
  );
  check(
    "S17 a valid capability with stale revision 0 returns 409 without writes",
    s17StaleRevision.status === 409 && s17StaleRevision.data?.error?.code === "DRAFT_CONFLICT" &&
      JSON.stringify(s17NoWriteAfterFailures) === JSON.stringify(s17NoWriteBeforeFailures),
    `${s17StaleRevision.status}/${s17StaleRevision.data?.error?.code}`,
  );

  const s17LegacyDraft = s17Created
    ? await prisma.abstract.create({
      data: {
        eventId: SCRATCH_EVENT.id, formConfigId: formId, submitterId: s17Created.submitterId,
        title: "S17 legacy capability-less draft", status: "DRAFT", draftRevision: 0, draftCapabilityHash: null,
      },
      select: { id: true },
    })
    : null;
  const s17NoWriteBeforeLegacyFailures = await publicDraftCoreCounts();
  const s17NonDraft = await j("POST", "/api/cfp/submissions", {
    ...s17ExistingDraftInput, abstractId, draftCapability: s17Capability,
  });
  const s17Legacy = await j("POST", "/api/cfp/submissions", {
    ...s17ExistingDraftInput, abstractId: s17LegacyDraft?.id, draftCapability: s17Capability, expectedDraftRevision: 0,
  });
  const s17NoWriteAfterLegacyFailures = await publicDraftCoreCounts();
  check(
    "S17 non-DRAFT and legacy-null capabilities are generic no-write 404 responses",
    isDraftNotFound(s17NonDraft) && isDraftNotFound(s17Legacy) &&
      JSON.stringify(s17NoWriteAfterLegacyFailures) === JSON.stringify(s17NoWriteBeforeLegacyFailures),
    `${s17NonDraft.status}/${s17Legacy.status}/${JSON.stringify(s17NoWriteAfterLegacyFailures)}`,
  );

  const s17ResumeNoWriteBefore = await publicDraftCoreCounts();
  const s17ResumeFailures = [];
  for (const draftCapability of [undefined, "", "C".repeat(43), { wrong: true }]) {
    s17ResumeFailures.push(await j("POST", "/api/cfp/submissions/resume", {
      formConfigId: formId,
      abstractId: s17DraftId,
      ...(draftCapability === undefined ? {} : { draftCapability }),
    }));
  }
  const s17ResumeCrossForm = await j("POST", "/api/cfp/submissions/resume", {
    formConfigId: s19ClosedForm.id, abstractId: s17DraftId, draftCapability: s17Capability,
  });
  const s17ResumeNonDraft = await j("POST", "/api/cfp/submissions/resume", {
    formConfigId: formId, abstractId, draftCapability: s17Capability,
  });
  const s17ResumeLegacy = await j("POST", "/api/cfp/submissions/resume", {
    formConfigId: formId, abstractId: s17LegacyDraft?.id, draftCapability: s17Capability,
  });
  const s17ResumeNoWriteAfter = await publicDraftCoreCounts();
  check(
    "S17 resume missing, empty, wrong, wrong-type, cross-form, non-DRAFT, and legacy-null paths are generic no-write 404s",
    s17ResumeFailures.every(isDraftNotFound) && isDraftNotFound(s17ResumeCrossForm) &&
      isDraftNotFound(s17ResumeNonDraft) && isDraftNotFound(s17ResumeLegacy) &&
      JSON.stringify(s17ResumeNoWriteAfter) === JSON.stringify(s17ResumeNoWriteBefore),
    `${s17ResumeFailures.map((response) => response.status).join(",")}/${s17ResumeCrossForm.status}/${s17ResumeNonDraft.status}/${s17ResumeLegacy.status}`,
  );

  // Hold the final class, turn the draft terminal, then release the waiting
  // public writer. Its fresh post-lock read must refuse without any mutation.
  const s17ContentionCreate = await j("POST", "/api/cfp/submissions", {
    ...s17DraftInput,
    title: "S17 contention draft",
    speakers: [{ email: "s17-contention@scratch.test", name: "S17 Contention", isPrimary: true }],
  });
  const s17ContentionId = s17ContentionCreate.data?.data?.id;
  const s17ContentionCapability = s17ContentionCreate.data?.data?.draftCapability;
  let signalS17AbstractLock;
  let releaseS17AbstractLock;
  const s17AbstractLockHeld = new Promise((resolve) => { signalS17AbstractLock = resolve; });
  const s17AbstractLockRelease = new Promise((resolve) => { releaseS17AbstractLock = resolve; });
  const s17AbstractHolder = prisma.$transaction(async (tx) => {
    const key = `abstract-write:${s17ContentionId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    signalS17AbstractLock();
    await s17AbstractLockRelease;
    await tx.abstract.update({
      where: { id: s17ContentionId },
      data: { status: "SUBMITTED", submittedAt: new Date(), draftCapabilityHash: null },
    });
  });
  await s17AbstractLockHeld;
  const pendingAdvisoryLocks = async () => {
    const rows = await prisma.$queryRaw`
      SELECT count(*)::int AS "count" FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
    `;
    return rows[0]?.count ?? 0;
  };
  const s17PendingBaseline = await pendingAdvisoryLocks();
  const s17ContentionAbort = new AbortController();
  const s17WaitingWriter = j("POST", "/api/cfp/submissions", {
    ...s17DraftInput,
    abstractId: s17ContentionId,
    draftCapability: s17ContentionCapability,
    expectedDraftRevision: 1,
    title: "S17 stale contention overwrite",
  }, undefined, {}, { signal: s17ContentionAbort.signal });
  let s17ObservedWait = false;
  let s17WaitingObservation;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await pendingAdvisoryLocks() > s17PendingBaseline) {
        s17ObservedWait = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    releaseS17AbstractLock();
    await s17AbstractHolder;
    s17WaitingObservation = await observeBeforeDeadline(s17WaitingWriter, 5_000);
  } finally {
    if (!s17WaitingObservation?.completed) s17ContentionAbort.abort();
    releaseS17AbstractLock();
    await s17AbstractHolder.catch(() => {});
  }
  const s17ContentionAfter = s17ContentionId
    ? await prisma.abstract.findUnique({
      where: { id: s17ContentionId },
      include: { speakers: true, answers: true },
    })
    : null;
  check(
    "S17 held Abstract writer waits, re-reads terminal state, and leaves roster/answers/revision unchanged",
    s17ContentionCreate.status === 201 && s17ObservedWait && s17WaitingObservation?.completed &&
      !s17WaitingObservation.error && isDraftNotFound(s17WaitingObservation.value) &&
      s17ContentionAfter?.status === "SUBMITTED" && s17ContentionAfter.draftCapabilityHash === null &&
      s17ContentionAfter.draftRevision === 1 && s17ContentionAfter.title === "S17 contention draft" &&
      s17ContentionAfter.speakers.length === 1 && s17ContentionAfter.answers.length === 2,
    `${s17ContentionCreate.status}/${s17ObservedWait}/${s17WaitingObservation?.completed}/${s17WaitingObservation?.value?.status}/${s17ContentionAfter?.status}`,
  );

  const s17DispatchesBeforeSubmit = await prisma.emailDispatch.count({ where: { templateId: commsTemplate.id } });
  const s17Submit = await j("POST", "/api/cfp/submissions", {
    ...s17ExistingDraftInput, draftCapability: s17Capability, expectedDraftRevision: 2, intent: "submit",
  });
  const s17AfterSubmit = s17DraftId
    ? await prisma.abstract.findUnique({ where: { id: s17DraftId }, select: { status: true, draftCapabilityHash: true, draftRevision: true } })
    : null;
  const s17DispatchesAfterSubmit = await prisma.emailDispatch.findMany({
    where: { templateId: commsTemplate.id }, select: { recipient: true }, orderBy: { id: "asc" },
  });
  const s17ReplayCoreBefore = await publicDraftCoreCounts();
  const s17Replay = await j("POST", "/api/cfp/submissions", {
    ...s17ExistingDraftInput, draftCapability: s17Capability, expectedDraftRevision: 3, intent: "submit",
  });
  const s17ReplayCoreAfter = await publicDraftCoreCounts();
  check(
    "S17 existing submit atomically revokes its capability and emits one receipt only on the real transition",
    s17Submit.status === 200 && s17AfterSubmit?.status === "SUBMITTED" && s17AfterSubmit.draftCapabilityHash === null &&
      s17AfterSubmit.draftRevision === 3 && !Object.hasOwn(s17Submit.data?.data ?? {}, "draftCapability") &&
      s17DispatchesAfterSubmit.length === s17DispatchesBeforeSubmit + 1 &&
      s17DispatchesAfterSubmit.filter((row) => row.recipient === "s17-draft@scratch.test").length === 1,
    `${s17Submit.status}/${s17AfterSubmit?.draftRevision}/${s17DispatchesBeforeSubmit}->${s17DispatchesAfterSubmit.length}`,
  );
  check(
    "S17 revoked-capability replay is generic 404 and cannot duplicate the receipt or core writes",
    isDraftNotFound(s17Replay) && JSON.stringify(s17ReplayCoreAfter) === JSON.stringify(s17ReplayCoreBefore),
    `${s17Replay.status}/${JSON.stringify(s17ReplayCoreAfter)}`,
  );
  const s17ResumeRevokedBefore = await publicDraftCoreCounts();
  const s17ResumeRevoked = await j("POST", "/api/cfp/submissions/resume", {
    formConfigId: formId, abstractId: s17DraftId, draftCapability: s17Capability,
  });
  const s17ResumeRevokedAfter = await publicDraftCoreCounts();
  check(
    "S17 resume after an actual submit sees a revoked capability as the same no-write 404",
    isDraftNotFound(s17ResumeRevoked) && JSON.stringify(s17ResumeRevokedAfter) === JSON.stringify(s17ResumeRevokedBefore),
    `${s17ResumeRevoked.status}/${JSON.stringify(s17ResumeRevokedAfter)}`,
  );

  // 5. Admin lists abstracts
  const list = await j("GET", "/api/cfp/submissions?status=SUBMITTED", null, admin);
  check(
    "C15 admin list has an honest zero-plan decision state",
    list.status === 200 &&
      list.data?.data?.abstracts?.some((item) => item.id === abstractId) &&
      list.data?.data?.decisionSummary?.plans?.length === 0 &&
      list.data?.data?.decisionSummary?.selectedPlan === null,
    list.status,
  );
  const evaluatorGlobalAbstracts = await j("GET", "/api/cfp/submissions?status=SUBMITTED", null, evalr);
  check(
    "C15 evaluator global submission GET is forbidden",
    evaluatorGlobalAbstracts.status === 403,
    evaluatorGlobalAbstracts.status,
  );

  // 6. Create evaluation plan
  const plan = await j("POST", "/api/evaluations/plans", {
    eventId: OTHER_SCRATCH_EVENT.id, name: "Round 1 Smoke", ordinal: 1,
    rubric: [{ key: "relevance", label: "Relevance", min: 1, max: 5, weight: 1 }],
  }, admin);
  check("S1 plan create derives event scope from the session, never the body",
    plan.status === 201 && plan.data?.data?.eventId === SCRATCH_EVENT.id, plan.status);
  const planId = plan.data?.data?.id;
  const onePlanList = await j("GET", "/api/cfp/submissions?status=SUBMITTED", null, admin);
  check(
    "C15 exactly one plan auto-selects without a numeric score before review",
    onePlanList.status === 200 &&
      onePlanList.data?.data?.decisionSummary?.selectedPlan?.id === planId &&
      onePlanList.data?.data?.decisionSummary?.summariesByAbstractId?.[abstractId]?.weightedAverage === null,
    onePlanList.status,
  );
  const otherPlan = await prisma.evaluationPlan.create({
    data: {
      eventId: OTHER_SCRATCH_EVENT.id,
      name: "Other Event Round",
      ordinal: 1,
      rubric: [{ key: "relevance", label: "Relevance", min: 1, max: 5, weight: 1 }],
    },
  });
  const crossEventPlan = await j("POST", "/api/evaluations/plans", {
    id: otherPlan.id,
    eventId: SCRATCH_EVENT.id,
    name: "Unauthorized plan change",
    ordinal: 1,
    rubric: [{ key: "relevance", label: "Relevance", min: 1, max: 5, weight: 1 }],
  }, admin);
  const otherPlanAfterCrossEventUpdate = await prisma.evaluationPlan.findUnique({
    where: { id: otherPlan.id },
    select: { name: true },
  });
  check("S1 plan update refuses unknown and cross-event ids without changing the other event",
    crossEventPlan.status === 404 &&
      crossEventPlan.data?.error?.code === "PLAN_NOT_FOUND" &&
      otherPlanAfterCrossEventUpdate?.name === "Other Event Round",
    crossEventPlan.status);

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

  // C17 — admins provision fresh evaluators without rewriting global identity
  // data. The API intentionally never returns the bearer; this scratch helper
  // derives a valid token from the persisted version/expiry solely to exercise
  // the public accept boundary under the forced mock server secret.
  const c17Email = "fresh-reviewer@scratch.test";
  const c17Invite = await j("POST", "/api/evaluations/reviewer-invites", {
    email: c17Email, name: "Fresh Reviewer", resend: false,
  }, admin);
  const c17User = await prisma.user.findUnique({ where: { email: c17Email }, select: { id: true, name: true } });
  const c17InviteRows = await prisma.$queryRaw`
    SELECT "id", "tokenVersion", "expiresAt", "acceptedVersion", "lastSentAt", "sendWindowCount", "lastDeliveryState"
    FROM "ReviewerInvite" WHERE "eventId" = ${SCRATCH_EVENT.id} AND "userId" = ${c17User?.id ?? "missing"}
  `;
  const c17StoredInvite = c17InviteRows[0];
  const c17DispatchCountBeforeIdempotent = await prisma.emailDispatch.count({ where: { recipient: c17Email } });
  check(
    "C17 first invite creates only EVALUATOR access and returns bounded mock delivery without a bearer",
    c17Invite.status === 200 && c17Invite.data?.data?.state === "invited" &&
      c17Invite.data?.data?.delivery === "mocked" && c17Invite.data?.data?.access === "active" &&
      !!c17StoredInvite?.lastSentAt &&
      c17Invite.data?.data?.resendAvailableAt === new Date(c17StoredInvite.lastSentAt.getTime() + 600_000).toISOString() &&
      !Object.hasOwn(c17Invite.data?.data ?? {}, "token") && !!c17User && c17User.name === "Fresh Reviewer" &&
      c17StoredInvite?.tokenVersion === 1 && c17StoredInvite?.sendWindowCount === 1 &&
      c17StoredInvite?.lastDeliveryState === "MOCKED" &&
      await prisma.eventMember.findUnique({ where: { eventId_userId: { eventId: SCRATCH_EVENT.id, userId: c17User.id } } })
        .then((member) => member?.role === "EVALUATOR"),
    `${c17Invite.status}/${c17Invite.data?.data?.state}/${c17Invite.data?.data?.delivery}`,
  );
  const c17NoResend = await j("POST", "/api/evaluations/reviewer-invites", {
    email: c17Email, name: "Attempted Rename", resend: false,
  }, admin);
  const c17AfterNoResend = await prisma.$queryRaw`
    SELECT "tokenVersion", "sendWindowCount" FROM "ReviewerInvite" WHERE "id" = ${c17StoredInvite?.id ?? "missing"}
  `;
  check(
    "C17 valid pending invites are idempotent and preserve the existing global User name",
    c17NoResend.status === 200 && c17NoResend.data?.data?.state === "pending" &&
      c17NoResend.data?.data?.resendAvailableAt === c17Invite.data?.data?.resendAvailableAt &&
      (await prisma.user.findUnique({ where: { email: c17Email }, select: { name: true } }))?.name === "Fresh Reviewer" &&
      await prisma.emailDispatch.count({ where: { recipient: c17Email } }) === c17DispatchCountBeforeIdempotent &&
      c17AfterNoResend[0]?.tokenVersion === 1 && c17AfterNoResend[0]?.sendWindowCount === 1,
    `${c17NoResend.status}/${c17NoResend.data?.data?.state}`,
  );
  // Keep later C17 checks from aborting the entire late suite if the primary
  // invite assertion has already made the stored record unavailable.
  if (!c17StoredInvite) {
    console.error("[smoke] C17 dependent invite checks skipped: first invite produced no stored row");
  } else {
  const c17Token = reviewerInviteBearer(c17StoredInvite);
  const [c17AcceptOne, c17AcceptTwo] = await Promise.all([
    postReviewerInviteAccept(c17Token),
    postReviewerInviteAccept(c17Token),
  ]);
  const c17AcceptStatuses = [c17AcceptOne.status, c17AcceptTwo.status].sort((left, right) => left - right);
  const c17AfterAccept = await prisma.$queryRaw`
    SELECT "acceptedVersion", "tokenVersion" FROM "ReviewerInvite" WHERE "id" = ${c17StoredInvite.id}
  `;
  const c17Replay = await postReviewerInviteAccept(c17Token);
  check(
    "C17 concurrent accept consumes exactly one EVALUATOR invite and sets only the protected session redirect",
    c17AcceptStatuses.join(",") === "303,404" &&
      [c17AcceptOne, c17AcceptTwo].some((result) =>
        result.status === 303 && result.headers.get("cache-control") === "no-store" &&
        result.headers.get("location") === `${REVIEWER_INVITE_APP_URL}/admin/evaluations` &&
        /HttpOnly/i.test(result.headers.get("set-cookie") ?? "") && /SameSite=Lax/i.test(result.headers.get("set-cookie") ?? ""),
      ) && c17AfterAccept[0]?.acceptedVersion === c17AfterAccept[0]?.tokenVersion &&
      c17Replay.status === 404 && c17Replay.data?.error?.code === "INVITE_NOT_FOUND",
    `${c17AcceptStatuses.join(",")}/${c17Replay.status}`,
  );
  const c17Active = await j("POST", "/api/evaluations/reviewer-invites", {
    email: c17Email, name: "Attempted Rename", resend: false,
  }, admin);
  check(
    "C17 accepted evaluators are active without silently rotating a fresh bearer",
    c17Active.status === 200 && c17Active.data?.data?.state === "active" &&
      await prisma.emailDispatch.count({ where: { recipient: c17Email } }) === c17DispatchCountBeforeIdempotent,
    `${c17Active.status}/${c17Active.data?.data?.state}`,
  );
  const [c17Missing, c17Empty, c17Wrong, c17WrongType, c17Expired] = await Promise.all([
    postReviewerInviteAccept(),
    postReviewerInviteAccept(""),
    postReviewerInviteAccept("v1.not-a-real-invite.1.9999999999." + "r".repeat(43) + "." + "x".repeat(43)),
    postReviewerInviteAccept({ token: "wrong-type" }),
    postReviewerInviteAccept(reviewerInviteBearer({ ...c17StoredInvite, expiresAt: new Date(Date.now() - 1_000) })),
  ]);
  const c17CrossUser = await prisma.user.upsert({
    where: { email: "reviewer-cross-event@scratch.test" },
    update: {},
    create: { email: "reviewer-cross-event@scratch.test", name: "Cross Event Reviewer" },
  });
  await prisma.eventMember.upsert({
    where: { eventId_userId: { eventId: OTHER_SCRATCH_EVENT.id, userId: c17CrossUser.id } },
    update: { role: "EVALUATOR" },
    create: { eventId: OTHER_SCRATCH_EVENT.id, userId: c17CrossUser.id, role: "EVALUATOR" },
  });
  const c17CrossInvite = {
    id: `c17-cross-${Date.now()}`,
    tokenVersion: 1,
    expiresAt: new Date(Date.now() + 86_400_000),
  };
  await prisma.reviewerInvite.create({
    data: {
      id: c17CrossInvite.id,
      eventId: SCRATCH_EVENT.id,
      userId: c17CrossUser.id,
      tokenVersion: c17CrossInvite.tokenVersion,
      expiresAt: c17CrossInvite.expiresAt,
    },
  });
  const c17Cross = await postReviewerInviteAccept(reviewerInviteBearer(c17CrossInvite));
  const c17GenericFailures = [c17Missing, c17Empty, c17Wrong, c17WrongType, c17Expired, c17Cross];
  check(
    "C17 malformed, wrong, expired, and cross-event membership accept attempts are identical no-store 404s",
    c17GenericFailures.every((result) =>
      result.status === 404 && result.data?.error?.code === "INVITE_NOT_FOUND" &&
      result.headers.get("cache-control") === "no-store" && result.headers.get("referrer-policy") === "no-referrer",
    ),
    c17GenericFailures.map((result) => `${result.status}/${result.data?.error?.code}`).join(","),
  );
  await prisma.reviewerInvite.update({
    where: { id: c17StoredInvite.id },
    data: { lastSentAt: new Date(Date.now() - 660_000) },
  });
  const c17Renew = await j("POST", "/api/evaluations/reviewer-invites", {
    email: c17Email, name: "Attempted Rename", resend: true,
  }, admin);
  const c17Renewed = await prisma.$queryRaw`
    SELECT "tokenVersion", "acceptedVersion", "sendWindowCount", "lastDeliveryState"
    FROM "ReviewerInvite" WHERE "id" = ${c17StoredInvite.id}
  `;
  check(
    "C17 explicit resend after cooldown rotates access while preserving global identity",
    c17Renew.status === 200 && c17Renew.data?.data?.state === "invited" && c17Renew.data?.data?.delivery === "mocked" &&
      c17Renewed[0]?.tokenVersion === 2 && c17Renewed[0]?.acceptedVersion === null &&
      c17Renewed[0]?.sendWindowCount === 2 && c17Renewed[0]?.lastDeliveryState === "MOCKED" &&
      (await prisma.user.findUnique({ where: { email: c17Email }, select: { name: true } }))?.name === "Fresh Reviewer",
    `${c17Renew.status}/${c17Renew.data?.data?.state}/${c17Renewed[0]?.tokenVersion}`,
  );
  const c17Template = await prisma.emailTemplate.findUnique({
    where: { eventId_key: { eventId: SCRATCH_EVENT.id, key: "reviewer-invite" } },
    select: { id: true, subject: true, htmlBody: true, trigger: true },
  });
  const c17TemplateBefore = await prisma.$queryRaw`
    SELECT COALESCE(SUM("sendWindowCount"), 0)::int AS "count"
    FROM "ReviewerInvite" WHERE "eventId" = ${SCRATCH_EVENT.id} AND "sendWindowStart" = date_trunc('hour', NOW())
  `;
  await prisma.emailTemplate.update({
    where: { id: c17Template.id },
    data: { subject: "Broken legacy reviewer invite", htmlBody: "<p>No link</p>" },
  });
  const c17BrokenTemplateEmail = "broken-template-reviewer@scratch.test";
  const c17BrokenTemplate = await j("POST", "/api/evaluations/reviewer-invites", {
    email: c17BrokenTemplateEmail, name: "Broken Template Reviewer", resend: false,
  }, admin);
  const c17TemplateAfter = await prisma.$queryRaw`
    SELECT COALESCE(SUM("sendWindowCount"), 0)::int AS "count"
    FROM "ReviewerInvite" WHERE "eventId" = ${SCRATCH_EVENT.id} AND "sendWindowStart" = date_trunc('hour', NOW())
  `;
  await prisma.emailTemplate.update({
    where: { id: c17Template.id },
    data: { subject: c17Template.subject, htmlBody: c17Template.htmlBody, trigger: c17Template.trigger },
  });
  check(
    "C17 a legacy reviewer template without inviteUrl fails before reservation, identity, membership, or delivery",
    c17BrokenTemplate.status === 422 && c17BrokenTemplate.data?.error?.code === "INVALID_INVITE_TEMPLATE" &&
      await prisma.user.count({ where: { email: c17BrokenTemplateEmail } }) === 0 &&
      await prisma.eventMember.count({ where: { eventId: SCRATCH_EVENT.id, user: { email: c17BrokenTemplateEmail } } }) === 0 &&
      c17TemplateBefore[0]?.count === c17TemplateAfter[0]?.count,
    `${c17BrokenTemplate.status}/${c17BrokenTemplate.data?.error?.code}/${c17TemplateBefore[0]?.count}->${c17TemplateAfter[0]?.count}`,
  );
  const c17RoleRaceEmail = "reviewer-role-race@scratch.test";
  const c17RoleRaceInvite = await j("POST", "/api/evaluations/reviewer-invites", {
    email: c17RoleRaceEmail, name: "Role Race Reviewer", resend: false,
  }, admin);
  const c17RoleRaceUser = await prisma.user.findUnique({ where: { email: c17RoleRaceEmail }, select: { id: true } });
  const c17RoleRaceRows = await prisma.$queryRaw`
    SELECT "id", "tokenVersion", "expiresAt", "acceptedVersion" FROM "ReviewerInvite"
    WHERE "eventId" = ${SCRATCH_EVENT.id} AND "userId" = ${c17RoleRaceUser.id}
  `;
  const c17RoleRaceStored = c17RoleRaceRows[0];
  let signalC17RoleRaceHeld;
  let releaseC17RoleRace;
  const c17RoleRaceHeld = new Promise((resolve) => { signalC17RoleRaceHeld = resolve; });
  const c17RoleRaceRelease = new Promise((resolve) => { releaseC17RoleRace = resolve; });
  const heldC17RoleDowngrade = prisma.$transaction(async (tx) => {
    const key = `event-member-authority:${SCRATCH_EVENT.id}:${c17RoleRaceUser.id}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    await tx.$queryRaw`
      SELECT "userId" FROM "EventMember"
      WHERE "eventId" = ${SCRATCH_EVENT.id} AND "userId" = ${c17RoleRaceUser.id} FOR UPDATE
    `;
    await tx.eventMember.update({
      where: { eventId_userId: { eventId: SCRATCH_EVENT.id, userId: c17RoleRaceUser.id } },
      data: { role: "ADMIN" },
    });
    signalC17RoleRaceHeld();
    await c17RoleRaceRelease;
  }, { timeout: 15_000 });
  await c17RoleRaceHeld;
  let c17RoleRaceAcceptFinished = false;
  const waitingC17RoleRaceAccept = postReviewerInviteAccept(reviewerInviteBearer(c17RoleRaceStored))
    .finally(() => { c17RoleRaceAcceptFinished = true; });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const c17RoleRaceWaited = !c17RoleRaceAcceptFinished;
  releaseC17RoleRace();
  await heldC17RoleDowngrade;
  const c17RoleRaceAccept = await waitingC17RoleRaceAccept;
  const c17RoleRaceAfter = await prisma.$queryRaw`
    SELECT "acceptedVersion" FROM "ReviewerInvite" WHERE "id" = ${c17RoleRaceStored.id}
  `;
  check(
    "C17 accept shares member authority, waits for an ADMIN role change, then fresh-rejects without consuming",
    c17RoleRaceInvite.status === 200 && c17RoleRaceWaited && c17RoleRaceAccept.status === 404 &&
      c17RoleRaceAccept.data?.error?.code === "INVITE_NOT_FOUND" && c17RoleRaceAfter[0]?.acceptedVersion === null &&
      (await prisma.eventMember.findUnique({ where: { eventId_userId: { eventId: SCRATCH_EVENT.id, userId: c17RoleRaceUser.id } } }))?.role === "ADMIN",
    `${c17RoleRaceAccept.status}/${c17RoleRaceWaited}/${c17RoleRaceAfter[0]?.acceptedVersion}`,
  );
  const c17SpeakerConflict = await j("POST", "/api/evaluations/reviewer-invites", {
    email: speaker.user.email, name: "Do Not Change", resend: false,
  }, admin);
  check(
    "C17 current-event speakers cannot be silently upgraded into evaluator access",
    c17SpeakerConflict.status === 409 && c17SpeakerConflict.data?.error?.code === "REVIEWER_ROLE_CONFLICT",
    `${c17SpeakerConflict.status}/${c17SpeakerConflict.data?.error?.code}`,
  );
  await prisma.reviewerInvite.update({
    where: { id: c17StoredInvite.id },
    data: { sendWindowStart: new Date(new Date().setUTCMinutes(0, 0, 0)), sendWindowCount: 20 },
  });
  const c17CappedEmail = "capped-reviewer@scratch.test";
  const c17Capped = await j("POST", "/api/evaluations/reviewer-invites", {
    email: c17CappedEmail, name: "Capped Reviewer", resend: false,
  }, admin);
  check(
    "C17 event-hour cap rejects a new invite atomically without creating identity or membership",
    c17Capped.status === 429 && c17Capped.data?.error?.code === "INVITE_RATE_LIMITED" &&
      await prisma.user.count({ where: { email: c17CappedEmail } }) === 0 &&
      await prisma.eventMember.count({ where: { eventId: SCRATCH_EVENT.id, user: { email: c17CappedEmail } } }) === 0,
    `${c17Capped.status}/${c17Capped.data?.error?.code}`,
  );
  }

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

  // Unknown and cross-event assignment references deliberately use the same
  // response code for each protected object class. None may create an
  // assignment or move the known submitted proposal into review.
  const crossEventAssignmentAbstract = await prisma.abstract.create({
    data: {
      eventId: OTHER_SCRATCH_EVENT.id,
      formConfigId: otherS1Form.id,
      submitterId: adminUserId,
      title: "Cross-event assignment proposal",
      status: "SUBMITTED",
    },
  });
  const crossEventEvaluator = await prisma.user.upsert({
    where: { email: "assignment-other-event@scratch.test" },
    update: { name: "Other Event Evaluator" },
    create: { email: "assignment-other-event@scratch.test", name: "Other Event Evaluator" },
  });
  await prisma.eventMember.upsert({
    where: { eventId_userId: { eventId: OTHER_SCRATCH_EVENT.id, userId: crossEventEvaluator.id } },
    update: { role: "EVALUATOR" },
    create: { eventId: OTHER_SCRATCH_EVENT.id, userId: crossEventEvaluator.id, role: "EVALUATOR" },
  });
  const [missingPlanAssignment, crossPlanAssignment, missingAbstractAssignment, crossAbstractAssignment, missingEvaluatorAssignment, crossEvaluatorAssignment] = await Promise.all([
    j("POST", "/api/evaluations/assignments", { planId: "missing-assignment-plan", abstractIds: [abstractId], evaluatorIds: [evaluatorId] }, admin),
    j("POST", "/api/evaluations/assignments", { planId: otherPlan.id, abstractIds: [abstractId], evaluatorIds: [evaluatorId] }, admin),
    j("POST", "/api/evaluations/assignments", { planId, abstractIds: ["missing-assignment-abstract"], evaluatorIds: [evaluatorId] }, admin),
    j("POST", "/api/evaluations/assignments", { planId, abstractIds: [crossEventAssignmentAbstract.id], evaluatorIds: [evaluatorId] }, admin),
    j("POST", "/api/evaluations/assignments", { planId, abstractIds: [abstractId], evaluatorIds: ["missing-assignment-evaluator"] }, admin),
    j("POST", "/api/evaluations/assignments", { planId, abstractIds: [abstractId], evaluatorIds: [crossEventEvaluator.id] }, admin),
  ]);
  const assignmentScopeAfterRefusals = await prisma.abstract.findUnique({
    where: { id: abstractId },
    select: { status: true },
  });
  check(
    "S5 unknown and cross-event plan, abstract, and reviewer references are indistinguishable and do not mutate",
    missingPlanAssignment.status === 404 && missingPlanAssignment.data?.error?.code === "PLAN_NOT_FOUND" &&
      crossPlanAssignment.status === 404 && crossPlanAssignment.data?.error?.code === "PLAN_NOT_FOUND" &&
      missingAbstractAssignment.status === 422 && missingAbstractAssignment.data?.error?.code === "INVALID_ABSTRACTS" &&
      crossAbstractAssignment.status === 422 && crossAbstractAssignment.data?.error?.code === "INVALID_ABSTRACTS" &&
      missingEvaluatorAssignment.status === 422 && missingEvaluatorAssignment.data?.error?.code === "INVALID_EVALUATORS" &&
      crossEvaluatorAssignment.status === 422 && crossEvaluatorAssignment.data?.error?.code === "INVALID_EVALUATORS" &&
      assignmentScopeAfterRefusals?.status === "SUBMITTED",
    `${missingPlanAssignment.status}/${crossPlanAssignment.status}/${missingAbstractAssignment.status}/${crossAbstractAssignment.status}/${missingEvaluatorAssignment.status}/${crossEvaluatorAssignment.status}`,
  );

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

  // S5 authority race: the assignment route must take EventMember FOR SHARE
  // before its Abstract lock. Hold a target row FOR UPDATE with an uncommitted
  // downgrade. The request can reach the compatible relation lock, but cannot
  // read authority until the downgrade commits; its fresh post-lock role check
  // must then refuse without altering the submitted proposal.
  const memberRaceUser = await prisma.user.upsert({
    where: { email: "assignment-member-race@scratch.test" },
    update: { name: "Assignment Member Race" },
    create: { email: "assignment-member-race@scratch.test", name: "Assignment Member Race" },
  });
  await prisma.eventMember.upsert({
    where: { eventId_userId: { eventId: SCRATCH_EVENT.id, userId: memberRaceUser.id } },
    update: { role: "EVALUATOR" },
    create: { eventId: SCRATCH_EVENT.id, userId: memberRaceUser.id, role: "EVALUATOR" },
  });
  const memberRaceSubmit = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId, title: "Assignment membership race proposal",
    speakers: [{ email: "assignment-member-race-speaker@scratch.test", name: "Member Race Speaker", isPrimary: true }],
    answers: { title_note: "member race", consent: true }, intent: "submit",
  });
  const memberRaceAbstractId = memberRaceSubmit.data?.data?.id;
  let signalMemberUpdateHeld;
  let releaseMemberUpdate;
  const memberUpdateHeld = new Promise((resolve) => { signalMemberUpdateHeld = resolve; });
  const memberUpdateRelease = new Promise((resolve) => { releaseMemberUpdate = resolve; });
  const heldMemberDowngrade = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "userId" FROM "EventMember"
      WHERE "eventId" = ${SCRATCH_EVENT.id} AND "userId" = ${memberRaceUser.id}
      FOR UPDATE
    `;
    await tx.eventMember.update({
      where: { eventId_userId: { eventId: SCRATCH_EVENT.id, userId: memberRaceUser.id } },
      data: { role: "SPEAKER" },
    });
    signalMemberUpdateHeld();
    await memberUpdateRelease;
  }, { timeout: 15_000 });
  await memberUpdateHeld;
  const countEventMemberRowShareLocks = async () => {
    const rows = await prisma.$queryRaw`
      SELECT count(*)::int AS "count"
      FROM pg_locks
      WHERE relation = '"EventMember"'::regclass
        AND mode = 'RowShareLock'
        AND granted
    `;
    return rows[0]?.count ?? 0;
  };
  const baselineMemberRowShareLocks = await countEventMemberRowShareLocks();
  const waitingMemberAssignment = j("POST", "/api/evaluations/assignments", {
    planId, abstractIds: [memberRaceAbstractId], evaluatorIds: [memberRaceUser.id],
  }, admin);
  let assignmentReachedMembershipLock = false;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await countEventMemberRowShareLocks() > baselineMemberRowShareLocks) {
        assignmentReachedMembershipLock = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    releaseMemberUpdate();
    await heldMemberDowngrade;
  }
  const memberRaceAssignment = await waitingMemberAssignment;
  const [memberRaceAbstractAfter, memberRaceAssignmentCount] = await Promise.all([
    prisma.abstract.findUnique({
      where: { id: memberRaceAbstractId },
      select: { status: true, decidedAt: true },
    }),
    prisma.reviewAssignment.count({
      where: { planId, abstractId: memberRaceAbstractId, evaluatorId: memberRaceUser.id },
    }),
  ]);
  check(
    "S5 held membership downgrade makes assignment wait, fresh-reject, and preserve proposal state",
    memberRaceSubmit.status === 201 && assignmentReachedMembershipLock &&
      memberRaceAssignment.status === 422 && memberRaceAssignment.data?.error?.code === "INVALID_EVALUATORS" &&
      memberRaceAbstractAfter?.status === "SUBMITTED" && memberRaceAbstractAfter.decidedAt === null &&
      memberRaceAssignmentCount === 0,
    `${memberRaceAssignment.status}/${memberRaceAssignment.data?.error?.code}/${memberRaceAssignmentCount}`,
  );

  // C17 creates the first runtime EventMember rows. A missing row cannot be
  // protected by FOR SHARE alone, so S5 waits on the same authority advisory
  // key while this simulated invite transaction inserts the EVALUATOR row.
  const missingMemberUser = await prisma.user.upsert({
    where: { email: "assignment-missing-member@scratch.test" },
    update: {},
    create: { email: "assignment-missing-member@scratch.test", name: "Missing Member Race" },
  });
  await prisma.eventMember.deleteMany({ where: { eventId: SCRATCH_EVENT.id, userId: missingMemberUser.id } });
  const missingMemberSubmit = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId, title: "Assignment missing-member race proposal",
    speakers: [{ email: "assignment-missing-member-speaker@scratch.test", name: "Missing Member Speaker", isPrimary: true }],
    answers: { title_note: "member insert", consent: true }, intent: "submit",
  });
  const missingMemberAbstractId = missingMemberSubmit.data?.data?.id;
  let signalMissingMemberHeld;
  let releaseMissingMemberInsert;
  const missingMemberHeld = new Promise((resolve) => { signalMissingMemberHeld = resolve; });
  const missingMemberRelease = new Promise((resolve) => { releaseMissingMemberInsert = resolve; });
  const heldMissingMemberInsert = prisma.$transaction(async (tx) => {
    const key = `event-member-authority:${SCRATCH_EVENT.id}:${missingMemberUser.id}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    await tx.eventMember.create({ data: { eventId: SCRATCH_EVENT.id, userId: missingMemberUser.id, role: "EVALUATOR" } });
    signalMissingMemberHeld();
    await missingMemberRelease;
  }, { timeout: 15_000 });
  await missingMemberHeld;
  let missingMemberAssignmentFinished = false;
  const waitingMissingMemberAssignment = j("POST", "/api/evaluations/assignments", {
    planId, abstractIds: [missingMemberAbstractId], evaluatorIds: [missingMemberUser.id],
  }, admin).finally(() => { missingMemberAssignmentFinished = true; });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const missingMemberWaitedOnAuthority = !missingMemberAssignmentFinished;
  releaseMissingMemberInsert();
  await heldMissingMemberInsert;
  const missingMemberAssignment = await waitingMissingMemberAssignment;
  check(
    "S5 missing-member insertion shares C17 authority key, waits, then authorizes only the committed evaluator row",
    missingMemberSubmit.status === 201 && missingMemberWaitedOnAuthority &&
      missingMemberAssignment.status === 201 &&
      await prisma.reviewAssignment.count({ where: { planId, abstractId: missingMemberAbstractId, evaluatorId: missingMemberUser.id } }) === 1,
    `${missingMemberAssignment.status}/${missingMemberWaitedOnAuthority}`,
  );

  // 8. Assign the abstract to the evaluator -> abstract moves to UNDER_REVIEW
  const assign = await j("POST", "/api/evaluations/assignments", {
    planId, abstractIds: [abstractId], evaluatorIds: [evaluatorId],
  }, admin);
  check("create assignment", assign.status === 201 && assign.data?.data?.assignments === 1, assign.status);

  const queue = await j("GET", `/api/evaluations/assignments?planId=${planId}`, null, evalr);
  const ownQueueAssignment = queue.data?.data?.find((assignment) => assignment.abstractId === abstractId);
  check(
    "C15 evaluator sees only its non-blind assignment without evaluator identity",
    queue.status === 200 &&
      queue.data?.data?.every((assignment) => !Object.hasOwn(assignment, "evaluator")) &&
      !String(queue.data).includes(evalr.user.email) &&
      ownQueueAssignment?.abstract?.speakers?.length === 2,
    queue.status,
  );

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
  const correctedScore = await j("POST", "/api/evaluations/scores", {
    planId, abstractId, scores: [{ rubricKey: "relevance", score: 4 }], complete: true,
  }, evalr);
  const correctedReviewScore = await prisma.reviewScore.findUnique({
    where: { planId_abstractId_evaluatorId_rubricKey: { planId, abstractId, evaluatorId, rubricKey: "relevance" } },
    select: { score: true, comment: true },
  });
  check("C5 score correction with an omitted comment preserves saved feedback",
    correctedScore.status === 200 && correctedReviewScore?.score?.toString() === "4" && correctedReviewScore.comment === "strong",
    correctedScore.status);
  const parallelScoreSubmission = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId,
    title: "Parallel score lock check",
    speakers: [{ email: "parallel-score@scratch.test", name: "Parallel Scorer", isPrimary: true }],
    answers: { title_note: "parallel", consent: true },
    intent: "submit",
  });
  const parallelScoreAbstractId = parallelScoreSubmission.data?.data?.id;
  const parallelScoreAssignment = await j("POST", "/api/evaluations/assignments", {
    planId, abstractIds: [parallelScoreAbstractId], evaluatorIds: [evaluatorId],
  }, admin);
  check("C5 plan-lock concurrency setup creates a second assigned abstract",
    parallelScoreSubmission.status === 201 && parallelScoreAssignment.status === 201 && !!parallelScoreAbstractId,
    parallelScoreAssignment.status);

  let signalSharedPlanLock;
  let releaseSharedPlanLock;
  const sharedPlanLockHeld = new Promise((resolve) => { signalSharedPlanLock = resolve; });
  const sharedPlanLockRelease = new Promise((resolve) => { releaseSharedPlanLock = resolve; });
  const sharedPlanLock = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "EvaluationPlan" WHERE "id" = ${planId} FOR SHARE`;
    signalSharedPlanLock();
    await sharedPlanLockRelease;
  });
  await sharedPlanLockHeld;
  let signalAbstractLock;
  let releaseAbstractLock;
  const abstractLockHeld = new Promise((resolve) => { signalAbstractLock = resolve; });
  const abstractLockRelease = new Promise((resolve) => { releaseAbstractLock = resolve; });
  const blockedAbstractLock = prisma.$transaction(async (tx) => {
    const key = `abstract-write:${parallelScoreAbstractId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    signalAbstractLock();
    await abstractLockRelease;
  });
  await abstractLockHeld;
  const countPlanRowShareLocks = async () => {
    const rows = await prisma.$queryRaw`
      SELECT count(*)::int AS "count"
      FROM pg_locks
      WHERE relation = '"EvaluationPlan"'::regclass
        AND mode = 'RowShareLock'
        AND granted
    `;
    return rows[0]?.count ?? 0;
  };
  const baselinePlanRowShareLocks = await countPlanRowShareLocks();
  const parallelScore = j("POST", "/api/evaluations/scores", {
    planId, abstractId: parallelScoreAbstractId, scores: [{ rubricKey: "relevance", score: 4 }], complete: true,
  }, evalr);
  let scorerTookCompatiblePlanShareLock = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await countPlanRowShareLocks() > baselinePlanRowShareLocks) {
      scorerTookCompatiblePlanShareLock = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // The scorer cannot finish while this holder keeps its target abstract
  // serialized, so observing its second granted RowShareLock is direct proof
  // that Plan FOR SHARE is compatible with an active scorer's plan lock.
  releaseAbstractLock();
  releaseSharedPlanLock();
  await Promise.all([blockedAbstractLock, sharedPlanLock]);
  const parallelScoreResult = await parallelScore;
  check("C5 concurrent scorers share the plan lock before distinct abstract locks",
    scorerTookCompatiblePlanShareLock && parallelScoreResult?.status === 200,
    parallelScoreResult?.status);

  let signalPlanUpdateShareLock;
  let releasePlanUpdateShareLock;
  const planUpdateShareLockHeld = new Promise((resolve) => { signalPlanUpdateShareLock = resolve; });
  const planUpdateShareLockRelease = new Promise((resolve) => { releasePlanUpdateShareLock = resolve; });
  const planUpdateShareLock = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "EvaluationPlan" WHERE "id" = ${planId} FOR SHARE`;
    signalPlanUpdateShareLock();
    await planUpdateShareLockRelease;
  });
  await planUpdateShareLockHeld;
  const waitingPlanUpdate = j("POST", "/api/evaluations/plans", {
    id: planId,
    eventId: SCRATCH_EVENT.id,
    name: "Round 1 Smoke concurrent lock check",
    ordinal: 1,
    rubric: [{ key: "relevance", label: "Relevance", min: 1, max: 5, weight: 1 }],
  }, admin);
  const planUpdatedBeforeShareRelease = await Promise.race([
    waitingPlanUpdate.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 150)),
  ]);
  releasePlanUpdateShareLock();
  await planUpdateShareLock;
  const completedPlanUpdate = await waitingPlanUpdate;
  check("C5 plan FOR UPDATE excludes active shared scorer locks",
    planUpdatedBeforeShareRelease === false && completedPlanUpdate.status === 200,
    completedPlanUpdate.status);
  const rejectedRubricReorder = await j("POST", "/api/evaluations/plans", {
    id: planId,
    eventId: SCRATCH_EVENT.id,
    name: "Round 1 Smoke concurrent lock check",
    ordinal: 1,
    rubric: [
      { key: "impact", label: "Impact", min: 1, max: 5, weight: 1 },
      { key: "relevance", label: "Relevance", min: 1, max: 5, weight: 1 },
    ],
  }, admin);
  const [planAfterRejectedReorder, commentAfterRejectedReorder] = await Promise.all([
    prisma.evaluationPlan.findUnique({ where: { id: planId }, select: { rubric: true } }),
    prisma.reviewScore.findUnique({
      where: { planId_abstractId_evaluatorId_rubricKey: { planId, abstractId, evaluatorId, rubricKey: "relevance" } },
      select: { comment: true },
    }),
  ]);
  check("C5 rubric reorder preserves the authoritative comment key and visible feedback",
    rejectedRubricReorder.status === 409 &&
      rejectedRubricReorder.data?.error?.code === "REVIEW_COMMENT_KEY_IN_USE" &&
      planAfterRejectedReorder?.rubric?.[0]?.key === "relevance" &&
      commentAfterRejectedReorder?.comment === "strong",
    rejectedRubricReorder.data?.error?.code);
  const clearedScore = await j("POST", "/api/evaluations/scores", {
    planId, abstractId, scores: [{ rubricKey: "relevance", score: 4, comment: null }], complete: true,
  }, evalr);
  const clearedReviewScore = await prisma.reviewScore.findUnique({
    where: { planId_abstractId_evaluatorId_rubricKey: { planId, abstractId, evaluatorId, rubricKey: "relevance" } },
    select: { comment: true },
  });
  check("C5 explicit null deliberately clears saved feedback",
    clearedScore.status === 200 && clearedReviewScore?.comment === null, clearedScore.status);
  const blankComment = await j("POST", "/api/evaluations/scores", {
    planId, abstractId, scores: [{ rubricKey: "relevance", score: 4, comment: "   " }], complete: true,
  }, evalr);
  check("C5 rejects ambiguous blank feedback instead of treating it as a clear",
    blankComment.status === 422 && blankComment.data?.error?.code === "VALIDATION_ERROR", blankComment.status);
  const strandedLegacyRubricKey = "pre_fix_former_first_key";
  const strandedLegacyComment = "Pre-fix stranded evaluator feedback";
  await prisma.reviewScore.create({
    data: {
      planId,
      abstractId,
      evaluatorId,
      rubricKey: strandedLegacyRubricKey,
      score: 4,
      comment: strandedLegacyComment,
    },
  });
  const s1OtherTemplate = await prisma.emailTemplate.create({
    data: {
      eventId: OTHER_SCRATCH_EVENT.id,
      key: "s1-other-template",
      subject: "Other template",
      htmlBody: "<p>Other scratch only</p>",
    },
  });
  const s1CrossEventTemplate = await j("PATCH", `/api/comms/templates/${s1OtherTemplate.id}`, {
    subject: "Not allowed",
    htmlBody: "<p>Not allowed</p>",
  }, admin);
  const s1OtherTemplateAfterPatch = await prisma.emailTemplate.findUnique({
    where: { id: s1OtherTemplate.id },
    select: { subject: true },
  });
  check(
    "S1 template update keeps unknown and cross-event ids indistinguishable",
    s1CrossEventTemplate.status === 404 &&
      s1CrossEventTemplate.data?.error?.code === "TEMPLATE_NOT_FOUND" &&
      s1OtherTemplateAfterPatch?.subject === "Other template",
    s1CrossEventTemplate.status,
  );
  const s18Template = await prisma.emailTemplate.create({
    data: {
      eventId: SCRATCH_EVENT.id,
      key: `s18-trigger-${Date.now().toString(36)}`,
      subject: "Scheduled session",
      htmlBody: "<p>Your session is scheduled.</p>",
      trigger: "session.scheduled",
    },
  });
  const s18OmittedTrigger = await j("PATCH", `/api/comms/templates/${s18Template.id}`, {
    subject: "Updated scheduled session",
    htmlBody: "<p>Your session has been updated.</p>",
  }, admin);
  const s18AfterOmission = await prisma.emailTemplate.findUnique({
    where: { id: s18Template.id },
    select: { trigger: true },
  });
  check(
    "S18 omitting an optional template trigger preserves the stored safety trigger",
    s18OmittedTrigger.status === 200 &&
      s18OmittedTrigger.data?.data?.template?.trigger === "session.scheduled" &&
      s18AfterOmission?.trigger === "session.scheduled",
    s18OmittedTrigger.status,
  );
  const s18ClearTrigger = await j("PATCH", `/api/comms/templates/${s18Template.id}`, {
    subject: "Updated scheduled session",
    htmlBody: "<p>Your session has been updated.</p>",
    trigger: "   ",
  }, admin);
  check(
    "S18 an explicit blank template trigger deliberately clears it",
    s18ClearTrigger.status === 200 && s18ClearTrigger.data?.data?.template?.trigger === null,
    s18ClearTrigger.status,
  );
  const strandedEvaluatorQueue = await fetch(`${BASE}/admin/evaluations`, {
    headers: { cookie: cookie(evalr) },
  });
  const strandedEvaluatorQueueHtml = await strandedEvaluatorQueue.text();
  check("C5 evaluator recovers pre-fix stranded overall feedback from an orphan rubric key",
    strandedEvaluatorQueue.status === 200 && strandedEvaluatorQueueHtml.includes(strandedLegacyComment),
    strandedEvaluatorQueue.status);
  await prisma.reviewScore.delete({
    where: {
      planId_abstractId_evaluatorId_rubricKey: {
        planId,
        abstractId,
        evaluatorId,
        rubricKey: strandedLegacyRubricKey,
      },
    },
  });
  const legacyCommentKeys = ["legacy-comment-a", "legacy-comment-b"];
  await prisma.reviewScore.createMany({
    data: [
      { planId, abstractId, evaluatorId, rubricKey: legacyCommentKeys[0], score: 4, comment: "Legacy text one" },
      { planId, abstractId, evaluatorId, rubricKey: legacyCommentKeys[1], score: 4, comment: "Legacy text two" },
    ],
  });
  const [adminAbstractRead, evaluatorGlobalAbstractRead] = await Promise.all([
    j("GET", "/admin/abstracts", null, admin),
    // C15 intentionally redirects evaluators to their assignment-scoped queue.
    // Do not follow that redirect: seeing their own recovered feedback there is
    // correct and must not be mistaken for a global-organizer data leak.
    fetch(`${BASE}/admin/abstracts`, {
      headers: { cookie: cookie(evalr) },
      redirect: "manual",
    }),
  ]);
  const evaluatorGlobalLocation = evaluatorGlobalAbstractRead.headers.get("location");
  const evaluatorRedirectsToOwnQueue =
    evaluatorGlobalLocation !== null &&
    new URL(evaluatorGlobalLocation, BASE).pathname === "/admin/evaluations";
  check("C5 divergent legacy comments remain visible only to the organizer projection",
    adminAbstractRead.status === 200 &&
      String(adminAbstractRead.data).includes("Legacy text one") &&
      String(adminAbstractRead.data).includes("Legacy text two") &&
      !String(adminAbstractRead.data).includes(evaluatorId) &&
      [307, 308].includes(evaluatorGlobalAbstractRead.status) &&
      evaluatorRedirectsToOwnQueue,
    `${adminAbstractRead.status}/${evaluatorGlobalAbstractRead.status}/${evaluatorGlobalLocation}`);
  await prisma.reviewScore.deleteMany({
    where: { planId, abstractId, evaluatorId, rubricKey: { in: legacyCommentKeys } },
  });

  const reviewedList = await j("GET", "/api/cfp/submissions", null, admin);
  const reviewedAbstract = reviewedList.data?.data?.abstracts?.find((item) => item.id === abstractId);
  check(
    "C15 one selected plan reports only its weighted decision summary",
    reviewedList.status === 200 &&
      !Object.hasOwn(reviewedAbstract ?? {}, "reviewsComplete") &&
      !Object.hasOwn(reviewedAbstract ?? {}, "reviewsTotal") &&
      !Object.hasOwn(reviewedAbstract ?? {}, "avgScore") &&
      reviewedList.data?.data?.decisionSummary?.selectedPlan?.id === planId &&
      reviewedList.data?.data?.decisionSummary?.summariesByAbstractId?.[abstractId]?.completedAssignments === 1 &&
      reviewedList.data?.data?.decisionSummary?.summariesByAbstractId?.[abstractId]?.includedReviews === 1 &&
      reviewedList.data?.data?.decisionSummary?.summariesByAbstractId?.[abstractId]?.weightedAverage === 4,
  );

  const blindDecisionPlan = await prisma.evaluationPlan.create({
    data: {
      eventId: SCRATCH_EVENT.id,
      name: "Round 2 Blind Decision Smoke",
      ordinal: 2,
      isBlind: true,
      rubric: [
        { key: "impact", label: "Impact", min: 1, max: 5, weight: 2 },
        { key: "clarity", label: "Clarity", min: 1, max: 5, weight: 1 },
      ],
    },
  });
  const blindDecisionAssignment = await j("POST", "/api/evaluations/assignments", {
    planId: blindDecisionPlan.id,
    abstractIds: [abstractId],
    evaluatorIds: [evaluatorId],
  }, admin);
  const blindQueue = await j("GET", `/api/evaluations/assignments?planId=${blindDecisionPlan.id}`, null, evalr);
  const blindQueueAssignment = blindQueue.data?.data?.find((assignment) => assignment.abstractId === abstractId);
  check(
    "C15 evaluator blind policy is taken from this assignment plan",
    blindDecisionAssignment.status === 201 &&
      blindQueue.status === 200 &&
      blindQueue.data?.data?.every((assignment) => !Object.hasOwn(assignment, "evaluator")) &&
      blindQueueAssignment?.abstract?.speakers?.length === 0,
    `${blindDecisionAssignment.status}/${blindQueue.status}`,
  );
  const blindDecisionScore = await j("POST", "/api/evaluations/scores", {
    planId: blindDecisionPlan.id,
    abstractId,
    scores: [
      { rubricKey: "impact", score: 2 },
      { rubricKey: "clarity", score: 5 },
    ],
    complete: true,
  }, evalr);
  const multiplePlanList = await j("GET", "/api/cfp/submissions", null, admin);
  check(
    "C15 multiple plans default to the newest round's completed weighted decision",
    blindDecisionScore.status === 200 &&
      multiplePlanList.status === 200 &&
      multiplePlanList.data?.data?.decisionSummary?.plans?.map((plan) => plan.id).join(",") ===
        [planId, blindDecisionPlan.id].join(",") &&
      multiplePlanList.data?.data?.decisionSummary?.selectedPlan?.id === blindDecisionPlan.id &&
      !Object.hasOwn(multiplePlanList.data?.data?.decisionSummary ?? {}, "selectionRequired") &&
      multiplePlanList.data?.data?.decisionSummary?.summariesByAbstractId?.[abstractId]?.weightedAverage === 3,
    multiplePlanList.status,
  );
  const selectedBlindPlanList = await j("GET", `/api/cfp/submissions?planId=${blindDecisionPlan.id}`, null, admin);
  check(
    "C15 explicit event plan returns its completed weighted decision result",
    selectedBlindPlanList.status === 200 &&
      selectedBlindPlanList.data?.data?.decisionSummary?.selectedPlan?.id === blindDecisionPlan.id &&
      selectedBlindPlanList.data?.data?.decisionSummary?.summariesByAbstractId?.[abstractId]?.completedAssignments === 1 &&
      selectedBlindPlanList.data?.data?.decisionSummary?.summariesByAbstractId?.[abstractId]?.includedReviews === 1 &&
      selectedBlindPlanList.data?.data?.decisionSummary?.summariesByAbstractId?.[abstractId]?.weightedAverage === 3,
    selectedBlindPlanList.status,
  );
  const crossEventDecisionPlan = await j("GET", `/api/cfp/submissions?planId=${otherPlan.id}`, null, admin);
  check(
    "C15 unknown and cross-event selected plans are indistinguishable",
    crossEventDecisionPlan.status === 404 && crossEventDecisionPlan.data?.error?.code === "PLAN_NOT_FOUND",
    crossEventDecisionPlan.status,
  );

  // M4: MAYBE is a non-final, evaluable decision state. It creates neither a
  // Session nor tasks, and only an event admin may set it.
  const anonymousMaybe = await j("POST", "/api/evaluations/decisions", { abstractId, decision: "MAYBE" });
  check("M4 anonymous callers cannot set MAYBE",
    anonymousMaybe.status === 401 && anonymousMaybe.data?.error?.code === "UNAUTHENTICATED", anonymousMaybe.status);
  const evaluatorMaybe = await j("POST", "/api/evaluations/decisions", { abstractId, decision: "MAYBE" }, evalr);
  check("M4 evaluators cannot set MAYBE",
    evaluatorMaybe.status === 403, evaluatorMaybe.status);
  const maybe = await j("POST", "/api/evaluations/decisions", { abstractId, decision: "MAYBE" }, admin);
  check("M4 MAYBE is serialized as a non-final decision with no session",
    maybe.status === 200 &&
      maybe.data?.data?.status === "MAYBE" &&
      maybe.data?.data?.decidedAt === null &&
      maybe.data?.data?.session === null &&
      maybe.data?.data?.sessionCreated === false &&
      maybe.data?.data?.tasksAssigned === 0,
    JSON.stringify(maybe.data?.data));
  check("M4 MAYBE never provisions a session or task assignment",
    await prisma.session.count({ where: { sourceAbstractId: abstractId } }) === 0 &&
      await prisma.speakerTask.count({ where: { task: { eventId: SCRATCH_EVENT.id } } }) === 0);
  const maybeScore = await j("POST", "/api/evaluations/scores", {
    planId, abstractId, scores: [{ rubricKey: "relevance", score: 4, comment: "worth a closer look" }], complete: true,
  }, evalr);
  check("M4 an existing evaluator can still score a MAYBE proposal",
    maybeScore.status === 200 && maybeScore.data?.data?.complete === true, maybeScore.status);

  // 10. Convert before acceptance (including MAYBE) must fail (INV-DOMAIN-001)
  const early = await j("POST", "/api/evaluations/convert", { abstractId, durationMinutes: 45 }, admin);
  check("M4 MAYBE cannot convert into a session", early.status === 409, early.data?.error?.code);

  // 11. A MAYBE proposal remains decidable: accepting it provisions the Session.
  const decision = await j("POST", "/api/evaluations/decisions", { abstractId, decision: "ACCEPTED" }, admin);
  check("M4 MAYBE can later be accepted", decision.status === 200 && decision.data?.data?.status === "ACCEPTED", decision.status);

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
    "O2 decision preview includes the latest comments but never scores or reviewer identities",
    decisionPreview.status === 200 &&
      decisionPreview.data?.data?.preview === true &&
      decisionPreview.data?.data?.feedbackCount === 1 &&
      decisionPreview.data?.data?.html?.includes("worth a closer look") &&
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

  // The dependent rules must track the surviving option so the payload stays
  // shape-valid under the C4 contract: a rule pinned to the removed "yes"
  // would be refused earlier as FORM_LOGIC_VALUE_NOT_AN_OPTION and this probe
  // would never reach the B5 answered-option protection it exists to prove.
  const destructiveTaskFormEdit = await j("POST", "/api/cfp/forms", {
    ...taskFormPayload,
    id: taskFormId,
    fields: [
      { ...taskFormPayload.fields[0], options: [{ label: "No", value: "no" }] },
      ...taskFormPayload.fields.slice(1).map((field) => ({
        ...field,
        conditionalLogic: { match: "all", rules: [{ fieldKey: "needs_hotel", operator: "equals", value: "no" }] },
      })),
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

  const [s15TaskFormBeforeDelete, s15TaskResponseBeforeDelete] = await Promise.all([
    prisma.formConfig.findUnique({ where: { id: taskFormId }, select: { id: true, fields: { select: { id: true } } } }),
    prisma.speakerTask.findUnique({
      where: { taskId_userId: { taskId: taskTemplate.id, userId: taskSpeaker.id } },
      select: { responses: true, status: true },
    }),
  ]);
  const s15TaskFormDelete = await j("DELETE", `/api/cfp/forms/${taskFormId}`, null, admin);
  const [s15TaskFormAfterDelete, s15TaskAfterDelete, s15TaskResponseAfterDelete] = await Promise.all([
    prisma.formConfig.findUnique({ where: { id: taskFormId }, select: { id: true, fields: { select: { id: true } } } }),
    prisma.onboardingTask.findUnique({ where: { id: taskTemplate.id }, select: { formConfigId: true } }),
    prisma.speakerTask.findUnique({
      where: { taskId_userId: { taskId: taskTemplate.id, userId: taskSpeaker.id } },
      select: { responses: true, status: true },
    }),
  ]);
  check(
    "S15 linked task assignments and responses refuse form deletion without severing history",
    s15TaskFormDelete.status === 409 &&
      s15TaskFormDelete.data?.error?.code === "FORM_HAS_ABSTRACTS" &&
      s15TaskFormAfterDelete?.id === s15TaskFormBeforeDelete?.id &&
      s15TaskFormAfterDelete?.fields.length === s15TaskFormBeforeDelete?.fields.length &&
      s15TaskAfterDelete?.formConfigId === taskFormId &&
      JSON.stringify(s15TaskResponseAfterDelete) === JSON.stringify(s15TaskResponseBeforeDelete),
    s15TaskFormDelete.status,
  );

  const s15LinkedUnusedForm = await prisma.formConfig.create({
    data: {
      eventId: SCRATCH_EVENT.id,
      name: "S15 linked unused form",
      slug: `s15-linked-unused-${Date.now().toString(36)}`,
      fields: { create: [{ key: "note", label: "Note", type: "SHORT_TEXT", required: false, sortOrder: 0 }] },
    },
    select: { id: true },
  });
  const s15LinkedUnusedTask = await prisma.onboardingTask.create({
    data: {
      eventId: SCRATCH_EVENT.id,
      title: `S15 linked unused task ${Date.now().toString(36)}`,
      formConfigId: s15LinkedUnusedForm.id,
    },
    select: { id: true },
  });
  const s15LinkedUnusedDelete = await j("DELETE", `/api/cfp/forms/${s15LinkedUnusedForm.id}`, null, admin);
  const s15LinkedUnusedAfterDelete = await prisma.onboardingTask.findUnique({
    where: { id: s15LinkedUnusedTask.id },
    select: { formConfigId: true },
  });
  check(
    "S15 any linked task blocks form deletion before it can be detached",
    s15LinkedUnusedDelete.status === 409 &&
      s15LinkedUnusedDelete.data?.error?.code === "FORM_HAS_ABSTRACTS" &&
      s15LinkedUnusedAfterDelete?.formConfigId === s15LinkedUnusedForm.id,
    s15LinkedUnusedDelete.status,
  );

  // C13: a profile PATCH is a true delta. Omitted values survive, while an
  // explicit null (or whitespace from a non-UI caller) clears only that field.
  const c13SeedProfile = await j("PATCH", "/api/portal/profile", {
    bio: "Scratch speaker bio",
    company: "Scratch Labs",
    jobTitle: "Staff Engineer",
    headshotUrl: "https://images.example.test/scratch.png",
    slideDeckUrl: "https://slides.example.test/scratch.pdf",
  }, speaker);
  const c13PartialProfile = await j("PATCH", "/api/portal/profile", {
    jobTitle: "Principal Engineer",
  }, speaker);
  const c13ClearProfile = await j("PATCH", "/api/portal/profile", {
    company: null,
    headshotUrl: "   ",
    slideDeckUrl: null,
    socialLinks: {},
  }, speaker);
  const c13StoredProfile = await prisma.speakerProfile.findUnique({
    where: { userId: taskSpeaker.id },
    select: { bio: true, company: true, jobTitle: true, headshotUrl: true, slideDeckUrl: true, socialLinks: true },
  });
  check(
    "C13 profile PATCH preserves omissions and persists explicit clears as null",
    c13SeedProfile.status === 200 &&
      c13PartialProfile.status === 200 && c13PartialProfile.data?.data?.company === "Scratch Labs" &&
      c13ClearProfile.status === 200 &&
      c13StoredProfile?.bio === "Scratch speaker bio" &&
      c13StoredProfile?.jobTitle === "Principal Engineer" &&
      c13StoredProfile?.company === null &&
      c13StoredProfile?.headshotUrl === null &&
      c13StoredProfile?.slideDeckUrl === null &&
      c13StoredProfile?.socialLinks === null,
    c13ClearProfile.status,
  );

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
  const scheduledRoomDelete = await j("DELETE", `/api/admin/settings/rooms?roomId=${roomA}`, null, admin);
  const scheduledSlotAfterDeleteRefusal = await prisma.scheduleSlot.findUnique({
    where: { id: place.data?.data?.slot?.id },
    select: { id: true, roomId: true },
  });
  const scheduledRoomAfterDeleteRefusal = await prisma.room.findUnique({ where: { id: roomA }, select: { id: true } });
  check(
    "M5 refuses in-use room deletion without cascading its schedule slot",
    scheduledRoomDelete.status === 409 &&
      scheduledRoomDelete.data?.error?.code === "ROOM_IN_USE" &&
      scheduledRoomAfterDeleteRefusal?.id === roomA &&
      scheduledSlotAfterDeleteRefusal?.roomId === roomA,
    scheduledRoomDelete.status,
  );

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

  // C12: one real task deadline is rendered in the event timezone and the
  // invitation path remains forced-mock. This is scratch-only and deliberately
  // runs while the speaker has a fully scheduled session above.
  await prisma.event.update({ where: { id: SCRATCH_EVENT.id }, data: { timezone: "America/Los_Angeles" } });
  const c12Task = await prisma.onboardingTask.create({
    data: {
      eventId: SCRATCH_EVENT.id,
      title: "C12 scratch deadline",
      required: true,
      dueAt: new Date("2026-05-02T06:59:00.000Z"),
      sortOrder: 99,
    },
  });
  // The scheduled session above belongs to the submitted primary speaker, not
  // the signed scratch account used for portal authorization checks.
  const c12Speaker = await prisma.user.findUniqueOrThrow({ where: { email: "spk@x.com" } });
  await prisma.speakerTask.create({ data: { taskId: c12Task.id, userId: c12Speaker.id, status: "TODO" } });
  const c12Template = await prisma.emailTemplate.create({
    data: {
      eventId: SCRATCH_EVENT.id,
      key: "c12-task-reminder",
      subject: "Deadline {{dueDate}}",
      htmlBody: "<p>{{talkTitle}} at {{slotTime}} in {{roomName}}. {{calendarInviteNote}}</p>",
      trigger: "task.reminder",
    },
  });
  const c12Reminder = await j("POST", "/api/comms/reminders", {
    eventId: SCRATCH_EVENT.id,
    templateKey: c12Template.key,
    recipientUserIds: [c12Speaker.id],
    includeCalendarInvite: true,
  }, admin);
  const c12Dispatch = await prisma.emailDispatch.findFirst({
    where: { templateId: c12Template.id, recipient: c12Speaker.email },
    select: { status: true, providerId: true, variables: true },
  });
  const c12Variables = c12Dispatch?.variables;
  check(
    "C12 reminder uses the task deadline and event timezone in forced mock mode",
    c12Reminder.status === 200 &&
      c12Dispatch?.status === "mocked" &&
      c12Dispatch.providerId?.startsWith("mock:") &&
      c12Variables?.dueDate === "Fri, May 1, 2026, 11:59 PM PDT" &&
      typeof c12Variables?.slotTime === "string" && c12Variables.slotTime.endsWith("PDT") &&
      c12Variables.calendarInviteNote === "A calendar invite is attached.",
    c12Reminder.status,
  );

  // C5-EMAIL: the dispatch log written above is now readable. Before this panel
  // an operator had no evidence any email ever left, and a bulk send's failure
  // count named neither recipient nor reason.
  const emailHistorySpeaker = await fetch(`${BASE}/admin/emails`, {
    headers: { cookie: cookie(speaker) },
    redirect: "manual",
  });
  check("C5 email history refuses a speaker",
    [307, 308, 403].includes(emailHistorySpeaker.status), emailHistorySpeaker.status);
  const emailHistoryAnon = await fetch(`${BASE}/admin/emails`, { redirect: "manual" });
  check("C5 email history refuses an anonymous visitor",
    [307, 308, 401, 403].includes(emailHistoryAnon.status), emailHistoryAnon.status);

  const emailHistoryAdmin = await fetch(`${BASE}/admin/emails`, { headers: { cookie: cookie(admin) } });
  const emailHistoryHtml = await emailHistoryAdmin.text();
  check("C5 email history renders the mocked reminder dispatch as recorded, never delivered",
    emailHistoryAdmin.status === 200 &&
      emailHistoryHtml.includes(c12Speaker.email) &&
      emailHistoryHtml.includes(c12Template.key) &&
      emailHistoryHtml.includes("Mocked") &&
      // The mocked row carries a sentAt like a real send; the panel must not
      // let that timestamp become a delivery claim for this dispatch.
      emailHistoryHtml.includes("not delivered"),
    emailHistoryAdmin.status);
  check("C5 email history leaks no provider credential, bearer, or dispatch variable bag",
    !/RESEND_API_KEY|Bearer\s|Idempotency-Key|"providerId"|mock:/i.test(emailHistoryHtml) &&
      !emailHistoryHtml.includes(process.env.RESEND_API_KEY || " no-resend-key-configured"),
    "credential appeared in /admin/emails");

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

  // S16: an editable speaker writer takes the same FormConfig -> FormField
  // locks as a public writer before it joins the per-Abstract lock. Hold that
  // final lock so both compatible form locks are observable while the PATCH is
  // still pending, then prove a public submit can finish before release.
  const s16OrderSubmit = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId, title: "S16 ordered writer",
    speakers: [
      { email: "s16-order@scratch.test", name: "S16 Order", isPrimary: true },
      { email: speaker.user.email, name: speaker.user.name, isPrimary: false },
    ],
    answers: { title_note: "ordered", consent: true }, intent: "submit",
  });
  const s16OrderId = s16OrderSubmit.data?.data?.id;
  check("S16 order setup: submitted proposal created", s16OrderSubmit.status === 201 && !!s16OrderId);
  // One combined query per observation: the waiting speaker PATCH burns its
  // 5-second server transaction budget while this probe polls, and two
  // sequential round-trips per attempt against a remote database repeatedly
  // pushed the release past that budget (P2028 at ~5.09s in two runs).
  const countSpeakerFormShareLocks = async () => {
    const rows = await prisma.$queryRaw`
      SELECT
        count(*) FILTER (WHERE relation = '"FormConfig"'::regclass)::int AS "formConfig",
        count(*) FILTER (WHERE relation = '"FormField"'::regclass)::int AS "formField"
      FROM pg_locks
      WHERE mode = 'RowShareLock' AND granted
    `;
    return rows[0] ?? { formConfig: 0, formField: 0 };
  };
  const waitForSpeakerFormLocks = async ({ baselineFormConfigShares, baselineFormFieldShares }) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const shares = await countSpeakerFormShareLocks();
      if (shares.formConfig > baselineFormConfigShares && shares.formField > baselineFormFieldShares) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  };
  let signalS16AbstractLock;
  let releaseS16AbstractLock;
  const s16AbstractLockHeld = new Promise((resolve) => { signalS16AbstractLock = resolve; });
  const s16AbstractLockRelease = new Promise((resolve) => { releaseS16AbstractLock = resolve; });
  const s16AbstractHolder = prisma.$transaction(async (tx) => {
    const key = `abstract-write:${s16OrderId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    signalS16AbstractLock();
    await s16AbstractLockRelease;
  // The 5-second observation below remains the regression boundary. This
  // deliberately held fixture transaction needs only enough headroom to let
  // its finally release/commit survive host scheduling jitter.
  }, { timeout: 15_000 });
  await s16AbstractLockHeld;
  const s16BaselineShares = await countSpeakerFormShareLocks();
  const s16OrderLockBaseline = {
    baselineFormConfigShares: s16BaselineShares.formConfig,
    baselineFormFieldShares: s16BaselineShares.formField,
  };
  const waitingSpeakerEdit = j("PATCH", `/api/cfp/submissions/${s16OrderId}`, {
    title: "S16 ordered edit",
  }, speaker);
  const speakerHeldFormLocksBeforeAbstract = await waitForSpeakerFormLocks(s16OrderLockBaseline);
  const compatiblePublicAbort = new AbortController();
  const compatiblePublicSubmit = j("POST", "/api/cfp/submissions", {
    formConfigId: formId, title: "S16 concurrent public writer",
    speakers: [{ email: "s16-public@scratch.test", name: "S16 Public", isPrimary: true }],
    answers: { title_note: "public", consent: true }, intent: "submit",
  }, undefined, {}, { signal: compatiblePublicAbort.signal });
  let compatiblePublicObservation;
  try {
    // If a lock-order regression blocks this public writer, do not leave the
    // held advisory lock waiting forever. The result still fails honestly.
    // 3s, not 4s: a healthy public submit completes well under this, and every
    // spare second here is margin returned to the waiting speaker PATCH's
    // 5-second server transaction budget.
    compatiblePublicObservation = await observeBeforeDeadline(compatiblePublicSubmit, 3_000);
  } finally {
    if (!compatiblePublicObservation?.completed) compatiblePublicAbort.abort();
    releaseS16AbstractLock();
    await s16AbstractHolder;
  }
  const compatiblePublicResult = compatiblePublicObservation?.value;
  const waitingSpeakerEditResult = await waitingSpeakerEdit;
  check("S16 speaker locks FormConfig and fields before the Abstract advisory lock",
    speakerHeldFormLocksBeforeAbstract && waitingSpeakerEditResult.status === 200,
    waitingSpeakerEditResult.status);
  check("S16 compatible public writer completes while speaker waits on Abstract",
    compatiblePublicObservation?.completed && !compatiblePublicObservation.error && compatiblePublicResult?.status === 201,
    compatiblePublicObservation?.completed
      ? compatiblePublicObservation.error?.name ?? compatiblePublicResult?.status
      : "timed out before Abstract release");

  // The Session and editability checks are also post-lock facts. A competing
  // programme writer makes this formerly submitted abstract ACCEPTED and links
  // a Session before committing. The pre-lock roster check would have allowed
  // a destructive roster mutation; the fresh read must refuse it instead.
  const s16SessionSubmit = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId, title: "S16 fresh session",
    speakers: [
      { email: "s16-session@scratch.test", name: "S16 Session", isPrimary: true },
      { email: speaker.user.email, name: speaker.user.name, isPrimary: false },
    ],
    answers: { title_note: "session", consent: true }, intent: "submit",
  });
  const s16SessionId = s16SessionSubmit.data?.data?.id;
  check("S16 session setup: submitted proposal created", s16SessionSubmit.status === 201 && !!s16SessionId);
  let signalS16SessionWriter;
  let releaseS16SessionWriter;
  const s16SessionWriterReady = new Promise((resolve) => { signalS16SessionWriter = resolve; });
  const s16SessionWriterRelease = new Promise((resolve) => { releaseS16SessionWriter = resolve; });
  const s16SessionWriter = prisma.$transaction(async (tx) => {
    const key = `abstract-write:${s16SessionId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    await tx.abstract.update({
      where: { id: s16SessionId },
      data: { status: "ACCEPTED", decidedAt: new Date() },
    });
    await tx.session.create({
      data: {
        eventId: SCRATCH_EVENT.id,
        sourceAbstractId: s16SessionId,
        title: "S16 fresh session",
        durationMinutes: 30,
      },
    });
    signalS16SessionWriter();
    await s16SessionWriterRelease;
  });
  await s16SessionWriterReady;
  const s16SessionBaselineShares = await countSpeakerFormShareLocks();
  const s16SessionLockBaseline = {
    baselineFormConfigShares: s16SessionBaselineShares.formConfig,
    baselineFormFieldShares: s16SessionBaselineShares.formField,
  };
  const staleSessionRosterEdit = j("PATCH", `/api/cfp/submissions/${s16SessionId}`, {
    speakers: [
      { email: speaker.user.email, name: speaker.user.name, isPrimary: true },
    ],
  }, speaker);
  const sessionEditTookFormLocks = await waitForSpeakerFormLocks(s16SessionLockBaseline);
  releaseS16SessionWriter();
  await s16SessionWriter;
  const staleSessionRosterEditResult = await staleSessionRosterEdit;
  const s16SessionAfter = await prisma.session.findUnique({
    where: { sourceAbstractId: s16SessionId },
    include: { sourceAbstract: { include: { speakers: true } } },
  });
  check("S16 fresh linked-Session check refuses a roster edit after the writer commits",
    sessionEditTookFormLocks && staleSessionRosterEditResult.status === 409 &&
      staleSessionRosterEditResult.data?.error?.code === "SPEAKERS_LOCKED",
    staleSessionRosterEditResult.status);
  check("S16 linked-Session refusal preserves the fresh accepted status and roster",
    s16SessionAfter?.sourceAbstract?.status === "ACCEPTED" &&
      s16SessionAfter.sourceAbstract.speakers.length === 2,
    s16SessionAfter?.sourceAbstract?.status);

  // A terminal writer uses the same final lock. The route read occurs before
  // that writer commits, so this makes stale terminal-state enforcement
  // deterministic rather than relying on request timing.
  const s16TerminalSubmit = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId, title: "S16 fresh terminal",
    speakers: [
      { email: "s16-terminal@scratch.test", name: "S16 Terminal", isPrimary: true },
      { email: speaker.user.email, name: speaker.user.name, isPrimary: false },
    ],
    answers: { title_note: "terminal", consent: true }, intent: "submit",
  });
  const s16TerminalId = s16TerminalSubmit.data?.data?.id;
  check("S16 terminal setup: submitted proposal created", s16TerminalSubmit.status === 201 && !!s16TerminalId);
  let signalS16TerminalWriter;
  let releaseS16TerminalWriter;
  const s16TerminalWriterReady = new Promise((resolve) => { signalS16TerminalWriter = resolve; });
  const s16TerminalWriterRelease = new Promise((resolve) => { releaseS16TerminalWriter = resolve; });
  const s16TerminalWriter = prisma.$transaction(async (tx) => {
    const key = `abstract-write:${s16TerminalId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    await tx.abstract.update({
      where: { id: s16TerminalId },
      data: { status: "REJECTED", decidedAt: new Date() },
    });
    signalS16TerminalWriter();
    await s16TerminalWriterRelease;
  });
  await s16TerminalWriterReady;
  const s16TerminalBaselineShares = await countSpeakerFormShareLocks();
  const s16TerminalLockBaseline = {
    baselineFormConfigShares: s16TerminalBaselineShares.formConfig,
    baselineFormFieldShares: s16TerminalBaselineShares.formField,
  };
  const staleTerminalEdit = j("PATCH", `/api/cfp/submissions/${s16TerminalId}`, {
    title: "S16 stale terminal attempt",
  }, speaker);
  const terminalEditTookFormLocks = await waitForSpeakerFormLocks(s16TerminalLockBaseline);
  releaseS16TerminalWriter();
  await s16TerminalWriter;
  const staleTerminalEditResult = await staleTerminalEdit;
  const s16TerminalAfter = await prisma.abstract.findUnique({
    where: { id: s16TerminalId },
    select: { status: true, title: true },
  });
  check("S16 fresh terminal-state check refuses content edited from a stale read",
    terminalEditTookFormLocks && staleTerminalEditResult.status === 409 &&
      staleTerminalEditResult.data?.error?.code === "ABSTRACT_LOCKED",
    staleTerminalEditResult.status);
  check("S16 terminal refusal preserves the competing writer's state and content",
    s16TerminalAfter?.status === "REJECTED" && s16TerminalAfter.title === "S16 fresh terminal",
    s16TerminalAfter?.status);

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

  // CFP-16 — the close date locks edits to a proposal the programme team has
  // NOT accepted, while the accepted carve-out survives. This still-SUBMITTED
  // proposal has to exist before the window shuts.
  // A distinct primary email keeps this example out of the scratch speaker's
  // 24h submit-rate bucket; the scratch speaker rides along as a co-speaker, so
  // the authenticated PATCH path is still exercised by a real AbstractSpeaker.
  const cfp16Submit = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId, title: "Submitted before the deadline",
    speakers: [
      { email: "cfp16@scratch.test", name: "CFP16 Primary", isPrimary: true },
      { email: speaker.user.email, name: speaker.user.name, isPrimary: false },
    ],
    answers: { title_note: "on time", consent: true }, intent: "submit",
  });
  const cfp16Id = cfp16Submit.data?.data?.id;
  check("CFP-16 setup: a SUBMITTED proposal exists while the window is open",
    cfp16Submit.status === 201 && !!cfp16Id, cfp16Submit.status);
  const cfp16OpenEdit = await j("PATCH", `/api/cfp/submissions/${cfp16Id}`, {
    title: "Edited before the deadline",
  }, speaker);
  check("CFP-16 the same edit succeeds while the window is still open",
    cfp16OpenEdit.status === 200 && cfp16OpenEdit.data?.data?.submission?.title === "Edited before the deadline",
    cfp16OpenEdit.status);

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

  const cfp16ClosedEdit = await j("PATCH", `/api/cfp/submissions/${cfp16Id}`, {
    title: "Edited after the deadline",
  }, speaker);
  check("CFP-16 a SUBMITTED proposal is refused after the close date (409 EDIT_WINDOW_CLOSED)",
    cfp16ClosedEdit.status === 409 && cfp16ClosedEdit.data?.error?.code === "EDIT_WINDOW_CLOSED",
    `${cfp16ClosedEdit.status}/${cfp16ClosedEdit.data?.error?.code}`);
  check("CFP-16 the refusal is plain language and leaks no error code",
    typeof cfp16ClosedEdit.data?.error?.message === "string" &&
      cfp16ClosedEdit.data.error.message.length > 20 &&
      !/[A-Z_]{4,}/.test(cfp16ClosedEdit.data.error.message),
    cfp16ClosedEdit.data?.error?.message);
  check("CFP-16 the refused edit did not persist",
    (await prisma.abstract.findUnique({ where: { id: cfp16Id }, select: { title: true } }))?.title ===
      "Edited before the deadline");

  const mineAfterClose = await j("GET", "/api/cfp/submissions/mine", null, speaker);
  const cfp16Row = mineAfterClose.data?.data?.submissions?.find((s) => s.id === cfp16Id);
  const acceptedRow = mineAfterClose.data?.data?.submissions?.find((s) => s.id === r1Id);
  check("CFP-16 the portal read agrees with the server: locked row, editable accepted row",
    cfp16Row?.canEdit === false && typeof cfp16Row?.lockReason === "string" &&
      !/[A-Z_]{4,}/.test(cfp16Row.lockReason) &&
      acceptedRow?.canEdit === true && acceptedRow?.lockReason === null,
    `${cfp16Row?.canEdit}/${acceptedRow?.canEdit}`);

  // The deliberate carve-out: an ACCEPTED speaker still edits after the close.
  const editAfterClose = await j("PATCH", `/api/cfp/submissions/${r1Id}`, {
    title: "Edited after the window closed",
  }, speaker);
  check("CFP-16 an ACCEPTED speaker can still edit after the CFP window closes",
    editAfterClose.status === 200 && editAfterClose.data?.data?.submission?.title === "Edited after the window closed",
    editAfterClose.status);

  // Refusing a withdrawal because the window shut would trap the speaker in a
  // talk they no longer want to give, so W1 is deliberately not close-gated.
  const cfp16Withdraw = await j("PATCH", `/api/cfp/submissions/${cfp16Id}`, { status: "WITHDRAWN" }, speaker);
  check("CFP-16 a speaker can still withdraw after the close date",
    cfp16Withdraw.status === 200 && cfp16Withdraw.data?.data?.submission?.status === "WITHDRAWN",
    `${cfp16Withdraw.status}/${cfp16Withdraw.data?.error?.code}`);
  const cfp16AfterWithdraw = await j("PATCH", `/api/cfp/submissions/${cfp16Id}`, { title: "Still trying" }, speaker);
  check("CFP-16 a withdrawn proposal still reports its own status lock, not the closed window",
    cfp16AfterWithdraw.status === 409 && cfp16AfterWithdraw.data?.error?.code === "ABSTRACT_LOCKED",
    cfp16AfterWithdraw.data?.error?.code);

  // Regression guard: capability/DRAFT authorization precedes window policy,
  // so a cap-less anonymous edit never learns whether this form is closed.
  const publicOverwrite = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId, abstractId: r1Id, title: "Anonymous overwrite",
    speakers: [{ email: "attacker@scratch.test", name: "Attacker", isPrimary: true }],
    answers: {}, intent: "saveDraft",
  });
  check("R1 cap-less anonymous edit after close stays the generic draft 404",
    publicOverwrite.status === 404 && publicOverwrite.data?.error?.code === "DRAFT_NOT_FOUND",
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

  const wCompletedScore = await j("POST", "/api/evaluations/scores", {
    planId, abstractId: wId, scores: [{ rubricKey: "relevance", score: 4 }], complete: true,
  }, evalr);
  const wOpenAssignment = await j("POST", "/api/evaluations/assignments", {
    planId, abstractIds: [wId], evaluatorIds: [adminUserId],
  }, admin);
  check("C6 setup: one completed and one open review exist before withdrawal",
    wCompletedScore.status === 200 && wOpenAssignment.status === 201,
    `${wCompletedScore.status}/${wOpenAssignment.status}`);

  const wBundled = await j("PATCH", `/api/cfp/submissions/${wId}`, {
    status: "WITHDRAWN", title: "Sneaky rename on the way out",
  }, speaker);
  check("W1 withdraw bundled with a content edit refused (422)", wBundled.status === 422, wBundled.data?.error?.code);

  const wStranger = await j("PATCH", `/api/cfp/submissions/${wId}`, { status: "WITHDRAWN" }, evalr);
  check("W1 only a speaker on the abstract can withdraw it",
    wStranger.status === 403 && wStranger.data?.error?.code === "NOT_YOUR_SUBMISSION", wStranger.status);

  const wDraw = await j("PATCH", `/api/cfp/submissions/${wId}`, { status: "WITHDRAWN" }, speaker);
  check("M6 portal contract: speaker withdraws an UNDER_REVIEW proposal",
    wDraw.status === 200 && wDraw.data?.data?.submission?.status === "WITHDRAWN" &&
    wDraw.data?.data?.submission?.canEdit === false, wDraw.status);
  check("W1 withdrawing does not stamp a programme decision",
    wDraw.data?.data?.submission?.decidedAt === null && wDraw.data?.data?.submission?.canEdit === false);

  const wAssignmentHistory = await prisma.reviewAssignment.findMany({
    where: { planId, abstractId: wId },
    select: { evaluatorId: true, status: true, completedAt: true },
  });
  const wCompletedHistory = wAssignmentHistory.find((assignment) => assignment.evaluatorId === evaluatorId);
  const wOpenHistory = wAssignmentHistory.find((assignment) => assignment.evaluatorId === adminUserId);
  const wHistoricalScoreCount = await prisma.reviewScore.count({
    where: { planId, abstractId: wId, evaluatorId },
  });
  check("C6 withdrawal declines open work and preserves completed review history",
    wCompletedHistory?.status === "COMPLETED" && !!wCompletedHistory.completedAt &&
      wOpenHistory?.status === "DECLINED" && wOpenHistory.completedAt === null &&
      wHistoricalScoreCount === 1,
    `${wCompletedHistory?.status}/${wOpenHistory?.status}/${wHistoricalScoreCount}`);

  const assignWithdrawn = await j("POST", "/api/evaluations/assignments", {
    planId, abstractIds: [wId], evaluatorIds: [adminUserId],
  }, admin);
  check("S5 withdrawn proposal cannot gain a new assignment",
    assignWithdrawn.status === 409 && assignWithdrawn.data?.error?.code === "ABSTRACT_NOT_REVIEWABLE",
    assignWithdrawn.data?.error?.code);
  check("S5 withdrawn status and C6-declined assignment survive the refused write",
    (await prisma.abstract.findUnique({ where: { id: wId }, select: { status: true } }))?.status === "WITHDRAWN" &&
      await prisma.reviewAssignment.count({
        where: { planId, abstractId: wId, evaluatorId: adminUserId },
      }) === 1 &&
      (await prisma.reviewAssignment.findUnique({
        where: { planId_abstractId_evaluatorId: { planId, abstractId: wId, evaluatorId: adminUserId } },
        select: { status: true },
      }))?.status === "DECLINED");

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
    wQueue.status === 200 && wQueueRow?.abstract?.status === "WITHDRAWN" && wQueueRow?.status === "COMPLETED",
    `${wQueueRow?.abstract?.status}/${wQueueRow?.status}`);
  const wActiveLoad = await prisma.reviewAssignment.count({
    where: { planId, abstractId: wId, abstract: { status: { not: "WITHDRAWN" } } },
  });
  check("C6 withdrawn work remains excluded from active progress and reviewer load", wActiveLoad === 0, wActiveLoad);

  const wAccepted = await j("PATCH", `/api/cfp/submissions/${r1Id}`, { status: "WITHDRAWN" }, speaker);
  check("M6 accepted/converted talk refusal is an actionable 409",
    wAccepted.status === 409 && wAccepted.data?.error?.code === "WITHDRAW_NOT_ALLOWED" &&
    /contact the program team/i.test(wAccepted.data?.error?.message ?? ""), wAccepted.status);

  // C6: score and withdrawal share the Abstract advisory class. Queue the
  // scorer first behind a deliberately held lock, then queue withdrawal; when
  // released, the score completes before withdrawal closes only the remaining
  // open assignment. This exercises the fresh post-lock status check instead
  // of relying on request timing.
  //
  // Earlier sections legitimately consume the 10/24h submit budget for this
  // reused scratch primary email, so clear that one scratch-owned bucket first
  // — otherwise this anonymous setup submit is correctly refused by S19 and
  // the race never forms. Same scratch hygiene as the harness's teardown.
  await prisma.publicSubmissionRateBucket.deleteMany({
    where: {
      eventId: SCRATCH_EVENT.id,
      scope: "submit_primary_email_24h",
      fingerprint: publicSubmissionRateFingerprint("primary-email", speaker.user.email.trim().toLowerCase()),
    },
  });
  const c6RaceSubmit = await j("POST", "/api/cfp/submissions", {
    formConfigId: formId, title: "C6 score withdrawal serialization",
    speakers: [{ email: speaker.user.email, name: speaker.user.name, isPrimary: true }],
    answers: { title_note: "c6-race", consent: true }, intent: "submit",
  });
  const c6RaceId = c6RaceSubmit.data?.data?.id;
  const c6RaceAssign = await j("POST", "/api/evaluations/assignments", {
    planId, abstractIds: [c6RaceId], evaluatorIds: [evaluatorId, adminUserId],
  }, admin);
  check("C6 race setup: submitted proposal has two open assignments",
    c6RaceSubmit.status === 201 && c6RaceAssign.status === 201 && !!c6RaceId,
    c6RaceAssign.status);

  let signalC6AbstractLock;
  let releaseC6AbstractLock;
  const c6AbstractLockHeld = new Promise((resolve) => { signalC6AbstractLock = resolve; });
  const c6AbstractLockRelease = new Promise((resolve) => { releaseC6AbstractLock = resolve; });
  const c6AbstractLockName = `abstract-write:${c6RaceId}`;
  const c6AbstractHolder = prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${c6AbstractLockName}, 0))`;
    signalC6AbstractLock();
    await c6AbstractLockRelease;
    // 60s, not the 15s default: the two advisory-waiter polls run up to 200
    // sequential queries on a separate connection, and remote-database RTT
    // accumulation must not expire the deliberately held holder mid-test.
  }, { timeout: 60_000 });
  await c6AbstractLockHeld;
  const countWaitingAdvisoryLocks = async () => {
    // Count only waiters for THIS abstract's advisory key: an unfiltered
    // global count could be satisfied by unrelated waiters in the shared
    // database, releasing the holder before the intended requests queue. For
    // the one-argument bigint form, classid holds the key's high 32 bits and
    // objid the low 32 (objsubid 1); the signed shift reproduces the exact
    // hashtextextended bit pattern.
    const rows = await prisma.$queryRaw`
      SELECT count(*)::int AS "count"
      FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
        AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${c6AbstractLockName}, 0)
    `;
    return rows[0]?.count ?? 0;
  };
  const waitForAdvisoryWaiters = async (minimum) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await countWaitingAdvisoryLocks() >= minimum) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  };
  const c6RacingScore = j("POST", "/api/evaluations/scores", {
    planId, abstractId: c6RaceId, scores: [{ rubricKey: "relevance", score: 5 }], complete: true,
  }, evalr);
  let c6ScoreQueued = false;
  let c6WithdrawalQueued = false;
  let c6RacingWithdrawal;
  try {
    c6ScoreQueued = await waitForAdvisoryWaiters(1);
    c6RacingWithdrawal = j("PATCH", `/api/cfp/submissions/${c6RaceId}`, { status: "WITHDRAWN" }, speaker);
    c6WithdrawalQueued = await waitForAdvisoryWaiters(2);
  } finally {
    releaseC6AbstractLock();
    await c6AbstractHolder;
  }
  const [c6ScoreResult, c6WithdrawalResult] = await Promise.all([c6RacingScore, c6RacingWithdrawal]);
  const c6RaceAssignments = await prisma.reviewAssignment.findMany({
    where: { planId, abstractId: c6RaceId },
    select: { evaluatorId: true, status: true, completedAt: true },
    orderBy: { evaluatorId: "asc" },
    take: 20,
  });
  const c6EvaluatorHistory = c6RaceAssignments.find((assignment) => assignment.evaluatorId === evaluatorId);
  const c6AdminHistory = c6RaceAssignments.find((assignment) => assignment.evaluatorId === adminUserId);
  const c6RaceScoreCount = await prisma.reviewScore.count({
    where: { planId, abstractId: c6RaceId, evaluatorId },
  });
  check("C6 held Abstract ordering preserves the completed score and declines only remaining open work",
    c6ScoreQueued && c6WithdrawalQueued && c6ScoreResult.status === 200 && c6WithdrawalResult.status === 200 &&
      c6EvaluatorHistory?.status === "COMPLETED" && !!c6EvaluatorHistory.completedAt &&
      c6AdminHistory?.status === "DECLINED" && c6AdminHistory.completedAt === null && c6RaceScoreCount === 1,
    `${c6ScoreQueued}/${c6WithdrawalQueued}/${c6ScoreResult.status}/${c6WithdrawalResult.status}/${c6EvaluatorHistory?.status}/${c6AdminHistory?.status}`);
  const c6StaleScore = await j("POST", "/api/evaluations/scores", {
    planId, abstractId: c6RaceId, scores: [{ rubricKey: "relevance", score: 1 }], complete: false,
  }, evalr);
  const c6AfterStaleScore = await prisma.reviewAssignment.findMany({
    where: { planId, abstractId: c6RaceId },
    select: { evaluatorId: true, status: true, completedAt: true },
    orderBy: { evaluatorId: "asc" },
    take: 20,
  });
  check("C6 stale score after withdrawal is refused without reopening completed or declined work",
    c6StaleScore.status === 409 && c6StaleScore.data?.error?.code === "ABSTRACT_WITHDRAWN" &&
      c6AfterStaleScore.find((assignment) => assignment.evaluatorId === evaluatorId)?.status === "COMPLETED" &&
      c6AfterStaleScore.find((assignment) => assignment.evaluatorId === adminUserId)?.status === "DECLINED",
    `${c6StaleScore.status}/${c6StaleScore.data?.error?.code}`);

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

  const m4FixtureLimit = 100;
  const m4TaskIds = (await prisma.onboardingTask.findMany({
    where: { eventId: SCRATCH_EVENT.id }, select: { id: true }, take: m4FixtureLimit + 1,
  })).map((task) => task.id);
  const m4SpeakerIds = (await prisma.sessionSpeaker.findMany({
    where: { sessionId }, select: { userId: true }, take: m4FixtureLimit + 1,
  })).map((speakerRow) => speakerRow.userId);
  if (m4TaskIds.length > m4FixtureLimit || m4SpeakerIds.length > m4FixtureLimit) {
    throw new Error(`M4 scratch fixture exceeds its ${m4FixtureLimit}-row bound`);
  }
  const m4CohortWhere = { taskId: { in: m4TaskIds }, userId: { in: m4SpeakerIds } };
  const m4TasksBeforeMaybe = await prisma.speakerTask.count({ where: m4CohortWhere });
  const expectedM4Backfill = (m4TaskIds.length * m4SpeakerIds.length) - m4TasksBeforeMaybe;

  // MAYBE is a pre-confirmation state. Refusing it once a Session exists keeps
  // every public programme consumer on one status and preserves the Session.
  const scheduledMaybe = await j("POST", "/api/evaluations/decisions", { abstractId, decision: "MAYBE" }, admin);
  check("M4 a confirmed Session cannot return to MAYBE",
    scheduledMaybe.status === 409 && scheduledMaybe.data?.error?.code === "MAYBE_NOT_AVAILABLE",
    scheduledMaybe.data?.error?.code);
  check("M4 the refused MAYBE transition preserves accepted programme truth and its task cohort",
    (await prisma.abstract.findUnique({ where: { id: abstractId }, select: { status: true } }))?.status === "ACCEPTED" &&
    await prisma.session.count({ where: { sourceAbstractId: abstractId } }) === 1 &&
      await prisma.speakerTask.count({ where: m4CohortWhere }) === m4TasksBeforeMaybe);
  const restoredAccepted = await j("POST", "/api/evaluations/decisions", { abstractId, decision: "ACCEPTED" }, admin);
  check("M4 re-accepting still avoids duplicate Session provisioning and reconciles missing tasks",
    restoredAccepted.status === 200 &&
      restoredAccepted.data?.data?.status === "ACCEPTED" &&
      typeof restoredAccepted.data?.data?.decidedAt === "string" &&
      restoredAccepted.data?.data?.session?.id === sessionId &&
      restoredAccepted.data?.data?.sessionCreated === false &&
      restoredAccepted.data?.data?.tasksAssigned === expectedM4Backfill &&
      await prisma.session.count({ where: { sourceAbstractId: abstractId } }) === 1 &&
      await prisma.speakerTask.count({ where: m4CohortWhere }) ===
        m4TasksBeforeMaybe + expectedM4Backfill,
    JSON.stringify(restoredAccepted.data?.data));

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
  await cleanup();
  const failed = results.filter(r => r.ok === false);
  console.log(`\n=== ${results.filter(r=>r.ok).length} passed, ${failed.length} failed ===`);
  process.exit(fatalError || failed.length || cleanupFailed ? 1 : 0);
}
