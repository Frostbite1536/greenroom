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
// ABS-12 needs a reviewer whose entire queue is the one assignment it declines.
// Ravi cannot serve: by the time that section runs he still holds `setupAbstract`
// open, so the workspace correctly opens on that instead of the declined row.
const CONFLICT_REVIEWER_EMAIL = "conflict-reviewer@scratch.test";
// A scratch-only co-speaker with a filled profile. Deliberately NOT one of the
// shared demo users: writing a QA bio onto sofia@greenroom-hq.com would surface
// in the seeded event's own public speaker widget, which is exactly the litter
// the eval run flagged. This identity is created and deleted with the scratch
// event.
const EMBED_SPEAKER_EMAIL = "embed-speaker@scratch.test";
// A second scratch co-speaker deliberately left WITHOUT a SpeakerProfile, to
// exercise the derived fallback line. It cannot be one of the demo speakers:
// `lib/demo/seed.ts` upserts a global SpeakerProfile (a distinct fictional
// title and company per speaker) for every demo speaker user, and that row is
// keyed by userId, so it survives this script's event-scoped wipe entirely.
const EMBED_NOPROFILE_EMAIL = "embed-noprofile@scratch.test";
// SPK-01 needs the case the old roster could not show at all: someone the
// organizer has named a speaker who is on no session yet. She must not be on
// any Session, or she would arrive through the old SessionSpeaker read and
// prove nothing about the widened one.
const ROSTER_MEMBER_EMAIL = "roster-member@scratch.test";
const ROSTER_MEMBER_NAME = "Priya Raman";
const ROSTER_MEMBER_COMPANY = "Lumen Grid";
const ROSTER_MEMBER_BIO = "Priya has run platform reliability at Lumen Grid for eight years and "
  + "writes about capacity planning for live events.";
const ROSTER_MEMBER_HEADSHOT = "https://images.example.test/priya-raman.jpg";
// SPK-02 provisioning target: created only through the API, never seeded.
const ROSTER_NEW_EMAIL = "roster-new@scratch.test";
const ROSTER_NEW_NAME = "Marcus Bell";
// A speaker who belongs to a different event entirely, so a cross-event id can
// be proven indistinguishable from an unknown one.
const ROSTER_FOREIGN_EMAIL = "roster-foreign@scratch.test";
// A speaker on THIS event's roster who also takes part in another one. Her
// SpeakerProfile is a single global row feeding both events' public pages, so
// this event's organizer must not be able to write it (S1 authority class).
const ROSTER_SHARED_EMAIL = "roster-shared@scratch.test";
const ROSTER_SHARED_NAME = "Dana Okafor";
const EMBED_NOPROFILE_NAME = "Theo Lindqvist";
const EMBED_SPEAKER_NAME = "Nadia Okonkwo";
const EMBED_SPEAKER_BIO = "Nadia leads platform reliability at Northwind and has spent a decade "
  + "keeping large event systems online under load. She writes about incident review culture.";
const EMBED_SPEAKER_HEADSHOT = "https://images.example.test/nadia-okonkwo.jpg";
// Longer than DESCRIPTION_PREVIEW_CHARS (180) so the collapsed preview and the
// Show more control are both exercised.
const SESSION_A_DESCRIPTION = "This session walks through the production incident that took our "
  + "scheduling pipeline down for six hours, the three false root causes we chased first, and the "
  + "instrumentation change that would have caught it in minutes. Bring questions about on-call.";
// §5-4: a talk carrying the internal provenance note the seed writes. It exists
// so the guard is exercised against the real string rather than a paraphrase —
// this text must never appear in a public byte, and its card must show the
// honest fallback instead.
const PROVENANCE_SESSION_TITLE = "Scratch Session P (provenance description)";
const PROVENANCE_DESCRIPTION = "Confirmed session converted from an accepted abstract.";
const PUBLIC_SUMMARY_FALLBACK = "A summary for this session has not been published yet.";
// The attendee-facing summary the converted talk must carry onto the public
// programme. Distinctive so a match cannot be an accident of other fixture copy.
const CONVERTED_ABSTRACT_SUMMARY = "Three field-tested tactics for shrinking a release train, "
  + "with the rollback story that taught us the second one.";
// A second, deliberately empty event: the fresh-event empty states are the
// first thing a judge driving the product live will see, so they are asserted
// rather than assumed.
const FRESH_EVENT_ID = "scratch-frontend-fresh";
// S20 also needs an event-scoping boundary target. It is created only by this
// scratch fixture and deleted with the other disposable events.
const S20_OTHER_EVENT_ID = "scratch-frontend-s20-other";
// D-C5-16 needs an event the switching admin has NO membership on, so a real
// foreign event id can be proven indistinguishable from a forged one.
const SWITCH_FOREIGN_EVENT_ID = "scratch-frontend-switch-foreign";
// S2 creates a separate event with the same published form slug. It proves
// canonical public URLs remain event-scoped and the legacy slug route fails
// closed instead of choosing one candidate.
const S2_OTHER_EVENT_ID = "scratch-frontend-s2-other";
// D-C5-9 creates a real event through the API, so it cannot be one of the fixed
// scratch ids: its id is a server-generated cuid. It is cleaned up by SLUG —
// both the one that succeeds and the `${slug}-*` variants the refusal checks
// attempt — so a failed run cannot leave an event behind to collide next time.
const CREATED_EVENT_SLUG = "scratch-frontend-created";
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
const admin = { user: { id: "x", name: "Maya Chen", email: "maya@greenroom-hq.com" }, event: ev, role: "ADMIN" };
const evaluator = { user: { id: "x", name: "Ravi Patel", email: "ravi@greenroom-hq.com" }, event: ev, role: "EVALUATOR" };
const evaluatorTwo = { user: { id: "x", name: "Casey Morgan", email: SECOND_EVALUATOR_EMAIL }, event: ev, role: "EVALUATOR" };
const speaker = { user: { id: "x", name: "Sofia Marques", email: "sofia@greenroom-hq.com" }, event: ev, role: "SPEAKER" };
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

/**
 * Undo RFC 5545 §3.1 line folding before asserting on .ics content.
 *
 * A content line over 75 octets is split with CRLF + a single leading space,
 * so a naive `includes()` on a long URL or DESCRIPTION silently fails — and a
 * naive `!includes()` silently PASSES, which is the dangerous direction.
 */
const unfoldIcs = (text) => text.replace(/\r\n /g, "");

/**
 * GRA2-06: the admin overlays are native `<dialog>` elements now, so "a modal
 * is present in this response" means the element. The retired hand-rolled
 * `role="dialog"` pattern is still tested for, because every use of this helper
 * is a NEGATIVE assertion somewhere — dropping the old pattern from the test
 * would make those pass vacuously if any surface regressed back to it.
 */
const hasModal = (html) => /<dialog\b/i.test(html) || /role="dialog"/i.test(html);

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
  await prisma.event.deleteMany({ where: { id: { in: [EVENT_ID, FRESH_EVENT_ID, S20_OTHER_EVENT_ID, S2_OTHER_EVENT_ID, SWITCH_FOREIGN_EVENT_ID] } } });
  await prisma.event.deleteMany({ where: { slug: { startsWith: CREATED_EVENT_SLUG } } });
  await prisma.user.deleteMany({ where: { email: { in: [BLIND_SPEAKER_EMAIL, SECOND_EVALUATOR_EMAIL, C17_REVIEWER_EMAIL, CONFLICT_REVIEWER_EMAIL, EMBED_SPEAKER_EMAIL, EMBED_NOPROFILE_EMAIL, ROSTER_MEMBER_EMAIL, ROSTER_NEW_EMAIL, ROSTER_FOREIGN_EMAIL, ROSTER_SHARED_EMAIL] } } });

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
    admin: ["maya@greenroom-hq.com", "Maya Chen"],
    evaluator: ["ravi@greenroom-hq.com", "Ravi Patel"],
    evaluatorTwo: [SECOND_EVALUATOR_EMAIL, "Casey Morgan"],
    speaker: ["sofia@greenroom-hq.com", "Sofia Marques"],
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

  // A co-speaker whose profile is fully populated, so the public speaker card
  // can be asserted on real stored bio/headshot rather than on absence.
  const embedSpeaker = await prisma.user.upsert({
    where: { email: EMBED_SPEAKER_EMAIL },
    update: { name: EMBED_SPEAKER_NAME },
    create: { email: EMBED_SPEAKER_EMAIL, name: EMBED_SPEAKER_NAME },
  });
  await prisma.eventMember.upsert({
    where: { eventId_userId: { eventId: EVENT_ID, userId: embedSpeaker.id } },
    update: { role: "SPEAKER" },
    create: { eventId: EVENT_ID, userId: embedSpeaker.id, role: "SPEAKER" },
  });
  await prisma.speakerProfile.upsert({
    where: { userId: embedSpeaker.id },
    update: {
      bio: EMBED_SPEAKER_BIO, company: "Northwind", jobTitle: "Head of Reliability",
      headshotUrl: EMBED_SPEAKER_HEADSHOT,
    },
    create: {
      userId: embedSpeaker.id, bio: EMBED_SPEAKER_BIO, company: "Northwind",
      jobTitle: "Head of Reliability", headshotUrl: EMBED_SPEAKER_HEADSHOT,
    },
  });

  const noProfileSpeaker = await prisma.user.upsert({
    where: { email: EMBED_NOPROFILE_EMAIL },
    update: { name: EMBED_NOPROFILE_NAME },
    create: { email: EMBED_NOPROFILE_EMAIL, name: EMBED_NOPROFILE_NAME },
  });
  await prisma.eventMember.upsert({
    where: { eventId_userId: { eventId: EVENT_ID, userId: noProfileSpeaker.id } },
    update: { role: "SPEAKER" },
    create: { eventId: EVENT_ID, userId: noProfileSpeaker.id, role: "SPEAKER" },
  });
  // No speakerProfile row on purpose — this is the derived-fallback fixture.
  await prisma.speakerProfile.deleteMany({ where: { userId: noProfileSpeaker.id } });

  // SPK-01: a named speaker with a full profile and no session at all. She is
  // deliberately never added to a Session below, so every check that finds her
  // on /admin/speakers is evidence of the widened EventMember read.
  const rosterMember = await prisma.user.upsert({
    where: { email: ROSTER_MEMBER_EMAIL },
    update: { name: ROSTER_MEMBER_NAME },
    create: { email: ROSTER_MEMBER_EMAIL, name: ROSTER_MEMBER_NAME },
  });
  await prisma.eventMember.upsert({
    where: { eventId_userId: { eventId: EVENT_ID, userId: rosterMember.id } },
    update: { role: "SPEAKER" },
    create: { eventId: EVENT_ID, userId: rosterMember.id, role: "SPEAKER" },
  });
  await prisma.speakerProfile.upsert({
    where: { userId: rosterMember.id },
    update: {
      bio: ROSTER_MEMBER_BIO, company: ROSTER_MEMBER_COMPANY,
      jobTitle: "Director of Platform", headshotUrl: ROSTER_MEMBER_HEADSHOT,
    },
    create: {
      userId: rosterMember.id, bio: ROSTER_MEMBER_BIO, company: ROSTER_MEMBER_COMPANY,
      jobTitle: "Director of Platform", headshotUrl: ROSTER_MEMBER_HEADSHOT,
    },
  });

  const sessionA = await prisma.session.create({
    data: {
      eventId: EVENT_ID, title: "Scratch Session A", durationMinutes: 30, format: "Talk",
      description: SESSION_A_DESCRIPTION,
      // The proposal's topic, carried onto the talk. Drives the topic chip that
      // gives an otherwise unlabelled coloured rail some words.
      categoryId: category.id,
      speakers: {
        create: [
          { userId: users.speaker, isPrimary: true },
          { userId: embedSpeaker.id, isPrimary: false },
          { userId: noProfileSpeaker.id, isPrimary: false },
        ],
      },
    },
  });
  const dayKey = new Date(now + 30 * 86400000).toISOString().slice(0, 10);
  await prisma.scheduleSlot.create({
    data: {
      eventId: EVENT_ID, sessionId: sessionA.id, roomId: roomA.id, trackId: track.id,
      startsAt: new Date(`${dayKey}T17:00:00.000Z`), endsAt: new Date(`${dayKey}T17:30:00.000Z`),
    },
  });
  // §5-4 fixture: published, scheduled, and holding the internal provenance
  // note in `description`. Placed on the same day as sessionA so the default
  // (unfiltered) embed render always contains it.
  const sessionP = await prisma.session.create({
    data: {
      eventId: EVENT_ID, title: PROVENANCE_SESSION_TITLE, durationMinutes: 30, format: "Talk",
      description: PROVENANCE_DESCRIPTION,
      speakers: { create: [{ userId: users.speaker, isPrimary: true }] },
    },
  });
  await prisma.scheduleSlot.create({
    data: {
      eventId: EVENT_ID, sessionId: sessionP.id, roomId: roomB.id, trackId: track.id,
      startsAt: new Date(`${dayKey}T18:00:00.000Z`), endsAt: new Date(`${dayKey}T18:30:00.000Z`),
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
    roomA, roomB, track, category, users, dayKey, embedSpeaker, noProfileSpeaker, rosterMember,
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
      await prisma.event.deleteMany({ where: { id: { in: [EVENT_ID, FRESH_EVENT_ID, S20_OTHER_EVENT_ID, S2_OTHER_EVENT_ID, SWITCH_FOREIGN_EVENT_ID] } } });
      await prisma.event.deleteMany({ where: { slug: { startsWith: CREATED_EVENT_SLUG } } });
      await prisma.user.deleteMany({ where: { email: { in: [BLIND_SPEAKER_EMAIL, SECOND_EVALUATOR_EMAIL, C17_REVIEWER_EMAIL, CONFLICT_REVIEWER_EMAIL, EMBED_SPEAKER_EMAIL, EMBED_NOPROFILE_EMAIL, ROSTER_MEMBER_EMAIL, ROSTER_NEW_EMAIL, ROSTER_FOREIGN_EMAIL, ROSTER_SHARED_EMAIL] } } });
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

  // --- GRA2-08 baseline security headers, on real responses -------------------
  // `lib/security-headers.test.ts` pins the POLICY by importing next.config.mjs;
  // only a live response proves Next DELIVERS it, and in particular that the
  // negative-lookahead matcher really does exclude `/embed/*`. That exclusion is
  // load-bearing: `docs/judging/embed-schedule-proof.html` frames
  // `/embed/schedule` from another origin, so a blanket `frame-ancestors 'none'`
  // would silently break the embed feature the product ships.
  // NOTE: this asserts against a build of the current next.config.mjs — the
  // smoke does not rebuild, so a stale `.next` will report the old policy.
  const landingHeaders = (await req("GET", "/", null, null)).headers;
  const adminHeaders = (await req("GET", "/admin/speakers", null, admin)).headers;
  const embedHeaders = (await req("GET", `/embed/schedule?event=${EVENT_ID}`, null, null)).headers;

  for (const [where, headers] of [
    ["/", landingHeaders],
    ["/admin/speakers", adminHeaders],
    ["/embed/schedule", embedHeaders],
  ]) {
    check(`GRA2-08 ${where} sends nosniff`,
      headers.get("x-content-type-options") === "nosniff",
      headers.get("x-content-type-options") ?? "absent");
    check(`GRA2-08 ${where} sends the referrer policy`,
      headers.get("referrer-policy") === "strict-origin-when-cross-origin",
      headers.get("referrer-policy") ?? "absent");
  }
  // The rest of the baseline rule, proven delivered once.
  check("GRA2-08 / sends the permissions policy",
    landingHeaders.get("permissions-policy") === "camera=(), microphone=(), geolocation=()",
    landingHeaders.get("permissions-policy") ?? "absent");
  check("GRA2-08 / sends HSTS for a year including subdomains",
    landingHeaders.get("strict-transport-security") === "max-age=31536000; includeSubDomains",
    landingHeaders.get("strict-transport-security") ?? "absent");

  check("GRA2-08 the admin shell refuses to be framed",
    (adminHeaders.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"),
    adminHeaders.get("content-security-policy") ?? "absent");
  check("GRA2-08 the landing page refuses to be framed",
    (landingHeaders.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"),
    landingHeaders.get("content-security-policy") ?? "absent");
  // Absent is the intent; a permissive value would also be fine. A restrictive
  // one is the regression this check exists to catch.
  const embedCsp = embedHeaders.get("content-security-policy");
  check("GRA2-08 /embed/schedule stays frameable",
    embedCsp === null || /frame-ancestors\s+\*/.test(embedCsp),
    embedCsp ?? "absent");

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

  // --- D-C5-9: minimal admin event creation -------------------------------
  // The landing programme is captured BEFORE anything is created so "unchanged"
  // is a diff against a recorded value, not an assertion about a value we like.
  // `/api/agenda/public` with no `?event=` runs the exact same default-event
  // resolution the landing page and the embeds use, and answers in deterministic
  // JSON — so "unchanged" is a comparison of resolved data, not of rendered
  // markup that could differ for unrelated reasons.
  const defaultAgendaBefore = await req("GET", "/api/agenda/public", null, null);
  const landingBefore = await req("GET", "/", null, null);
  const embedBefore = await req("GET", "/embed/schedule", null, null);

  const settingsPageForCreate = await req("GET", "/admin/settings", null, admin);
  check("D-C5-9 event settings offers the New event affordance",
    settingsPageForCreate.text.includes("New event"), `${settingsPageForCreate.status}`);

  const createdEvent = await req("POST", "/api/admin/events", {
    name: "Scratch Created Event", slug: CREATED_EVENT_SLUG, timezone: "America/Los_Angeles",
    startsOn: "2027-05-12", endsOn: "2027-05-14",
  }, admin);
  const createdEventId = createdEvent.data?.data?.event?.id;
  check("D-C5-9 an ADMIN creates an event with event-local dates",
    createdEvent.status === 201
    && Boolean(createdEventId)
    && createdEvent.data?.data?.event?.slug === CREATED_EVENT_SLUG
    && createdEvent.data?.data?.event?.startsOn === "2027-05-12"
    && createdEvent.data?.data?.event?.endsOn === "2027-05-14",
    `${createdEvent.status} ${JSON.stringify(createdEvent.data?.error ?? createdEvent.data?.data ?? "")}`);

  // One step, not two: the creator's ADMIN membership must already exist. If
  // the transaction were split, this row could be missing and the event would
  // be unreachable with no delete path to clean it up.
  // take 5: the assertion needs "exactly one" — a handful proves or disproves
  // that without materializing whatever the database happens to contain.
  const creatorMembership = createdEventId
    ? await prisma.eventMember.findMany({ where: { eventId: createdEventId }, select: { userId: true, role: true }, orderBy: { userId: "asc" }, take: 5 })
    : [];
  const creatorUser = await prisma.user.findUnique({ where: { email: "maya@greenroom-hq.com" }, select: { id: true } });
  check("D-C5-9 the creator is an ADMIN member of the new event in the same step",
    creatorMembership.length === 1
    && creatorMembership[0].role === "ADMIN"
    && creatorMembership[0].userId === creatorUser?.id,
    JSON.stringify(creatorMembership));

  // "Starts empty" is the ruling's own words: nothing is cloned from the
  // current event, so every surface shows its existing empty state.
  const createdCounts = createdEventId
    ? {
        rooms: await prisma.room.count({ where: { eventId: createdEventId } }),
        forms: await prisma.formConfig.count({ where: { eventId: createdEventId } }),
        categories: await prisma.category.count({ where: { eventId: createdEventId } }),
        sessions: await prisma.session.count({ where: { eventId: createdEventId } }),
      }
    : null;
  check("D-C5-9 the new event starts genuinely empty — nothing is cloned",
    Boolean(createdCounts) && Object.values(createdCounts).every((n) => n === 0),
    JSON.stringify(createdCounts));

  const duplicateSlug = await req("POST", "/api/admin/events", {
    name: "Another Name Entirely", slug: CREATED_EVENT_SLUG, timezone: "UTC",
  }, admin);
  check("D-C5-9 a duplicate web address is refused as a stable 409",
    duplicateSlug.status === 409 && duplicateSlug.data?.error?.code === "EVENT_SLUG_TAKEN",
    `${duplicateSlug.status} ${JSON.stringify(duplicateSlug.data?.error ?? "")}`);

  // 422, not 400: `parseBody` → `fromZod` in lib/api/http.ts answers a body that
  // parses as JSON but violates the schema with VALIDATION_ERROR.
  const invertedDates = await req("POST", "/api/admin/events", {
    name: "Inverted", slug: `${CREATED_EVENT_SLUG}-inverted`, timezone: "UTC",
    startsOn: "2027-05-14", endsOn: "2027-05-12",
  }, admin);
  check("D-C5-9 an inverted date pair is refused with the shared message",
    invertedDates.status === 422
    && invertedDates.data?.error?.code === "VALIDATION_ERROR"
    && /end on or after its start date/i.test(JSON.stringify(invertedDates.data?.error?.fieldErrors ?? "")),
    `${invertedDates.status} ${JSON.stringify(invertedDates.data?.error ?? "")}`);

  const halfDates = await req("POST", "/api/admin/events", {
    name: "Half", slug: `${CREATED_EVENT_SLUG}-half`, timezone: "UTC", startsOn: "2027-05-12",
  }, admin);
  check("D-C5-9 a half-supplied date pair is refused",
    halfDates.status === 422 && halfDates.data?.error?.code === "VALIDATION_ERROR",
    `${halfDates.status} ${JSON.stringify(halfDates.data?.error ?? "")}`);

  const evaluatorCreate = await req("POST", "/api/admin/events", {
    name: "Evaluator Event", slug: `${CREATED_EVENT_SLUG}-evaluator`, timezone: "UTC",
  }, evaluator);
  const speakerCreate = await req("POST", "/api/admin/events", {
    name: "Speaker Event", slug: `${CREATED_EVENT_SLUG}-speaker`, timezone: "UTC",
  }, speaker);
  const anonCreate = await req("POST", "/api/admin/events", {
    name: "Anon Event", slug: `${CREATED_EVENT_SLUG}-anon`, timezone: "UTC",
  }, null);
  check("D-C5-9 event creation is ADMIN-only",
    evaluatorCreate.status === 403 && speakerCreate.status === 403 && anonCreate.status === 401,
    `${evaluatorCreate.status}/${speakerCreate.status}/${anonCreate.status}`);
  const refusedEvents = await prisma.event.count({ where: { slug: { startsWith: `${CREATED_EVENT_SLUG}-` } } });
  check("D-C5-9 every refused creation wrote no event at all", refusedEvents === 0, `${refusedEvents}`);

  // The judged programme must be byte-identical across the create. This is the
  // landmine the ruling names: an empty brand-new event must never displace it.
  const defaultAgendaAfter = await req("GET", "/api/agenda/public", null, null);
  const landingAfter = await req("GET", "/", null, null);
  const embedAfter = await req("GET", "/embed/schedule", null, null);
  check("D-C5-9 the default public programme resolves to the same event and data after a create",
    defaultAgendaAfter.status === defaultAgendaBefore.status
    && defaultAgendaAfter.text === defaultAgendaBefore.text,
    `${defaultAgendaBefore.status}->${defaultAgendaAfter.status} `
    + `${defaultAgendaBefore.text.slice(0, 120)} -> ${defaultAgendaAfter.text.slice(0, 120)}`);
  // The identity itself, stated separately from the payload: whichever event the
  // pin resolved to before the create is the one it resolves to after. The new
  // event has a different slug, so a displacement would show up here.
  check("D-C5-9 the pinned default event is still the one being served",
    defaultAgendaAfter.data?.data?.event?.slug === defaultAgendaBefore.data?.data?.event?.slug
    && defaultAgendaAfter.data?.data?.event?.slug !== CREATED_EVENT_SLUG,
    `before ${JSON.stringify(defaultAgendaBefore.data?.data?.event?.slug ?? defaultAgendaBefore.data?.error?.code ?? null)} `
    + `after ${JSON.stringify(defaultAgendaAfter.data?.data?.event?.slug ?? defaultAgendaAfter.data?.error?.code ?? null)}`);
  check("D-C5-9 the landing page and embed still answer the same way",
    landingAfter.status === landingBefore.status && embedAfter.status === embedBefore.status,
    `landing ${landingBefore.status}->${landingAfter.status}, embed ${embedBefore.status}->${embedAfter.status}`);
  check("D-C5-9 the new event never appears on the public default surfaces",
    !landingAfter.text.includes("Scratch Created Event") && !embedAfter.text.includes("Scratch Created Event"));

  const roadmapLogin = await req("GET", "/login", null, null);
  check("D-C5-9 the login page names self-service sign-up as roadmap",
    roadmapLogin.status === 200
    && /Self-service sign-up is on the roadmap/.test(roadmapLogin.text)
    && /for now organizers provision accounts\./.test(roadmapLogin.text),
    `${roadmapLogin.status}`);

  // ---- D-C5-16 item 1: the event switcher --------------------------------
  //
  // The second event here is the one the D-C5-9 block just created THROUGH THE
  // PRODUCT, so this section proves the whole create-event → switch-into-it
  // chain rather than a hand-planted fixture. The risk class is S1
  // event-scoping: the assertions below are mostly negative — after a switch,
  // none of the first event's data may appear on any surface.
  //
  // Note on the negative assertions: the switcher itself lists EVERY event the
  // caller belongs to, so "Scratch Frontend" legitimately appears in the
  // dropdown after switching away from it. Residue is therefore asserted
  // against the shell's current-event line (`<strong>`) and against the first
  // event's actual DATA, never against the bare event name.
  // A real event this admin has no membership on, so "foreign" can be proven
  // indistinguishable from "does not exist" rather than assumed.
  await prisma.event.create({
    data: { id: SWITCH_FOREIGN_EVENT_ID, name: "Scratch Frontend Switch Boundary", slug: SWITCH_FOREIGN_EVENT_ID, timezone: "UTC" },
  });

  async function switchEvent(eventId, { sess = admin, cookieValue = null, origin = BASE, form = true } = {}) {
    const res = await fetch(`${BASE}/api/auth/switch-event`, {
      method: "POST",
      headers: {
        "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
        ...(origin === null ? {} : { origin }),
        ...(cookieValue ? { cookie: cookieValue } : sess ? { cookie: cookie(sess) } : {}),
      },
      body: form ? new URLSearchParams({ eventId }).toString() : JSON.stringify({ eventId }),
      redirect: "manual",
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    // `getSetCookie()` keeps multiple Set-Cookie headers apart; `.get()` would
    // join them and make "was a session issued" unanswerable.
    const setCookies = typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
    const issued = setCookies.map((value) => value.split(";")[0]).find((value) => value.startsWith("sb_session="));
    return { status: res.status, location: res.headers.get("location") ?? "", data, issued: issued ?? null };
  }

  async function getAs(path, cookieValue) {
    const res = await fetch(BASE + path, { headers: { cookie: cookieValue }, redirect: "manual" });
    return { status: res.status, location: res.headers.get("location") ?? "", text: await res.text() };
  }

  // The switcher is presentation over the caller's own memberships, so it only
  // appears once there is a real choice to make.
  const shellBeforeSwitch = await req("GET", "/admin/settings", null, admin);
  check("D-C5-16 the shell offers a switcher listing the caller's own events",
    /<select[^>]*name="eventId"/.test(shellBeforeSwitch.text)
    && shellBeforeSwitch.text.includes(`value="${EVENT_ID}"`)
    && Boolean(createdEventId) && shellBeforeSwitch.text.includes(`value="${createdEventId}"`)
    // Someone else's event is never offered, however many exist.
    && !shellBeforeSwitch.text.includes(`value="${SWITCH_FOREIGN_EVENT_ID}"`),
    `${shellBeforeSwitch.status}`);

  // Non-vacuous by construction: the membership count is asserted, so this
  // cannot pass because the identity quietly gained or lost an event.
  const soloMemberships = await prisma.eventMember.count({
    where: { user: { email: SECOND_EVALUATOR_EMAIL } },
  });
  const soloShell = await req("GET", "/admin/evaluations", null, evaluatorTwo);
  check("D-C5-16 a single-membership user gets no switcher at all",
    soloMemberships === 1
    && soloShell.status === 200
    && !/name="eventId"/.test(soloShell.text)
    && soloShell.text.includes("<strong>Scratch Frontend</strong>"),
    `memberships=${soloMemberships} status=${soloShell.status}`);

  const switched = await switchEvent(createdEventId ?? "missing");
  check("D-C5-16 switching to an event the caller belongs to re-issues the session",
    switched.status === 303 && switched.location.endsWith("/admin") && Boolean(switched.issued),
    `${switched.status} ${switched.location} cookie=${Boolean(switched.issued)}`);

  const switchedCookie = switched.issued ?? "";
  const dashboardAfter = await getAs("/admin", switchedCookie);
  const agendaAfterSwitch = await getAs("/admin/agenda", switchedCookie);
  const abstractsAfterSwitch = await getAs("/admin/abstracts", switchedCookie);
  check("D-C5-16 every workspace surface re-resolves to the event just switched into",
    dashboardAfter.status === 200
    && dashboardAfter.text.includes("<strong>Scratch Created Event</strong>")
    && dashboardAfter.text.includes("Where Scratch Created Event stands right now")
    && agendaAfterSwitch.text.includes("<strong>Scratch Created Event</strong>")
    && abstractsAfterSwitch.text.includes("<strong>Scratch Created Event</strong>"),
    `${dashboardAfter.status}/${agendaAfterSwitch.status}/${abstractsAfterSwitch.status}`);

  // The S1 assertion this whole section exists for.
  check("D-C5-16 no first-event data survives the switch on any surface",
    !dashboardAfter.text.includes("<strong>Scratch Frontend</strong>")
    && !agendaAfterSwitch.text.includes("<strong>Scratch Frontend</strong>")
    && !agendaAfterSwitch.text.includes("Scratch Session A")
    && !agendaAfterSwitch.text.includes("Scratch Session B")
    && !abstractsAfterSwitch.text.includes("<strong>Scratch Frontend</strong>")
    && !abstractsAfterSwitch.text.includes("Scratch: Agents in Production")
    && !abstractsAfterSwitch.text.includes("Scratch: Accepted Talk")
    && !dashboardAfter.text.includes("Scratch Session A"));

  // A REAL event the caller has no membership on, and an id that is nobody's,
  // must be one refusal — same status, same code, and no cookie from either.
  const foreignSwitch = await switchEvent(SWITCH_FOREIGN_EVENT_ID, { cookieValue: switchedCookie, form: false });
  const forgedSwitch = await switchEvent("scratch-frontend-no-such-event", { cookieValue: switchedCookie, form: false });
  check("D-C5-16 a foreign event id and a forged one are one indistinguishable refusal",
    foreignSwitch.status === 404
    && forgedSwitch.status === 404
    && foreignSwitch.data?.error?.code === "EVENT_NOT_FOUND"
    && forgedSwitch.data?.error?.code === "EVENT_NOT_FOUND"
    && foreignSwitch.data?.error?.message === forgedSwitch.data?.error?.message
    && !foreignSwitch.issued && !forgedSwitch.issued,
    `${foreignSwitch.status}:${foreignSwitch.data?.error?.code} vs ${forgedSwitch.status}:${forgedSwitch.data?.error?.code}`);

  // A refused switch must leave the caller exactly where they were.
  const afterRefusal = await getAs("/admin", switchedCookie);
  check("D-C5-16 a refused switch changes nothing about the current workspace",
    afterRefusal.status === 200 && afterRefusal.text.includes("<strong>Scratch Created Event</strong>"),
    `${afterRefusal.status}`);

  const crossOriginSwitch = await switchEvent(EVENT_ID, { cookieValue: switchedCookie, origin: "https://evil.example", form: false });
  const noOriginSwitch = await switchEvent(EVENT_ID, { cookieValue: switchedCookie, origin: null, form: false });
  const anonSwitch = await switchEvent(EVENT_ID, { sess: null });
  check("D-C5-16 a cross-origin, origin-less or unauthenticated switch is refused without a cookie",
    crossOriginSwitch.status === 403 && crossOriginSwitch.data?.error?.code === "CROSS_ORIGIN_REFUSED"
    && noOriginSwitch.status === 403
    && anonSwitch.status === 303 && anonSwitch.location.endsWith("/login")
    && !crossOriginSwitch.issued && !noOriginSwitch.issued && !anonSwitch.issued,
    `${crossOriginSwitch.status}/${noOriginSwitch.status}/${anonSwitch.status}`);

  // Role is per event, and the landing follows the role held THERE. Ravi is an
  // EVALUATOR on the scratch event; on the created one he is a SPEAKER.
  const raviUser = await prisma.user.findUnique({ where: { email: "ravi@greenroom-hq.com" }, select: { id: true } });
  if (createdEventId && raviUser) {
    await prisma.eventMember.create({ data: { eventId: createdEventId, userId: raviUser.id, role: "SPEAKER" } });
  }
  const raviSwitch = await switchEvent(createdEventId ?? "missing", { sess: evaluator });
  const raviEvaluations = await getAs("/admin/evaluations", raviSwitch.issued ?? "");
  check("D-C5-16 the role resolves per event: the switch lands on that event's role home",
    raviSwitch.status === 303
    && raviSwitch.location.endsWith("/portal")
    && Boolean(raviSwitch.issued)
    // And the authority really moved: the evaluator screen he could open a
    // moment ago now bounces him, because on THIS event he is a speaker.
    && [302, 303, 307].includes(raviEvaluations.status)
    && raviEvaluations.location.includes("/login"),
    `${raviSwitch.status} ${raviSwitch.location} → evaluations ${raviEvaluations.status} ${raviEvaluations.location}`);

  const switchedBack = await switchEvent(EVENT_ID, { cookieValue: switchedCookie });
  const agendaBack = await getAs("/admin/agenda", switchedBack.issued ?? "");
  check("D-C5-16 switching back restores the first event and its data",
    switchedBack.status === 303
    && switchedBack.location.endsWith("/admin")
    && agendaBack.status === 200
    && agendaBack.text.includes("<strong>Scratch Frontend</strong>")
    && agendaBack.text.includes("Scratch Session A")
    && !agendaBack.text.includes("<strong>Scratch Created Event</strong>"),
    `${switchedBack.status} ${switchedBack.location} agenda ${agendaBack.status}`);

  // The obsoleted copy is gone from the surfaces a judge actually reads. (The
  // create dialog's own switch offer renders only after a successful create, so
  // it is pinned at source in lib/services/event-switch-route-contract.test.ts
  // rather than here.)
  const switcherLogin = await req("GET", "/login", null, null);
  check("D-C5-16 the login page no longer frames the product as a single event",
    switcherLogin.status === 200
    && /switch between the events you belong to/i.test(switcherLogin.text)
    && !/switching between events is on the roadmap/i.test(switcherLogin.text),
    `${switcherLogin.status}`);

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

  // --- §5-6: the calendar file says which talk, and on which track ----------
  // A .ics is read entirely outside the product, so anything the file omits is
  // simply unavailable to its reader.
  check("§5-6 the single-session file is still named for its event",
    unfoldIcs(sessionCalendar.text).includes(`X-WR-CALNAME:${ev.name}`),
    "expected X-WR-CALNAME on the single-session export");
  // The server is spawned with APP_URL=REVIEWER_INVITE_APP_URL, so the absolute
  // URL is fully determined here rather than pattern-matched loosely.
  check("§5-6 the VEVENT carries the session's own anchor on the canonical page",
    unfoldIcs(sessionCalendar.text).includes(
      `URL:${REVIEWER_INVITE_APP_URL}/schedule?event=${EVENT_ID}#session-${fx.sessionA.id}`,
    )
    && !unfoldIcs(sessionCalendar.text).includes("/embed/schedule"),
    "expected a per-session /schedule#session-<id> URL");
  check("§5-6 the talk's track reaches the calendar client as CATEGORIES",
    unfoldIcs(sessionCalendar.text).includes(`CATEGORIES:${fx.track.name}`),
    `expected CATEGORIES:${fx.track.name}`);
  // Every VEVENT in the whole-event file gets its own distinct URL, which is
  // the defect: they all used to carry the identical bare embed link.
  const veventUrls = [...unfoldIcs(eventCalendar.text).matchAll(/URL:([^\r\n]+)/g)].map((m) => m[1]);
  check("§5-6 each VEVENT in the full export points at a different talk",
    veventUrls.length > 1 && new Set(veventUrls).size === veventUrls.length,
    `${veventUrls.length} URLs, ${new Set(veventUrls).size} distinct`);

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

  // --- C4 builder: clickable controls, stable option values, built-in rule
  //     sources, and inline server-error surfacing -------------------------
  //
  // The layout half of this is geometry no HTTP harness can measure, so what is
  // asserted is the contract that makes the geometry safe, read back off the
  // stylesheet the running server actually serves — not off the source file.
  const builderSheets = [
    // Next 16 emits page CSS under `static/chunks`, not `static/css`.
    ...new Set([...builderPage.text.matchAll(/href="(\/_next\/static\/[^"]+\.css)"/g)].map((m) => m[1])),
  ];
  const builderCssRaw = (
    await Promise.all(builderSheets.map(async (href) => (await req("GET", href, null, admin)).text))
  ).join("\n");
  // Normalized so the assertion survives whether the build minified or not.
  const builderCss = builderCssRaw.replace(/\s*([{},:;])\s*/g, "$1");
  check("builder page serves its stylesheet", builderSheets.length > 0 && builderCssRaw.length > 0,
    `${builderSheets.length} sheet(s), ${builderCssRaw.length} bytes`);
  check("served CSS keeps the editor column above the sticky preview",
    /\.builder-panel\{[^}]*position:relative/.test(builderCss)
      && /\.builder-panel\{[^}]*z-index:1/.test(builderCss)
      && /\.builder-preview\{[^}]*z-index:0/.test(builderCss),
    "Add field / Required would sit under the preview and lose their clicks");
  check("served CSS lets the switch decoration pass its clicks through to the checkbox",
    /\.switch \.track,\.switch \.thumb\{pointer-events:none\}/.test(builderCss),
    "the Required and blind-review toggles stay mouse-dead otherwise");
  check("served CSS drops the preview before the editor column is squeezed",
    /max-width:1280px/.test(builderCss) && /\.field-editor-head\{[^}]*flex-wrap:wrap/.test(builderCss));
  check("builder markup wraps the rows that used to overflow the column",
    builderPage.text.includes('class="row wrap"'));

  // A rule on a built-in submission question must survive the save and then
  // decide what the renderer shows. The builder's live preview is server
  // rendered on the fields step, so this is `resolveVisibleFields` running for
  // real with the built-in answers folded in — the format picker starts on
  // "Talk", so exactly one of these two questions may appear.
  const builtInLogicPayload = {
    ...createdPayload,
    id: newFormId,
    fields: [
      { key: "audience_level", label: "Audience level", type: "SELECT", required: false, sortOrder: 0,
        options: [{ label: "Beginner", value: "option_1" }, { label: "Advanced", value: "option_2" }] },
      { key: "talk_extra", label: "Smoke shown for a Talk", type: "SHORT_TEXT", required: false, sortOrder: 1,
        conditionalLogic: { match: "all", rules: [{ fieldKey: "format", operator: "equals", value: "Talk" }] } },
      { key: "workshop_extra", label: "Smoke shown for a Workshop", type: "SHORT_TEXT", required: false, sortOrder: 2,
        conditionalLogic: { match: "all", rules: [{ fieldKey: "format", operator: "equals", value: "Workshop" }] } },
    ],
  };
  const builtInSave = await req("POST", "/api/cfp/forms", builtInLogicPayload, admin);
  check("a built-in-source rule round-trips through Save → 200",
    builtInSave.status === 200
      && (builtInSave.data?.data?.fields ?? []).find((f) => f.key === "talk_extra")?.conditionalLogic?.rules?.[0]?.fieldKey === "format",
    `${builtInSave.status} ${JSON.stringify(builtInSave.data?.error ?? "")}`);

  const builderAfterLogic = await req("GET", `/admin/forms/${newFormId}`, null, admin);
  // Scoped to the preview, deliberately. The editor list on the same page
  // renders EVERY question's label unconditionally, and the hydration payload
  // carries them again, so a page-wide substring search can only ever say "the
  // form has this question" — it says nothing about what the preview rendered.
  const previewStart = builderAfterLogic.text.indexOf('class="builder-preview"');
  const previewEnd = builderAfterLogic.text.indexOf("</aside>", previewStart);
  const previewMarkup = previewStart >= 0 && previewEnd > previewStart
    ? builderAfterLogic.text.slice(previewStart, previewEnd)
    : "";
  check("the builder page server-renders its live preview region",
    previewMarkup.includes("Live preview") && previewMarkup.length > 200,
    `start=${previewStart} end=${previewEnd} len=${previewMarkup.length}`);
  // Premise: both questions really are on the saved form, so a question missing
  // from the preview below is the rule hiding it and not a broken fixture.
  const editorMarkup = previewStart >= 0 ? builderAfterLogic.text.slice(0, previewStart) : "";
  check("both conditional questions exist in the builder's editor list",
    editorMarkup.includes("Smoke shown for a Talk") && editorMarkup.includes("Smoke shown for a Workshop"));
  // `preview-<key>` is emitted only by FieldControl under the preview's
  // idPrefix, so it cannot be satisfied by the editor list or the payload.
  check("the live preview renders the field its built-in rule matches",
    previewMarkup.includes('id="preview-talk_extra"') && previewMarkup.includes("Smoke shown for a Talk"),
    "the format picker starts on Talk, so this question must be shown");
  check("the live preview omits the field its built-in rule does not match",
    !previewMarkup.includes('id="preview-workshop_extra"') && !previewMarkup.includes("Smoke shown for a Workshop"),
    "a rule on Session format was ignored, so every conditional field rendered");
  // Every built-in the picker offers must be answerable in the preview, or a
  // rule on it sits at an empty default and the preview disagrees with the
  // public form for exactly that rule (PR #67).
  check("the live preview offers a control for every built-in rule source",
    ["Session title", "Abstract", "Session format", "Topic category", "Speakers added"]
      .every((label) => previewMarkup.includes(label)),
    `missing: ${["Session title", "Abstract", "Session format", "Topic category", "Speakers added"].filter((label) => !previewMarkup.includes(label)).join(", ")}`);
  check("the live preview's category picker is populated from the event's categories",
    previewMarkup.includes(fx.category.name) && !previewMarkup.includes("This event has no categories yet"),
    `expected the seeded category ${fx.category.name} in the preview`);

  // A second, non-format built-in source proves the wiring is general rather
  // than one special-cased key.
  //
  // Coverage boundary, stated rather than papered over: only the *hidden*
  // direction is reachable here. The preview deliberately starts blank like the
  // public form's first paint, so `format` is the only built-in with a
  // non-empty default and therefore the only one that can be in the shown state
  // in server-rendered markup. Driving a category into the matched state needs
  // a click. Both directions for all five built-in sources are covered by the
  // focused gate (`lib/form-logic-builtin.test.ts`, "every built-in source the
  // preview offers drives visibility in both directions"), through the exact
  // call `Preview` makes.
  const categoryLogicPayload = {
    ...builtInLogicPayload,
    fields: [
      builtInLogicPayload.fields[0],
      { key: "category_unset_extra", label: "Smoke shown when no category", type: "SHORT_TEXT", required: false, sortOrder: 1,
        conditionalLogic: { match: "all", rules: [{ fieldKey: "categoryId", operator: "isNotEmpty" }] } },
      { key: "category_set_extra", label: "Smoke shown for the seeded category", type: "SHORT_TEXT", required: false, sortOrder: 2,
        conditionalLogic: { match: "all", rules: [{ fieldKey: "categoryId", operator: "equals", value: fx.category.id }] } },
    ],
  };
  const categorySave = await req("POST", "/api/cfp/forms", categoryLogicPayload, admin);
  check("a categoryId-source rule round-trips through Save → 200",
    categorySave.status === 200
      && (categorySave.data?.data?.fields ?? []).find((f) => f.key === "category_set_extra")?.conditionalLogic?.rules?.[0]?.fieldKey === "categoryId",
    `${categorySave.status} ${JSON.stringify(categorySave.data?.error ?? "")}`);

  const builderAfterCategory = await req("GET", `/admin/forms/${newFormId}`, null, admin);
  const categoryPreviewStart = builderAfterCategory.text.indexOf('class="builder-preview"');
  const categoryPreviewEnd = builderAfterCategory.text.indexOf("</aside>", categoryPreviewStart);
  const categoryPreview = categoryPreviewStart >= 0 && categoryPreviewEnd > categoryPreviewStart
    ? builderAfterCategory.text.slice(categoryPreviewStart, categoryPreviewEnd)
    : "";
  check("the builder page still server-renders its preview region for the category rules",
    categoryPreview.includes("Live preview") && categoryPreview.length > 200,
    `start=${categoryPreviewStart} end=${categoryPreviewEnd} len=${categoryPreview.length}`);
  check("both category-conditional questions exist in the builder's editor list",
    builderAfterCategory.text.slice(0, categoryPreviewStart).includes("Smoke shown when no category")
      && builderAfterCategory.text.slice(0, categoryPreviewStart).includes("Smoke shown for the seeded category"));
  check("the live preview omits both categoryId-conditional questions while no category is chosen",
    !categoryPreview.includes('id="preview-category_unset_extra"')
      && !categoryPreview.includes('id="preview-category_set_extra"'),
    "a rule on Topic category was ignored, so conditional fields rendered with no category chosen");
  // The unconditional question is the control: it proves the preview did render
  // questions here, so the two absences above are the rules and not an empty
  // preview.
  check("the live preview still renders the unconditional question beside them",
    categoryPreview.includes('id="preview-audience_level"'),
    "the preview rendered no questions at all, so the omissions above prove nothing");

  // Publish so the public renderer is reachable, and confirm the rule reaches it.
  const publishForBuiltIn = await req("POST", "/api/cfp/forms", { ...builtInLogicPayload, published: true }, admin);
  check("publishing the built-in-rule form → 200", publishForBuiltIn.status === 200,
    `${publishForBuiltIn.status} ${JSON.stringify(publishForBuiltIn.data?.error ?? "")}`);
  const publicWithBuiltIn = await req("GET", `/cfp/${EVENT_ID}/scratch-new-form`, null, null);
  check("the public form is served the built-in-source rule it has to evaluate",
    publicWithBuiltIn.status === 200 && publicWithBuiltIn.text.includes("format") && publicWithBuiltIn.text.includes("talk_extra"),
    `got ${publicWithBuiltIn.status}`);

  // Relabelling a choice must not move the value answers are stored by.
  const relabelled = await req("POST", "/api/cfp/forms", {
    ...builtInLogicPayload,
    published: true,
    fields: builtInLogicPayload.fields.map((field) =>
      field.key === "audience_level"
        ? { ...field, options: [{ label: "Newcomer", value: "option_1" }, { label: "Experienced", value: "option_2" }] }
        : field,
    ),
  }, admin);
  const relabelledOptions = (relabelled.data?.data?.fields ?? []).find((f) => f.key === "audience_level")?.options ?? [];
  check("relabelling a choice leaves its stored value unchanged",
    relabelled.status === 200
      && relabelledOptions.map((o) => o.value).join(",") === "option_1,option_2"
      && relabelledOptions.map((o) => o.label).join(",") === "Newcomer,Experienced",
    `${relabelled.status} ${JSON.stringify(relabelledOptions)}`);

  // A rule with no value must be refused loudly, scoped to the question that
  // owns it, so the builder can put the message on that question instead of
  // dropping the save on the floor.
  const missingRuleValue = await req("POST", "/api/cfp/forms", {
    ...builtInLogicPayload,
    fields: builtInLogicPayload.fields.map((field) =>
      field.key === "talk_extra"
        ? { ...field, conditionalLogic: { match: "all", rules: [{ fieldKey: "format", operator: "equals", value: "" }] } }
        : field,
    ),
  }, admin);
  check("a rule with no value is refused with a field-scoped 400",
    missingRuleValue.status === 400 && missingRuleValue.data?.error?.code === "FORM_LOGIC_VALUE_MISSING",
    `${missingRuleValue.status} ${missingRuleValue.data?.error?.code ?? "?"}`);
  check("the refusal names the offending question so the builder can render it inline",
    Array.isArray(missingRuleValue.data?.error?.fieldErrors?.talk_extra)
      && missingRuleValue.data.error.fieldErrors.talk_extra.length > 0,
    JSON.stringify(missingRuleValue.data?.error?.fieldErrors ?? {}));

  // Put the fixture back where the rest of this run expects it: this form was
  // created unpublished and only published above to reach the public renderer.
  const unpublishAgain = await req("POST", "/api/cfp/forms", { ...builtInLogicPayload, published: false }, admin);
  check("the built-in-rule form is left unpublished for the rest of the run",
    unpublishAgain.status === 200 && unpublishAgain.data?.data?.published === false,
    `${unpublishAgain.status}`);

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
    // §5-4: this is the attendee-facing summary that must survive acceptance
    // and land on the public programme, so it is distinctive rather than filler.
    abstract: CONVERTED_ABSTRACT_SUMMARY,
    format: "Talk",
    durationMinutes: 30,
    categoryId: fx.category.id,
    speakers: [
      { email: "smoke.speaker@example.com", name: "Smoke Speaker", isPrimary: true },
      // ABS-11: the harness's own fixture wording, left unstated on the primary.
      { email: "smoke.cospeaker@example.com", name: "Smoke Co", isPrimary: false, role: "Co-presenter" },
    ],
    answers: { audience_level: "beginner", learning_objectives: "Three takeaways." },
    intent: "submit",
  }, null);
  check("CFP direct submit remains capability-free → 201", submit.status === 201, `${submit.status} ${JSON.stringify(submit.data?.error ?? "")}`);
  check("T3 the submitted roster reports the stated role and the unstated null",
    submit.data?.data?.speakers?.find((s) => s.email === "smoke.cospeaker@example.com")?.role === "Co-presenter"
    && submit.data?.data?.speakers?.find((s) => s.email === "smoke.speaker@example.com")?.role === null,
    JSON.stringify(submit.data?.data?.speakers));
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

  // T3 / ABS-11: the co-speaker's stated role reaches the organizer, in the
  // table summary and again in the drawer's full roster line.
  check("T3 the abstracts table names the co-speaker's role instead of counting them",
    afterConvert.text.includes("+1 co-speaker: Co-presenter"),
    "expected the role-bearing co-speaker summary");
  const roleDrawer = await req(
    "GET", `/admin/abstracts?abstractId=${encodeURIComponent(convertedAbstractId)}`, null, admin,
  );
  check("T3 the admin drawer's roster line carries the role beside the primary marker",
    roleDrawer.status === 200
    && roleDrawer.text.includes("Smoke Speaker (primary), Smoke Co — Co-presenter"),
    "expected 'Smoke Speaker (primary), Smoke Co — Co-presenter' in the drawer");

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

  // --- §5-4: the accepted proposal's own summary IS the public description ---
  // The whole point of the fix: what the speaker wrote for attendees reaches
  // the programme, instead of an operational note about the row's origin.
  check("§5-4 acceptance carries the proposal's summary onto the confirmed talk",
    (await prisma.session.findUnique({
      where: { id: convertedSessionId }, select: { description: true },
    }))?.description === CONVERTED_ABSTRACT_SUMMARY,
    "expected Session.description to equal the abstract's summary");
  const convertedCard = await req("GET", `/embed/schedule?event=${EVENT_ID}`, null, null);
  check("§5-4 the converted talk's public card shows that summary",
    convertedCard.status === 200
    && convertedCard.text.includes(`session-${convertedSessionId}`)
    && convertedCard.text.includes(CONVERTED_ABSTRACT_SUMMARY.slice(0, 60)),
    "expected the abstract summary on the converted session card");
  const convertedIcs = await req(
    "GET", `/api/comms/calendar?eventId=${EVENT_ID}&sessionId=${convertedSessionId}`, null, null,
  );
  check("§5-4 the converted talk's .ics DESCRIPTION carries that summary, not provenance",
    convertedIcs.status === 200
    && unfoldIcs(convertedIcs.text).includes("DESCRIPTION:Three field-tested tactics")
    && !unfoldIcs(convertedIcs.text).includes(PROVENANCE_DESCRIPTION)
    && !unfoldIcs(convertedIcs.text).includes(PUBLIC_SUMMARY_FALLBACK),
    "expected the real summary in the single-session calendar file");
  // A re-run must reconcile a talk whose description was never carried across,
  // and must not blank one an organizer wrote by hand.
  await prisma.session.update({
    where: { id: convertedSessionId }, data: { description: null },
  });
  const reconvert = await req("POST", "/api/evaluations/convert", {
    abstractId: convertedAbstractId, durationMinutes: 30,
  }, admin);
  check("§5-4 an admin re-run repairs a talk that never got its summary",
    reconvert.status === 200
    && reconvert.data?.data?.summaryReconciled === true
    && (await prisma.session.findUnique({
      where: { id: convertedSessionId }, select: { description: true },
    }))?.description === CONVERTED_ABSTRACT_SUMMARY,
    `${reconvert.status} ${JSON.stringify(reconvert.data?.data ?? {})}`);
  const reconvertAgain = await req("POST", "/api/evaluations/convert", {
    abstractId: convertedAbstractId, durationMinutes: 30,
  }, admin);
  check("§5-4 a second re-run reconciles nothing and writes nothing",
    reconvertAgain.data?.data?.summaryReconciled === false
    && reconvertAgain.data?.data?.topicReconciled === false,
    JSON.stringify(reconvertAgain.data?.data ?? {}));

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
    // The drawer is the only <dialog> on /admin/abstracts (GRA2-06).
    const drawerIndex = html.search(/<dialog\b/i);
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

  // T3: the flag is the admin's safeguard; the publication column is the
  // public one. A declined talk keeps its slot and stops being announced.
  check("T3 declining a confirmed talk unpublishes it",
    (await prisma.session.findUnique({
      where: { id: convertedSessionId }, select: { contentStatus: true },
    }))?.contentStatus === "DRAFT");
  const embedAfterReverse = await req("GET", `/embed/schedule?event=${EVENT_ID}`, null, null);
  check("T3 the declined talk is gone from the public schedule embed",
    embedAfterReverse.status === 200 && !embedAfterReverse.text.includes(`session-${convertedSessionId}`),
    `expected no session-${convertedSessionId} anchor`);
  const apiAfterReverse = await req("GET", `/api/agenda/public?event=${EVENT_ID}`, null, null);
  check("T3 the JSON agenda twin drops it too",
    apiAfterReverse.status === 200
    && !apiAfterReverse.data?.data?.sessions?.some((s) => s.sessionId === convertedSessionId));
  check("T3 unpublishing removed no data: the slot and its speakers survive",
    !!(await prisma.scheduleSlot.findUnique({ where: { sessionId: convertedSessionId } }))
    && (await prisma.sessionSpeaker.count({ where: { sessionId: convertedSessionId } })) > 0);
  const agendaWhileUnpublished = await req("GET", "/admin/agenda", null, admin);
  check("T3 the agenda builder says how many talks are held back, and where to publish them",
    agendaWhileUnpublished.text.includes("unpublished and does not appear on the public agenda")
    && agendaWhileUnpublished.text.includes("List view"),
    "expected the unpublished-count notice on /admin/agenda");

  // Restore ACCEPTED so later checks see the pipeline in its expected state.
  const restore = await req("POST", "/api/evaluations/decisions", {
    abstractId: convertedAbstractId, decision: "ACCEPTED",
  }, admin);
  check("decision can be changed back → 200", restore.status === 200, `got ${restore.status}`);
  check("T3 re-accepting puts the talk back on the public programme",
    (await prisma.session.findUnique({
      where: { id: convertedSessionId }, select: { contentStatus: true },
    }))?.contentStatus === "PUBLISHED");
  const embedAfterRestore = await req("GET", `/embed/schedule?event=${EVENT_ID}`, null, null);
  check("T3 the restored talk is announced again from the same slot",
    embedAfterRestore.text.includes(`session-${convertedSessionId}`));

  // The organizer control itself: an admin may hold a talk back without any
  // decision changing, and put it back.
  const unpublish = await req("PATCH", "/api/agenda/sessions", {
    sessionId: convertedSessionId, contentStatus: "DRAFT",
  }, admin);
  check("T3 an admin can unpublish a talk directly → 200",
    unpublish.status === 200 && unpublish.data?.data?.contentStatus === "DRAFT",
    `${unpublish.status} ${JSON.stringify(unpublish.data?.error ?? "")}`);
  const embedAfterManualUnpublish = await req("GET", `/embed/schedule?event=${EVENT_ID}`, null, null);
  check("T3 the manually unpublished talk leaves the public schedule",
    !embedAfterManualUnpublish.text.includes(`session-${convertedSessionId}`));
  // The embed's own "Add all to calendar" affordance must not hand out what the
  // page just stopped showing.
  const icsAfterManualUnpublish = await req(
    "GET", `/api/comms/calendar?eventId=${EVENT_ID}&sessionId=${convertedSessionId}`, null, null,
  );
  check("T3 the calendar export refuses the unpublished talk",
    icsAfterManualUnpublish.status === 404, icsAfterManualUnpublish.status);
  const speakersAfterManualUnpublish = await req("GET", `/embed/speakers?event=${EVENT_ID}`, null, null);
  check("T3 an unpublished talk is not announced on the public speaker gallery",
    speakersAfterManualUnpublish.status === 200
    && !speakersAfterManualUnpublish.text.includes("Smoke submitted proposal"),
    "expected the unpublished talk's title off the speaker cards");
  const speakerUnpublish = await req("PATCH", "/api/agenda/sessions", {
    sessionId: convertedSessionId, contentStatus: "PUBLISHED",
  }, speaker);
  check("T3 a speaker cannot publish a talk", speakerUnpublish.status === 403, speakerUnpublish.status);
  const republish = await req("PATCH", "/api/agenda/sessions", {
    sessionId: convertedSessionId, contentStatus: "PUBLISHED",
  }, admin);
  check("T3 publishing again restores it → 200",
    republish.status === 200 && republish.data?.data?.contentStatus === "PUBLISHED", republish.status);
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

  // --- D-C5-8 §3.1: review-coverage sort headers --------------------------
  // The sorted ORDER is client state and cannot be exercised over HTTP; the
  // comparators and their round trips live in lib/review-coverage-sort.test.ts.
  // What the served markup does prove is the accessibility contract and the
  // default: a real button in every sortable <th>, and no aria-sort at all
  // before the organizer has chosen a column.
  const coverageHead = (() => {
    const marker = setupPage.text.indexOf("Review coverage");
    if (marker === -1) return "";
    const start = setupPage.text.indexOf("<thead", marker);
    const end = setupPage.text.indexOf("</thead>", marker);
    return start === -1 || end === -1 ? "" : setupPage.text.slice(start, end + "</thead>".length);
  })();
  const coverageHeaderButtons = (coverageHead.match(/<button[^>]*class="sort-header"/g) ?? []).length;
  check("§3.1 all five coverage columns are sortable through a real header button",
    coverageHeaderButtons === 5, `got ${coverageHeaderButtons}`);
  check("§3.1 the coverage headers still name their columns",
    ["Proposal", "Category", "Status", "Reviewers", "Reviews done"]
      .every((label) => coverageHead.includes(label)));
  check("§3.1 an unsorted coverage table claims no aria-sort on any header",
    !coverageHead.includes("aria-sort"), coverageHead.slice(0, 200));
  check("§3.1 every sortable header carries a direction affordance, not colour alone",
    (coverageHead.match(/sort-indicator/g) ?? []).length === 5,
    `${(coverageHead.match(/sort-indicator/g) ?? []).length} indicators`);
  // The sort must not have become a server round trip: the coverage rows are
  // still the server's own order on first paint.
  const coverageBodyTitles = [fx.abstract.title, fx.maybeSetupAbstract.title]
    .map((title) => setupPage.text.indexOf(title))
    .filter((index) => index !== -1);
  check("§3.1 the coverage table renders its rows server-side before any sort",
    coverageBodyTitles.length === 2, `found ${coverageBodyTitles.length} of 2`);
  check("reviewer picker lists a real event evaluator", setupPage.text.includes("Ravi Patel"));
  check("admin-only reviewer setup includes the contact data needed for resends",
    setupPage.text.includes("ravi@greenroom-hq.com"));
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

  // --- D-C5-8 §2: rubric weight bounds are the SAME on client and server ---
  // The round dialog is a client-only <dialog> that never reaches this HTML, so
  // its weight-share line and different-ranges warning are pinned by
  // lib/rubric-weight.test.ts and lib/evaluation-setup.source.test.ts instead.
  // What is provable from here is the half that actually protects stored data:
  // the plans contract enforces the same bounds the dialog shows, so a weight
  // the dialog refuses cannot arrive through the API either.
  const weightPlan = (weight, extra = {}) => ({
    eventId: EVENT_ID,
    name: "Scratch weight-bounds probe",
    ordinal: 90,
    rubric: [{ key: "relevance", label: "Relevance", min: 1, max: 5, weight, ...extra }],
  });
  // 422, not 400: a body that parses as JSON but fails the Zod contract is a
  // validation refusal, and `fromZod` (lib/api/http.ts) maps every one of those
  // to 422 VALIDATION_ERROR. I asserted 400 without checking the repo's own
  // refusal status — the product behaviour was right all along.
  const zeroWeight = await req("POST", "/api/evaluations/plans", weightPlan(0), admin);
  const negativeWeight = await req("POST", "/api/evaluations/plans", weightPlan(-2), admin);
  const overLimitWeight = await req("POST", "/api/evaluations/plans", weightPlan(100.5), admin);
  check("§2.4 a zero or negative criterion weight is refused, never coerced to 1 → 422",
    zeroWeight.status === 422 && zeroWeight.data?.error?.code === "VALIDATION_ERROR"
    && negativeWeight.status === 422 && negativeWeight.data?.error?.code === "VALIDATION_ERROR",
    `zero ${zeroWeight.status} ${JSON.stringify(zeroWeight.data?.error?.code ?? "")}, negative ${negativeWeight.status} ${JSON.stringify(negativeWeight.data?.error?.code ?? "")}`);
  check("§2.4 a weight above the 100 input-safety limit is refused → 422",
    overLimitWeight.status === 422 && overLimitWeight.data?.error?.code === "VALIDATION_ERROR",
    `${overLimitWeight.status} ${JSON.stringify(overLimitWeight.data?.error?.code ?? "")}`);
  const noProbePlan = await prisma.evaluationPlan.count({
    where: { eventId: EVENT_ID, name: "Scratch weight-bounds probe" },
  });
  check("§2.4 no refused weight created a round as a side effect", noProbePlan === 0, `got ${noProbePlan}`);

  // Accepted in the same breath: decimals, and a rubric whose weights total far
  // more than 100. The sum is not a validity target — weights are relative
  // multipliers — so 60 + 55 must save exactly like 1.5 + 1 does.
  const decimalOverHundredTotal = await req("POST", "/api/evaluations/plans", {
    eventId: EVENT_ID,
    name: "Scratch weight-share round",
    ordinal: 91,
    rubric: [
      { key: "relevance", label: "Relevance", min: 1, max: 5, weight: 60 },
      { key: "clarity", label: "Clarity", min: 1, max: 5, weight: 55.5 },
    ],
  }, admin);
  check("§2.2 a rubric totalling well over 100 is valid and saves → 201",
    decimalOverHundredTotal.status === 201, `got ${decimalOverHundredTotal.status}`);
  // §2.3 present-case: differing ranges are a visible WARNING, not a refusal.
  // A round mixing 1-5 and 0-10 must still save, or the warning has quietly
  // become a validation rule and the formula contract has changed.
  const mixedRanges = await req("POST", "/api/evaluations/plans", {
    eventId: EVENT_ID,
    name: "Scratch mixed-range round",
    ordinal: 92,
    rubric: [
      { key: "relevance", label: "Relevance", min: 1, max: 5, weight: 1 },
      { key: "depth", label: "Depth", min: 0, max: 10, weight: 1 },
    ],
  }, admin);
  check("§2.3 differing score ranges warn without blocking the save → 201",
    mixedRanges.status === 201, `got ${mixedRanges.status}`);
  await prisma.evaluationPlan.deleteMany({ where: { eventId: EVENT_ID, ordinal: { in: [91, 92] } } });

  // --- PR #80 Greptile: a legacy over-limit weight is grandfathered --------
  // The row is written straight through Prisma, exactly as a plan authored
  // before the ceiling existed would look. No schema games — this is ordinary
  // data the API can no longer author but must still accept back unchanged.
  const legacyPlan = await prisma.evaluationPlan.create({
    data: {
      eventId: EVENT_ID, name: "Scratch legacy-weight round", ordinal: 93, isBlind: false,
      rubric: [
        { key: "relevance", label: "Relevance", min: 1, max: 5, weight: 150 },
        { key: "clarity", label: "Clarity", min: 1, max: 5, weight: 50 },
      ],
    },
  });
  const legacyRubric = [
    { key: "relevance", label: "Relevance", min: 1, max: 5, weight: 150 },
    { key: "clarity", label: "Clarity", min: 1, max: 5, weight: 50 },
  ];
  const renameLegacy = await req("POST", "/api/evaluations/plans", {
    eventId: EVENT_ID, id: legacyPlan.id, name: "Scratch legacy-weight round (renamed)",
    ordinal: 93, isBlind: false, rubric: legacyRubric,
  }, admin);
  check("legacy: an unrelated edit resubmitting an UNCHANGED over-limit weight saves → 200",
    renameLegacy.status === 200,
    `${renameLegacy.status} ${JSON.stringify(renameLegacy.data?.error ?? "")}`);
  const legacyAfterRename = await prisma.evaluationPlan.findUnique({ where: { id: legacyPlan.id } });
  check("legacy: the established scoring weight is preserved byte-for-byte, not clamped",
    legacyAfterRename?.name === "Scratch legacy-weight round (renamed)"
    && legacyAfterRename?.rubric?.[0]?.weight === 150,
    `name ${legacyAfterRename?.name}, weight ${legacyAfterRename?.rubric?.[0]?.weight}`);
  // Changing that weight, while still above the ceiling, is a NEW choice.
  const nudgeLegacy = await req("POST", "/api/evaluations/plans", {
    eventId: EVENT_ID, id: legacyPlan.id, name: "Scratch legacy-weight round (renamed)",
    ordinal: 93, isBlind: false,
    rubric: [{ ...legacyRubric[0], weight: 149 }, legacyRubric[1]],
  }, admin);
  check("legacy: CHANGING an over-limit weight is still refused → 422",
    nudgeLegacy.status === 422 && nudgeLegacy.data?.error?.code === "VALIDATION_ERROR",
    `${nudgeLegacy.status} ${JSON.stringify(nudgeLegacy.data?.error?.code ?? "")}`);
  // A brand-new criterion has nothing to carry forward.
  const newOverLimit = await req("POST", "/api/evaluations/plans", {
    eventId: EVENT_ID, id: legacyPlan.id, name: "Scratch legacy-weight round (renamed)",
    ordinal: 93, isBlind: false,
    rubric: [...legacyRubric, { key: "freshness", label: "Freshness", min: 1, max: 5, weight: 120 }],
  }, admin);
  check("legacy: a NEW over-limit criterion on the same plan is refused → 422",
    newOverLimit.status === 422, `got ${newOverLimit.status}`);
  const legacyUntouched = await prisma.evaluationPlan.findUnique({ where: { id: legacyPlan.id } });
  check("legacy: no refused edit wrote anything to the plan",
    legacyUntouched?.rubric?.length === 2 && legacyUntouched?.rubric?.[0]?.weight === 150,
    JSON.stringify(legacyUntouched?.rubric ?? "none"));
  // The regression that mattered most: a legacy rubric must stay READABLE, or
  // the round's decision scores silently blank to "No included reviews".
  const legacyDecisionPage = await req(
    "GET", `/admin/abstracts?planId=${encodeURIComponent(legacyPlan.id)}`, null, admin,
  );
  const legacyDecisionText = renderedText(legacyDecisionPage.text) ?? "";
  check("legacy: the round is selectable and its rubric still parses for decision scoring",
    legacyDecisionPage.status === 200
    && legacyDecisionText.includes("Scratch legacy-weight round (renamed)"),
    `${legacyDecisionPage.status}`);
  // And the admin sees a calm note rather than a warning.
  const legacySetupPage = await req("GET", "/admin/evaluations", null, admin);
  const legacySetupText = renderedText(legacySetupPage.text) ?? "";
  check("legacy: the round card explains the kept weight without calling it an error",
    legacySetupText.includes("Relevance (150) was set above the current 100 weight limit")
    && legacySetupText.includes("Scoring is unaffected."));
  await prisma.evaluationPlan.delete({ where: { id: legacyPlan.id } });

  // --- §4-1: the rubric an organizer is reading scores against -------------
  // Written straight through Prisma so the stored name is EXACTLY the shape
  // that produced the §4-5 duplication: "Round N — …", which is what both the
  // demo seed and the New round dialog default to. Ordinal 95 sits in the
  // same disposable range as the weight-bounds probes above and is deleted at
  // the end of this block.
  const boardPlan = await prisma.evaluationPlan.create({
    data: {
      eventId: EVENT_ID, name: "Round 95 — Program Committee", ordinal: 95, isBlind: false,
      rubric: [
        { key: "relevance", label: "Scratch Relevance", min: 1, max: 5, weight: 3 },
        { key: "clarity", label: "Scratch Clarity", min: 1, max: 5, weight: 1 },
      ],
    },
  });
  // §4-3 needs a genuinely withdrawn proposal ON this page. The fixture's own
  // withdrawal happens much later in this script, so the chip would otherwise
  // be asserted against a permanent zero — which is exactly the vacuous check
  // this block exists to avoid. Removed with `boardPlan` at the end so the
  // abstract counts later assertions rely on are left as they were found.
  const boardWithdrawn = await prisma.abstract.create({
    data: {
      eventId: EVENT_ID, formConfigId: fx.form.id, submitterId: fx.users.speaker,
      title: "Scratch: Withdrawn before review", abstract: "Pulled by the speaker.",
      format: "Talk", durationMinutes: 30, categoryId: fx.category.id,
      status: "WITHDRAWN", submittedAt: new Date(),
      speakers: { create: [{ userId: fx.users.speaker, isPrimary: true }] },
    },
  });

  const boardSetupPage = await req("GET", "/admin/evaluations", null, admin);
  const boardSetupText = renderedText(boardSetupPage.text) ?? "";
  check("§4-1 the round card names each rubric criterion, not just how many there are",
    boardSetupPage.status === 200
    && boardSetupText.includes("Scratch Relevance")
    && boardSetupText.includes("Scratch Clarity"),
    `${boardSetupPage.status}`);
  // The SHARE, not the raw weight alone: weights are relative multipliers, so
  // 3 of 4 is the number that answers "how much does this count?".
  check("§4-1 each criterion states its share of the round's total weight",
    boardSetupText.includes("Weight 3 · 75% of rubric weight")
    && boardSetupText.includes("Weight 1 · 25% of rubric weight"),
    boardSetupText.slice(Math.max(0, boardSetupText.indexOf("Scratch Relevance") - 40), boardSetupText.indexOf("Scratch Relevance") + 160));
  // Read-only: the card must not have grown a control that could rewrite a
  // rubric reviewers have already scored against.
  // Ends at the NEXT panel's own heading rather than at a counted `</div>`:
  // over-running into the assign panel would find its checkboxes and fail this
  // check for the wrong reason.
  const boardRoundList = (() => {
    const start = boardSetupPage.text.indexOf('<div class="round-list">');
    if (start === -1) return "";
    const end = boardSetupPage.text.indexOf("Assign proposals to reviewers", start);
    return end === -1 ? boardSetupPage.text.slice(start) : boardSetupPage.text.slice(start, end);
  })();
  check("§4-1 the rubric on the card is read-only — no input, select or form in the round list",
    boardRoundList !== ""
    && !/<input|<select|<textarea|<form/i.test(boardRoundList),
    boardRoundList.slice(0, 200) || "round list not found");

  // --- §4-5: a round's number is printed once, not once per part -----------
  // The exact reported regression was "Round 1 — Round 1 — Program Committee".
  check("§4-5 the round card prints the round number once, never twice",
    boardSetupText.includes("Round 95")
    && boardSetupText.includes("Program Committee")
    && !boardSetupText.includes("Round 95 — Round 95")
    && !boardSetupText.includes("Round 95Round 95"),
    boardSetupText.slice(Math.max(0, boardSetupText.indexOf("Round 95") - 20), boardSetupText.indexOf("Round 95") + 120));
  // Non-vacuity: the assertion above would also pass on a page that never
  // mentioned this round at all, so pin that the composed label is present.
  // Counted in VISIBLE text only: renderedText keeps <script> contents, and the
  // RSC flight payload inside them repeats every rendered string, so a count
  // over it measures Next's serialization, not the page. Presence checks are
  // immune; this is the harness's first occurrence COUNT, so it strips
  // script/style bodies first.
  const boardVisibleText = (boardSetupPage.text ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&[^;]+;/g, "");
  const boardOrdinalHits = (boardVisibleText.match(/Round 95/g) ?? []).length;
  check("§4-5 the round IS on the page — the no-duplication check is not vacuous",
    boardOrdinalHits >= 1 && boardOrdinalHits <= 2, `got ${boardOrdinalHits} visible occurrences`);
  // Same round, the other surface: the abstracts page's decision-round select.
  const boardDecisionPage = await req(
    "GET", `/admin/abstracts?planId=${encodeURIComponent(boardPlan.id)}`, null, admin,
  );
  const boardDecisionText = renderedText(boardDecisionPage.text) ?? "";
  check("§4-5 the decision-round selector composes the same label, once",
    boardDecisionPage.status === 200
    && boardDecisionText.includes("Round 95 — Program Committee")
    && !boardDecisionText.includes("Round 95 — Round 95"),
    `${boardDecisionPage.status}`);

  // --- §4-2: a coverage row is identifiable and reachable ------------------
  const boardCoverageRow = (() => {
    const marker = boardSetupPage.text.indexOf("Review coverage");
    if (marker === -1) return "";
    const titleIndex = boardSetupPage.text.indexOf(fx.abstract.title, marker);
    if (titleIndex === -1) return "";
    const start = boardSetupPage.text.lastIndexOf("<tr", titleIndex);
    const end = boardSetupPage.text.indexOf("</tr>", titleIndex);
    return start === -1 || end === -1 ? "" : boardSetupPage.text.slice(start, end + "</tr>".length);
  })();
  check("§4-2 the coverage row names the proposal's speaker, not only its title",
    renderedText(boardCoverageRow)?.includes("Sofia Marques") === true,
    boardCoverageRow || "coverage row not found");
  // The link is the canonical permalink and carries THIS row's id, so a row
  // linking to the wrong proposal fails rather than passing on "some <a>".
  check("§4-2 the coverage row links into that proposal's own drawer",
    boardCoverageRow.includes(`href="/admin/abstracts?abstract=${fx.abstract.id}"`),
    boardCoverageRow || "coverage row not found");
  // A real anchor, not a row click handler: copy-link and keyboard use must
  // work, and the smoke can only see the anchor.
  check("§4-2 the coverage link is a real anchor rather than a scripted row",
    /<a [^>]*href="\/admin\/abstracts\?abstract=/.test(boardCoverageRow)
    && !/onclick/i.test(boardCoverageRow),
    boardCoverageRow || "coverage row not found");

  // --- §4-4: the permalink resolves server-side on first load --------------
  // No follow-up request and no client JavaScript: the drawer has to be in
  // this very response, or the link is not deep-linkable.
  const boardPermalink = await req(
    "GET", `/admin/abstracts?abstract=${encodeURIComponent(fx.abstract.id)}`, null, admin,
  );
  // GRA2-06: the drawer is a native <dialog>. Only the `open` attribute can be
  // written by the server, so that attribute is what makes the deep-linked
  // drawer readable before any JavaScript runs; `showModal()` upgrades it on
  // hydration. Served JSX keeps camelCase attribute names, so every attribute
  // here is matched case-insensitively.
  const drawerTag = (html) => html.match(/<dialog\b[^>]*>/i)?.[0] ?? "";
  /** The visible heading text `aria-labelledby` actually resolves to, or null. */
  const drawerLabelText = (html) => {
    const id = drawerTag(html).match(/aria-labelledby="([^"]+)"/i)?.[1];
    if (!id) return null;
    const heading = html.match(
      new RegExp(`<h2[^>]*\\sid="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([\\s\\S]*?)</h2>`, "i"),
    );
    return heading ? renderedText(heading[1]) : null;
  };
  check("§4-4 ?abstract=<id> renders that proposal's drawer in the first response",
    boardPermalink.status === 200
    && /\sopen(=""|[\s>])/i.test(drawerTag(boardPermalink.text)),
    `${boardPermalink.status} ${drawerTag(boardPermalink.text) || "no <dialog> in the response"}`);
  // Not merely present: the accessible name must resolve to this proposal's own
  // visible heading, so a dangling aria-labelledby fails rather than passing.
  check("§4-4 the drawer's aria-labelledby resolves to its visible heading",
    drawerLabelText(boardPermalink.text) === fx.abstract.title,
    `${JSON.stringify(drawerLabelText(boardPermalink.text))} vs ${JSON.stringify(fx.abstract.title)}`);
  // The retired pattern must not come back alongside it: a native <dialog> is
  // already a modal dialog to assistive technology.
  check("§4-4 the drawer carries no hand-rolled dialog role or aria-modal",
    !/role="dialog"/i.test(boardPermalink.text) && !/aria-modal/i.test(boardPermalink.text));
  // Control: the same page WITHOUT the parameter must not open a drawer, or
  // the check above proves nothing about the parameter.
  const boardNoParam = await req("GET", "/admin/abstracts", null, admin);
  check("§4-4 the drawer is absent without the parameter — the deep link is what opens it",
    boardNoParam.status === 200 && !hasModal(boardNoParam.text),
    `${boardNoParam.status}`);
  // The original parameter still works: existing links must not have broken.
  const boardLegacyParam = await req(
    "GET", `/admin/abstracts?abstractId=${encodeURIComponent(fx.abstract.id)}`, null, admin,
  );
  check("§4-4 the original ?abstractId= link still opens the same drawer",
    boardLegacyParam.status === 200
    && /\sopen(=""|[\s>])/i.test(drawerTag(boardLegacyParam.text))
    && drawerLabelText(boardLegacyParam.text) === fx.abstract.title,
    `${boardLegacyParam.status}`);
  // Graceful degrade: a made-up id and a syntactically odd one both render the
  // page normally, with no drawer and no error. (The cross-event case needs a
  // real foreign abstract, so it is asserted in the S20 block below, where
  // that fixture already exists.)
  const boardUnknown = await req("GET", "/admin/abstracts?abstract=no-such-proposal", null, admin);
  const boardOddId = await req("GET", "/admin/abstracts?abstract=%20%26planId%3Dx", null, admin);
  check("§4-4 an unknown or malformed id renders the page with no drawer and no error",
    boardUnknown.status === 200 && !hasModal(boardUnknown.text)
    && boardOddId.status === 200 && !hasModal(boardOddId.text),
    `unknown ${boardUnknown.status}, odd ${boardOddId.status}`);
  // The odd id above also proves the encoding holds: `%26planId%3Dx` decodes to
  // `&planId=x`, and it must stay INSIDE the abstract parameter rather than
  // forging a planId — which would 404 the page instead of rendering it.
  check("§4-4 an id carrying query syntax cannot forge another parameter",
    boardOddId.status === 200, `got ${boardOddId.status}, expected the page to render`);

  // --- §4-1b: the decision score says which criterion earned it ------------
  const boardBreakdown = (() => {
    const start = boardPermalink.text.indexOf('<dl class="criterion-breakdown">');
    if (start === -1) return "";
    const end = boardPermalink.text.indexOf("</dl>", start);
    return end === -1 ? "" : boardPermalink.text.slice(start, end + "</dl>".length);
  })();
  const boardBreakdownText = renderedText(boardBreakdown) ?? "";
  check("§4-1 the drawer breaks the single decision score down by criterion",
    boardPermalink.text.includes("Score by criterion")
    && boardBreakdownText.includes("Relevance")
    && boardBreakdownText.includes("Clarity"),
    boardBreakdownText.slice(0, 240) || "criterion breakdown not found");
  check("§4-1 each criterion carries its own weight share beside its score",
    /% of rubric weight/.test(boardBreakdownText),
    boardBreakdownText.slice(0, 240) || "criterion breakdown not found");
  // Blind-review boundary: the breakdown is an aggregate, so no reviewer name
  // may appear inside it however the round is configured.
  check("§4-1 the criterion breakdown carries no reviewer identity",
    !boardBreakdownText.includes("Ravi Patel")
    && !boardBreakdownText.includes("Casey Morgan")
    && !boardBreakdownText.includes("ravi@greenroom-hq.com"),
    boardBreakdownText.slice(0, 240));

  // --- §4-3: every status is reachable by a filter chip --------------------
  // Anchored on each chip's own accessible name rather than on a sliced <div>:
  // the aria-label is unique to the chip group and does not depend on the
  // order the renderer happens to emit attributes in. Matched
  // case-insensitively, since served JSX preserves the attribute names as
  // authored.
  const chipLabel = (label) => new RegExp(`aria-label="${label}: \\d+ loaded proposals"`, "i");
  check("§4-3 the abstracts pipeline offers a Withdrawn chip alongside the others",
    chipLabel("Withdrawn").test(boardNoParam.text),
    boardNoParam.text.includes("Withdrawn") ? "the word appears but not as a counted chip" : "no Withdrawn chip");
  // Non-vacuous in both directions: the new chip must be built exactly like
  // the chips that already worked, so a Withdrawn chip that rendered while the
  // others had regressed would not pass either.
  check("§4-3 the Withdrawn chip is one of the status chips, built like the rest",
    ["All", "Submitted", "Under review", "Maybe", "Accepted", "Declined", "Drafts", "Withdrawn"]
      .every((label) => chipLabel(label).test(boardNoParam.text)),
    ["All", "Submitted", "Under review", "Maybe", "Accepted", "Declined", "Drafts", "Withdrawn"]
      .filter((label) => !chipLabel(label).test(boardNoParam.text)).join(", ") || "none missing");
  // And it isolates something real. Without this the chip could ship reading a
  // permanent zero and every assertion above would still pass.
  const withdrawnOnPage = await prisma.abstract.count({
    where: { eventId: EVENT_ID, status: "WITHDRAWN" },
  });
  check("§4-3 the Withdrawn chip counts real rows, not a permanent zero",
    withdrawnOnPage > 0
    && /aria-label="Withdrawn: [1-9]\d* loaded proposals"/i.test(boardNoParam.text)
    && boardNoParam.text.includes(boardWithdrawn.title),
    `${withdrawnOnPage} withdrawn stored`);

  await prisma.evaluationPlan.delete({ where: { id: boardPlan.id } });
  await prisma.abstract.delete({ where: { id: boardWithdrawn.id } });

  // Role-aware: an evaluator must get the scoring queue, never the setup panel.
  const evaluatorEval = await req("GET", "/admin/evaluations", null, evaluator);
  check("evaluator does NOT see the setup panel",
    !evaluatorEval.text.includes("Assign proposals to reviewers")
    && !evaluatorEval.text.includes("Review coverage")
    && !evaluatorEval.text.includes("ravi@greenroom-hq.com"));

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

  // --- ABS-01: optional round open/close dates ----------------------------
  // Round 1 above was created with no window at all, which is the case that
  // must keep working: the dates are optional on both the schema and the API.
  const datelessRound = await prisma.evaluationPlan.findFirst({
    where: { eventId: FRESH_EVENT_ID, ordinal: 1 },
    select: { startsAt: true, endsAt: true },
  });
  check("a round created without dates is stored with an empty window",
    datelessRound?.startsAt === null && datelessRound?.endsAt === null,
    `startsAt=${datelessRound?.startsAt ?? "missing"} endsAt=${datelessRound?.endsAt ?? "missing"}`);
  check("a dateless round renders no window line at all",
    !freshAfterRound.text.includes("Opens ") && !freshAfterRound.text.includes("Closes "),
    "an unset date must be left absent, not rendered as a placeholder");

  // The scratch fresh event is America/Los_Angeles, so these instants are the
  // exact ones the dialog derives for local 2 Mar 00:00 (PST) and 20 Mar 23:59
  // (PDT, after the spring-forward). The rendered dates must be those local
  // calendar days, not the UTC days the instants fall on.
  const datedRound = await req("POST", "/api/evaluations/plans", {
    eventId: FRESH_EVENT_ID,
    name: "Round 2 — Final panel",
    ordinal: 2,
    isBlind: false,
    startsAt: "2026-03-02T08:00:00.000Z",
    endsAt: "2026-03-21T06:59:00.000Z",
    rubric: [{ key: "relevance", label: "Relevance", min: 1, max: 5, weight: 1.5 }],
  }, freshAdmin);
  check("setup panel can create a round carrying an open/close window → 201",
    datedRound.status === 201,
    `${datedRound.status} ${JSON.stringify(datedRound.data?.error ?? "")}`);

  const freshAfterDatedRound = await req("GET", "/admin/evaluations", null, freshAdmin);
  check("a round created with dates renders them in the event timezone",
    freshAfterDatedRound.text.includes("Opens Mar 2, 2026")
    && freshAfterDatedRound.text.includes("Closes Mar 20, 2026"),
    "expected the event-local calendar days, not the stored UTC days");
  check("the dateless round still renders alongside the dated one",
    freshAfterDatedRound.text.includes("Round 1 — Program Committee")
    && freshAfterDatedRound.text.includes("Round 2 — Final panel"));

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
    && !blindQueue.text.includes("sofia@greenroom-hq.com")
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

  // The judged run's one critical defect: two rounds exist, Ravi's assignments
  // are all in the older Round 1, and the queue used to pin to the highest
  // ordinal — so he saw an empty workspace. He must land on his own work, and
  // the newer round must stay discoverable without hiding anything.
  const olderRoundQueue = await req("GET", "/admin/evaluations", null, evaluator);
  check("evaluator with assignments only in an older round lands on them",
    olderRoundQueue.status === 200
    // The Round metric reflects the *selected* round; the option list below
    // repeats every round's label, so assert the metric, not the label.
    && olderRoundQueue.text.includes("<strong>Round 1</strong>")
    && olderRoundQueue.text.includes("Scratch: Agents in Production")
    && !olderRoundQueue.text.includes("Nothing assigned to you"),
    `status ${olderRoundQueue.status}`);
  check("evaluator round switcher counts every round without widening whose assignments show",
    olderRoundQueue.text.includes("Round 2 — Scratch Round 2 · 0 assigned to you")
    && !olderRoundQueue.text.includes("Scratch: Evaluator Two Only"));
  const newerRoundQueue = await req(
    "GET",
    `/admin/evaluations?planId=${encodeURIComponent(otherPlan.id)}`,
    null,
    evaluator,
  );
  check("an explicitly selected empty round says so and points back at the work",
    newerRoundQueue.status === 200
    && newerRoundQueue.text.includes("<strong>Round 2</strong>")
    && newerRoundQueue.text.includes("Nothing assigned to you in this round")
    && newerRoundQueue.text.includes("Switch to Round 1")
    && !newerRoundQueue.text.includes("Scratch: Agents in Production"),
    `status ${newerRoundQueue.status}`);
  const unknownRoundQueue = await req("GET", "/admin/evaluations?planId=missing-plan", null, evaluator);
  check("unknown evaluator round is a route-level 404", unknownRoundQueue.status === 404,
    `got ${unknownRoundQueue.status}`);

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
  // Several rounds used to render inert "Choose a round" placeholders in the
  // reviews and score columns until an operator picked one. Round 2's single
  // completed 1/1 review weights to 1.00; Round 1's 3.70 must not leak into it.
  const multiplePlanPage = await req("GET", "/admin/abstracts", null, admin);
  const multiplePlanText = renderedText(multiplePlanPage.text) ?? "";
  check("multiple decision rounds default to the newest round with no manual pick",
    multiplePlanText.includes("the newest one is shown")
    && multiplePlanText.includes("1.00")
    && multiplePlanText.includes("1/1 completed reviews included")
    && !multiplePlanText.includes("Choose a round")
    && !multiplePlanText.includes("Choose a decision round")
    && !multiplePlanText.includes("3.70"));
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

  // --- D-C5-8 §3.2: ABS-10 decision-score sort ----------------------------
  // The ordering itself is client state; the comparator, missing-scores-last in
  // both directions and the ties live in lib/decision-score-sort.test.ts. What
  // the served markup proves is the contract around it — that the control is on
  // the score column and only there, that the page still opens unsorted, and
  // that PR #65's newest-round default is untouched by the sort.
  const scoreSortHead = (() => {
    const start = multiplePlanPage.text.indexOf("<thead");
    const end = multiplePlanPage.text.indexOf("</thead>");
    return start === -1 || end === -1 ? "" : multiplePlanPage.text.slice(start, end + "</thead>".length);
  })();
  check("§3.2 exactly one abstracts header is sortable, and it is the decision score",
    (scoreSortHead.match(/<button[^>]*class="sort-header"/g) ?? []).length === 1
    && scoreSortHead.includes("Decision score"),
    `${(scoreSortHead.match(/<button[^>]*class="sort-header"/g) ?? []).length} sortable headers`);
  // Bounded to the review-count <th> itself. The previous end anchor was the
  // string "Decision score", which is the *next* header's button text, so the
  // slice ran through `</th><th scope="col"><button class="sort-header">` and
  // convicted this header of owning the score column's control. Same anchoring
  // bug I had already fixed in lib/abstracts-table.source.test.ts and failed to
  // carry across.
  const reviewCountHeader = (() => {
    const label = scoreSortHead.indexOf("Decision reviews");
    if (label === -1) return "";
    const start = scoreSortHead.lastIndexOf("<th", label);
    const end = scoreSortHead.indexOf("</th>", label);
    return start === -1 || end === -1 ? "" : scoreSortHead.slice(start, end + "</th>".length);
  })();
  check("§3.2 the decision-review count is NOT sortable in this lane",
    reviewCountHeader.includes("Decision reviews") && !reviewCountHeader.includes("<button"),
    reviewCountHeader || "review-count header not found");
  check("§3.2 the abstracts table opens unsorted, with no aria-sort claimed",
    !scoreSortHead.includes("aria-sort"), scoreSortHead.slice(0, 200));
  check("§3.2 sorting does not disturb the newest-round default or the included-review copy",
    multiplePlanText.includes("the newest one is shown")
    && multiplePlanText.includes("only valid, completed reviews from the selected round"));
  // A missing score must still read as an absence, never as a number, on a page
  // whose score column is now sortable.
  check("§3.2 an unscored proposal still reads 'No included reviews', not 0.00",
    partialRoundText.includes("No included reviews") && !partialRoundText.includes("0.00"));
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

  // --- §4-1: the per-criterion breakdown, at the API boundary --------------
  const apiAbstractSummary = apiSummary?.summariesByAbstractId?.[fx.abstract.id];
  const apiCriteria = apiAbstractSummary?.criteria ?? [];
  check("§4-1 the decision summary projects the round's criteria, in stored order",
    apiCriteria.length === 2
    && apiCriteria[0]?.key === "relevance" && apiCriteria[0]?.label === "Relevance"
    && apiCriteria[1]?.key === "clarity" && apiCriteria[1]?.label === "Clarity"
    && apiCriteria[0]?.weight === 1.5 && apiCriteria[1]?.weight === 1,
    JSON.stringify(apiCriteria));
  // The strongest available consistency claim, and it needs no knowledge of
  // the raw scores: because every included review carries every criterion,
  // sum(criterionAverage x weight) / sum(weight) is ALGEBRAICALLY the same
  // number as the weighted average computed per review. If the breakdown were
  // ever gathered over a different set of reviews than the total, these two
  // would diverge — which is exactly the regression worth catching.
  const apiRecomputed = (() => {
    if (apiCriteria.length === 0) return null;
    let numerator = 0;
    let denominator = 0;
    for (const criterion of apiCriteria) {
      if (typeof criterion.average !== "number") return null;
      numerator += criterion.average * criterion.weight;
      denominator += criterion.weight;
    }
    return denominator > 0 ? numerator / denominator : null;
  })();
  check("§4-1 the breakdown reconstructs the decision score exactly — same reviews, same maths",
    apiRecomputed !== null
    && Math.abs(apiRecomputed - apiAbstractSummary.weightedAverage) < 1e-9,
    `recomputed ${apiRecomputed} vs projected ${apiAbstractSummary?.weightedAverage}`);
  check("§4-1 every criterion reports the same review count the total was built from",
    apiCriteria.length > 0
    && apiCriteria.every((criterion) => criterion.reviews === apiAbstractSummary.includedReviews),
    `includedReviews ${apiAbstractSummary?.includedReviews}, per-criterion ${apiCriteria.map((c) => c.reviews).join("/")}`);
  // Blind-review boundary at the serialization layer, not just in the markup.
  check("§4-1 the breakdown carries no evaluator id, name or per-reviewer score",
    !JSON.stringify(apiSummary ?? {}).includes("evaluatorId")
    && !JSON.stringify(apiSummary ?? {}).includes("Ravi Patel")
    && !JSON.stringify(apiSummary ?? {}).includes(fx.users.evaluator)
    && !JSON.stringify(apiSummary ?? {}).includes(fx.users.evaluatorTwo));
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
    // Updated with ABS-10: the notice now scopes sorting too, because a sorted
    // score column must not read as a ranking of every stored proposal.
    && s20PageText.includes("Tabs, search and sorting cover only these loaded proposals")
    && s20PageText.includes("it does not rank every stored proposal")
    && new RegExp(`Total\\s*${s20Total}`).test(s20PageText)
    && new RegExp(`Pending review\\s*${s20Pending}`).test(s20PageText)
    && new RegExp(`Accepted\\s*${s20Accepted}`).test(s20PageText));
  check("S20 keeps an older event-scoped proposal reachable by direct link",
    s20OlderDrawer.status === 200
    && s20OlderDrawer.text.includes(`S20 draft ${String(S20_DRAFT_COUNT - 1).padStart(3, "0")}`)
    && (renderedText(s20OlderDrawer.text) ?? "").includes(`Showing first ${S20_CAP} of ${s20Total} proposals.`));
  const hasSelectedDecisionControls = (html) => hasModal(html)
    || /<button[^>]*>Accept<\/button>/.test(html)
    || /<button[^>]*>Maybe<\/button>/.test(html)
    || /<button[^>]*>Decline<\/button>/.test(html);
  check("S20 omits cross-event and unknown deep-link drawers",
    s20CrossEventDrawer.status === 200
    && s20UnknownDrawer.status === 200
    && !s20CrossEventDrawer.text.includes("S20 cross-event proposal")
    && !hasSelectedDecisionControls(s20CrossEventDrawer.text)
    && !hasSelectedDecisionControls(s20UnknownDrawer.text));
  // §4-4: the canonical `?abstract=` parameter inherits that scoping exactly.
  // A REAL abstract from another event must be indistinguishable from one that
  // never existed — no drawer, no title leak, and a 200 rather than a 404 that
  // would confirm the id is real somewhere (S1 / INV-EVENT-001).
  const s20CrossEventPermalink = await req(
    "GET", `/admin/abstracts?abstract=${encodeURIComponent(s20CrossEventId)}`, null, admin,
  );
  const s20UnknownPermalink = await req("GET", "/admin/abstracts?abstract=s20-missing-proposal", null, admin);
  check("§4-4 a REAL abstract from another event is refused exactly like a missing one",
    s20CrossEventPermalink.status === 200
    && s20UnknownPermalink.status === 200
    && !s20CrossEventPermalink.text.includes("S20 cross-event proposal")
    && !hasSelectedDecisionControls(s20CrossEventPermalink.text)
    && !hasSelectedDecisionControls(s20UnknownPermalink.text),
    `cross-event ${s20CrossEventPermalink.status}, unknown ${s20UnknownPermalink.status}`);
  // Non-vacuity: the same parameter DOES open a drawer for an id in this
  // event, so the two refusals above are the scoping working, not the
  // parameter being ignored.
  const s20OwnPermalink = await req(
    "GET", `/admin/abstracts?abstract=${encodeURIComponent(s20SubmittedId)}`, null, admin,
  );
  check("§4-4 the same parameter DOES open an in-event proposal — the refusals are scoping",
    s20OwnPermalink.status === 200
    && s20OwnPermalink.text.includes("S20 submitted boundary proposal")
    && hasSelectedDecisionControls(s20OwnPermalink.text),
    `${s20OwnPermalink.status}`);
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
  // §5-5: the calls to action point at the canonical pages now, while the
  // panel still advertises the /embed/* URLs an organizer pastes into an iframe.
  check("landing page links both public surfaces prominently",
    landingHtml.includes(`href="/schedule?event=${EVENT_ID}"`)
    && landingHtml.includes(`href="/speakers?event=${EVENT_ID}"`)
    && landingText.includes("View the schedule")
    && landingText.includes("Meet the speakers")
    && landingText.includes("/schedule")
    && landingText.includes("/speakers"));
  check("§5-5 landing page still advertises the embeddable variants",
    landingHtml.includes('href="/embed/schedule"')
    && landingHtml.includes('href="/embed/speakers"')
    && landingText.includes("/embed/schedule")
    && landingText.includes("/embed/speakers"));
  check("landing page names the event and its real programme size",
    landingText.includes("Scratch Frontend") && landingText.includes("Scheduled sessions"));
  // S20: this event is far inside the cap, so the metrics must be exact numbers
  // with no "+" floor and no partial-programme notice. Guards the flag against
  // being inverted, which would qualify every count on every real event.
  check("T3 a small programme's landing metrics are stated exactly, with no floor qualifier",
    !/<strong>\d+\+<\/strong>/.test(landingHtml)
    && !landingText.includes("larger than this page counts at once"),
    "expected exact landing metrics for an event inside the cap");
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
    // B7: organizers land on the dashboard now. Match the exact path so a
    // regression to /admin/forms (or a redirect loop to /) fails loudly.
    && new URL(landingSignedIn.headers.get("location") ?? "/none", BASE).pathname === "/admin",
    `${landingSignedIn.status} ${landingSignedIn.headers.get("location") ?? "none"}`);

  // --- §5-5: the programme is SERVED at /schedule and /speakers -------------
  // The reversal: these used to 307 into /embed/*, so the guessable URL was a
  // frame fragment with no site around it. They are pages now; /embed/* stays
  // the chrome-free variant of the same component tree.
  for (const [path, marker] of [
    ["/schedule", "Scratch Session A"],
    ["/speakers", EMBED_SPEAKER_NAME],
  ]) {
    const page = await reqManual(`${path}?event=${encodeURIComponent(EVENT_ID)}`, null);
    check(`§5-5 ${path} serves the programme itself → 200`,
      page.status === 200 && page.text.includes(marker),
      `${page.status} ${page.location || ""}`);
    check(`§5-5 ${path} carries the standalone site header and its nav`,
      page.text.includes("public-programme-nav")
      && page.text.includes(">Greenroom<")
      && page.text.includes('href="/schedule?event=')
      && page.text.includes('href="/speakers?event='),
      `expected the brand header and both nav links on ${path}`);
    check(`§5-5 ${path} keeps its own links on the canonical surface`,
      !page.text.includes('action="/embed/'),
      `expected no /embed/ form action on ${path}`);
  }
  // ...and the frameable variant is still frameable, with NO standalone header.
  for (const [path, marker] of [
    ["/embed/schedule", "Scratch Session A"],
    ["/embed/speakers", EMBED_SPEAKER_NAME],
  ]) {
    const framed = await reqManual(`${path}?event=${encodeURIComponent(EVENT_ID)}`, null);
    check(`§5-5 ${path} still renders for a host iframe → 200`,
      framed.status === 200 && framed.text.includes(marker), `${framed.status} ${framed.location || ""}`);
    check(`§5-5 ${path} draws no standalone site chrome`,
      !framed.text.includes("public-programme-nav"),
      `expected no site header inside ${path}`);
  }

  for (const [alias, target] of [
    ["/agenda", "/schedule"],
    ["/sessions", "/schedule"],
  ]) {
    const aliasRes = await reqManual(alias, null);
    check(`alias ${alias} → ${target}`,
      aliasRes.status === 307 && aliasRes.location === target,
      `${aliasRes.status} ${aliasRes.location || "none"}`);
  }
  const aliasWithEvent = await reqManual(`/agenda?event=${encodeURIComponent(EVENT_ID)}`, null);
  check("an alias carries an explicit event through the redirect",
    aliasWithEvent.status === 307 && aliasWithEvent.location === `/schedule?event=${EVENT_ID}`,
    `${aliasWithEvent.status} ${aliasWithEvent.location || "none"}`);

  // An unknown ?event= must behave exactly like no ?event= at all. Comparing the
  // rendered <main> of both responses is the strongest form of the assertion:
  // if any single surface (agenda, metrics, CFP panel, embed links, heading)
  // still spoke the unresolved slug, these two would differ. Everything below
  // reads the default programme only.
  const landingMain = (html) => {
    const start = html.indexOf('<main class="landing"');
    if (start === -1) return null;
    const end = html.indexOf("</main>", start);
    return end === -1 ? null : html.slice(start, end + "</main>".length);
  };
  const landingDefault = await fetch(`${BASE}/`, { redirect: "manual" });
  const landingDefaultHtml = await landingDefault.text();
  const landingUnknown = await fetch(`${BASE}/?event=no-such-event-slug`, { redirect: "manual" });
  const landingUnknownHtml = await landingUnknown.text();
  const defaultMain = landingMain(landingDefaultHtml);
  const unknownMain = landingMain(landingUnknownHtml);
  const defaultMainText = renderedText(defaultMain) ?? "";
  check("landing page renders a default programme with no event parameter",
    landingDefault.status === 200 && defaultMain !== null
    && !defaultMainText.includes("No public programme is published yet."),
    `${landingDefault.status} ${defaultMain === null ? "no <main>" : "ok"}`);
  check("an unknown ?event= falls back to the default programme on every surface",
    landingUnknown.status === 200 && unknownMain !== null && unknownMain === defaultMain,
    `${landingUnknown.status} ${unknownMain === defaultMain ? "identical" : "diverged"}`);
  // Scoped to the rendered <main>: Next's inline flight payload echoes the
  // request's searchParams verbatim in the full document, so a whole-document
  // scan would fail on framework request-echo even when no rendered surface
  // speaks the unresolved slug. The byte-identity check above already proves
  // the rendered content matches the no-parameter render exactly.
  check("an unknown ?event= never pairs one event's links with another's CFP panel",
    !(renderedText(unknownMain) ?? "").includes("no-such-event-slug")
    && !(renderedText(unknownMain) ?? "").includes("No public programme is published yet."));

  // --- embed enrichment (eval EMB-01 / defects 12, 13, 18) ------------------
  // The judged failure was that descriptions and formats existed in the data
  // and rendered on no public surface. Everything here is asserted against the
  // served markup with no JavaScript executed, because that is the contract:
  // the schedule embed is server-rendered and its controls are links and a GET
  // form.
  const embedScheduleUrl = (query = "") => `/embed/schedule?event=${EVENT_ID}${query}`;
  const enriched = await req("GET", embedScheduleUrl(), null, null);
  check("embed schedule still renders for an anonymous visitor", enriched.status === 200, `got ${enriched.status}`);

  check("embed session card renders the stored description",
    enriched.text.includes(SESSION_A_DESCRIPTION.slice(0, 60)));
  check("embed ships the full description in the collapsed markup",
    enriched.text.includes(SESSION_A_DESCRIPTION.slice(-50)));

  // --- §5-4: internal provenance text never reaches a public byte -----------
  // The judged defect: every public session card and every .ics DESCRIPTION
  // printed an operational note about where the row came from. The scratch
  // fixture holds one session whose description IS that exact note.
  check("§5-4 the provenance-described talk is still on the public schedule",
    enriched.text.includes(PROVENANCE_SESSION_TITLE), "expected the fixture card to render");
  check("§5-4 the internal provenance note appears nowhere in the schedule embed",
    !enriched.text.includes(PROVENANCE_DESCRIPTION),
    "provenance text reached a public byte");
  check("§5-4 a talk with no publishable summary says so honestly instead",
    enriched.text.includes(PUBLIC_SUMMARY_FALLBACK),
    "expected the honest fallback copy on the provenance card");
  // The JSON twin is the same projection and must agree.
  const publicAgendaJson = await req("GET", `/api/agenda/public?event=${EVENT_ID}`, null, null);
  const provenanceRow = (publicAgendaJson.data?.data?.sessions ?? [])
    .find((s) => s.title === PROVENANCE_SESSION_TITLE);
  check("§5-4 the JSON agenda twin nulls the provenance note rather than publishing it",
    publicAgendaJson.status === 200 && !!provenanceRow && provenanceRow.description === null,
    JSON.stringify(provenanceRow?.description ?? "row missing"));
  check("§5-4 no provenance sentence survives anywhere in the JSON agenda",
    !publicAgendaJson.text.includes(PROVENANCE_DESCRIPTION)
    && !publicAgendaJson.text.includes("Invited keynote (guaranteed session, no source abstract)."));
  // ...and so must the calendar file, which keeps speaking after download.
  const provenanceIcs = await req(
    "GET", `/api/comms/calendar?eventId=${EVENT_ID}`, null, null,
  );
  check("§5-4 the .ics export carries the honest fallback, never the provenance note",
    provenanceIcs.status === 200
    && !unfoldIcs(provenanceIcs.text).includes(PROVENANCE_DESCRIPTION)
    && unfoldIcs(provenanceIcs.text).includes(`DESCRIPTION:${PUBLIC_SUMMARY_FALLBACK.replace(/,/g, "\\,")}`),
    "expected the fallback DESCRIPTION and no provenance text in the calendar file");
  check("embed offers a Show more affordance",
    enriched.text.includes("Show more") && enriched.text.includes("embed-session-preview"));
  check("session detail expands with native details, not a JS-only modal",
    enriched.text.includes('<details class="embed-session-detail">')
    && !hasModal(enriched.text));

  const chipText = (kind) => renderedText(
    enriched.text.match(new RegExp(`<li class="embed-chip embed-chip-${kind}"[^>]*>([\\s\\S]*?)</li>`))?.[1] ?? "",
  ) ?? "";
  check("embed renders a format chip", chipText("format").includes("Talk"), chipText("format"));
  check("embed renders a track chip", chipText("track").includes("Mainstage"), chipText("track"));
  check("embed renders a room chip", chipText("room").includes("Hall A"), chipText("room"));
  check("T3 embed renders the session's topic as its own chip",
    chipText("topic").includes(fx.category.name), chipText("topic"));
  check("T3 the topic chip is announced as a topic, never as a track",
    chipText("topic").startsWith("Topic:") && !chipText("topic").includes("Track"),
    chipText("topic"));
  check("T3 the expanded detail names the topic separately from the track",
    enriched.text.includes("<dt>Topic</dt>") && enriched.text.includes("<dt>Track</dt>"));

  // Day tabs come from Event.startsAt..endsAt, unioned with any day that holds
  // a placed session outside that range.
  //
  // Read the event LIVE rather than from `fx`: this script's own settings tests
  // above PATCH the scratch event's dates to 2032-05-12..14 and its timezone to
  // America/Denver, so the creation-time values are stale by the time these
  // checks run. The whole point of the feature is that the tabs track the
  // event's real range, so the assertion has to read that range the same way.
  const liveEvent = await prisma.event.findUniqueOrThrow({
    where: { id: EVENT_ID },
    select: { startsAt: true, endsAt: true, timezone: true },
  });
  const liveTz = liveEvent.timezone;
  const dayKeyIn = (value) => new Intl.DateTimeFormat("en-CA", {
    timeZone: liveTz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(value));
  // Calendar arithmetic on the key itself (noon UTC), so a DST transition
  // inside the range cannot duplicate or skip a day.
  const addDayKey = (key, days) => {
    const date = new Date(`${key}T12:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  const rangeDays = [];
  if (liveEvent.startsAt) {
    const endKey = dayKeyIn(liveEvent.endsAt ?? liveEvent.startsAt);
    let cursor = dayKeyIn(liveEvent.startsAt);
    for (let i = 0; i < 31 && cursor <= endKey; i += 1) {
      rangeDays.push(cursor);
      cursor = addDayKey(cursor, 1);
    }
  }
  const placedSlots = await prisma.scheduleSlot.findMany({
    // `endsAt` as well as `startsAt`: the §5-2 note below is derived from every
    // instant the page labels, exactly as the page derives it.
    where: { eventId: EVENT_ID }, select: { startsAt: true, endsAt: true },
  });
  const sessionDays = [...new Set(placedSlots.map((slot) => dayKeyIn(slot.startsAt)))];
  const expectedDays = [...new Set([...rangeDays, ...sessionDays])].sort();
  const renderedDays = [...new Set(
    [...enriched.text.matchAll(/href="\/embed\/schedule\?[^"]*day=(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]),
  )].sort();
  check("day tabs cover the event date range unioned with any out-of-range session day",
    renderedDays.length === expectedDays.length && expectedDays.every((day) => renderedDays.includes(day)),
    `expected ${expectedDays.join(",")} got ${renderedDays.join(",")}`);
  check("the schedule exposes a day filter landmark", enriched.text.includes('aria-label="Filter by day"'));

  // The property under test needs an event day that holds nothing. Assert the
  // premise rather than assuming it, so this cannot pass vacuously if a future
  // fixture change places a session on every day of the range.
  const emptyDay = rangeDays.find((day) => !sessionDays.includes(day));
  check("the fixture leaves at least one event day empty",
    Boolean(emptyDay), `range ${rangeDays.join(",")} sessions ${sessionDays.join(",")}`);
  check("an event day with no sessions still renders a tab with a zero count",
    enriched.text.includes('<span class="embed-tab-count">(0)</span>'));

  const emptyDayPage = await req("GET", embedScheduleUrl(`&day=${emptyDay}`), null, null);
  check("selecting an empty event day is reachable and explains itself",
    emptyDayPage.status === 200 && (renderedText(emptyDayPage.text) ?? "").includes("Nothing scheduled on"),
    `${emptyDayPage.status} day=${emptyDay}`);

  // Header date summary: the judged defect was "18 sessions · May 12, 2026" for
  // a multi-day listing. Intl separates a range with THIN SPACE (U+2009).
  const expectedRange = new Intl.DateTimeFormat("en-US", {
    timeZone: liveTz, month: "short", day: "numeric", year: "numeric",
  }).formatRange(new Date(liveEvent.startsAt), new Date(liveEvent.endsAt ?? liveEvent.startsAt));
  const enrichedText = renderedText(enriched.text) ?? "";
  check("embed header shows the real event date range, not just the first day",
    enrichedText.includes(expectedRange) && expectedRange.includes("–"),
    `expected ${expectedRange}`);

  // --- §5-2: public times name the clock they are on ------------------------
  // Derived here the way the page derives it, over the same instants, rather
  // than pinned to one branch. The fixture's two-day window is DST-uniform for
  // most of the year, but `now + 30d .. now + 32d` straddles the November
  // transition when the harness runs in early October — and on those days the
  // zone-name form is the CORRECT output, not a failure. Pinning the
  // abbreviation would have turned a right answer into a red gate once a year.
  const zoneAbbrevAt = (value) => new Intl.DateTimeFormat("en-US", { timeZone: liveTz, timeZoneName: "short" })
    .formatToParts(new Date(value))
    .find((p) => p.type === "timeZoneName")?.value;
  const programmeInstants = [
    liveEvent.startsAt,
    liveEvent.endsAt,
    ...placedSlots.flatMap((slot) => [slot.startsAt, slot.endsAt]),
  ].filter(Boolean);
  const zoneAbbrevs = [...new Set(programmeInstants.map(zoneAbbrevAt))];
  const expectedNote = zoneAbbrevs.length === 1
    ? `All times ${zoneAbbrevs[0]}`
    : `All times in ${liveTz}`;
  // A card always carries a bare abbreviation at its OWN instant, whichever
  // branch the header note took.
  const cardZonePattern = new RegExp(`\\d:\\d\\d\\s?(?:AM|PM)\\s(?:${zoneAbbrevs.join("|")})`);

  check("§5-2 the schedule header names the clock every time is printed in",
    enrichedText.includes(expectedNote),
    `expected "${expectedNote}" in the header (abbrevs seen: ${zoneAbbrevs.join(",")})`);
  check("§5-2 the session card's time range carries the timezone abbreviation",
    cardZonePattern.test(enrichedText),
    `expected a "…AM ${zoneAbbrevs[0]}" time range on a card`);
  const speakersZone = await req("GET", `/embed/speakers?event=${EVENT_ID}`, null, null);
  const speakersZoneText = renderedText(speakersZone.text) ?? "";
  check("§5-2 the speaker gallery names the same clock in its header and its lines",
    speakersZone.status === 200
    && speakersZoneText.includes(expectedNote)
    && cardZonePattern.test(speakersZoneText),
    `expected "${expectedNote}" on the speaker gallery`);
  // The contradiction Greptile caught: whatever the header says, it must never
  // assert a single abbreviation while a card on the same page shows another.
  //
  // Extraction anchors on the markup's own structure. The shared `renderedText`
  // drops tags with NO separator — many assertions depend on that exact
  // behaviour, so it is left alone — which fuses adjacent text nodes:
  // `…MDT</span><span class="sr-only">Format: ` collapses to "MDTFormat", and a
  // bare uppercase run then swallows the next word's first letter ("MDTF"), as
  // does `…MDT</dd>` before `<dt>Room</dt>` ("MDTR"). Turning every tag
  // boundary into a space restores the word boundary the abbreviation needs;
  // the negative lookahead then makes an overcapture impossible rather than
  // merely unlikely.
  const spacedText = (html) => (html ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[^;]+;/g, " ");
  // Both surfaces: the gallery's placement line ends "· Redwood Hall", so its
  // abbreviation sits mid-text-node and a closing-tag anchor would miss it.
  const abbrevsIn = (html) => [...spacedText(html)
    .matchAll(/\d{1,2}:\d{2}\s*(?:AM|PM)\s+([A-Z]{2,5})(?![A-Za-z])/g)].map((m) => m[1]);
  const shownAbbrevs = [...new Set([...abbrevsIn(enriched.text), ...abbrevsIn(speakersZone.text)])];
  check("§5-2 the header note never claims one zone while a card shows another",
    // Non-vacuity first: a stricter pattern that matched nothing would satisfy
    // the consistency clause below while proving nothing at all.
    shownAbbrevs.length >= 1
    && (shownAbbrevs.length === 1 || expectedNote === `All times in ${liveTz}`),
    shownAbbrevs.length === 0
      ? "no card time-range abbreviation could be extracted from either surface"
      : `cards showed ${shownAbbrevs.join(",")} under note "${expectedNote}"`);

  // Search: a GET form, so the query lives in the URL and needs no hydration.
  check("embed search is a GET form",
    enriched.text.includes('method="get"') && enriched.text.includes('action="/embed/schedule"'));
  const searchHit = await req("GET", embedScheduleUrl("&q=Scratch+Session+A"), null, null);
  check("search keeps a matching session", searchHit.text.includes("Scratch Session A"));
  const searchSpeaker = await req("GET", `${embedScheduleUrl("&q=")}${encodeURIComponent(EMBED_SPEAKER_NAME)}`, null, null);
  check("search matches on speaker name", searchSpeaker.text.includes("Scratch Session A"));
  const searchMiss = await req("GET", embedScheduleUrl("&q=zzz-no-such-session"), null, null);
  const searchMissText = renderedText(searchMiss.text) ?? "";
  check("search narrows the listing and reports the narrowing",
    searchMiss.status === 200
    && !searchMissText.includes("Scratch Session A")
    && searchMissText.includes("0 sessions of")
    && searchMissText.includes("No sessions match"),
    `${searchMiss.status}`);

  // An unknown filter value must degrade to the full listing, never 404 or
  // render an empty page a host site would embed as a broken widget.
  const badFilters = await req("GET", embedScheduleUrl("&day=1999-01-01&track=no-such-track"), null, null);
  check("unknown day and track values fall back to the full schedule",
    badFilters.status === 200 && badFilters.text.includes("Scratch Session A"), `got ${badFilters.status}`);

  // --- speaker cards (defect 18) --------------------------------------------
  const speakersEmbed = await req("GET", `/embed/speakers?event=${EVENT_ID}`, null, null);
  check("speaker embed renders for an anonymous visitor", speakersEmbed.status === 200, `got ${speakersEmbed.status}`);
  check("speaker card renders the stored bio", speakersEmbed.text.includes(EMBED_SPEAKER_BIO.slice(0, 60)));
  check("speaker card renders the headshot as a real image with alt text",
    speakersEmbed.text.includes(EMBED_SPEAKER_HEADSHOT)
    && speakersEmbed.text.includes(`alt="Headshot of ${EMBED_SPEAKER_NAME}"`));
  check("speaker card renders the stored role and company",
    speakersEmbed.text.includes("Head of Reliability") && speakersEmbed.text.includes("Northwind"));
  check("speaker card lists the speaker's session with its room",
    speakersEmbed.text.includes("Scratch Session A") && speakersEmbed.text.includes("Hall A"));
  check("speaker session line carries a placement, not just a title",
    speakersEmbed.text.includes("speaker-session-when"));

  // --- §5-3: the session <-> speaker round trip ------------------------------
  // Derived here the way the pages derive it, then walked in both directions.
  // A fragment that does not exist fails silently in a browser, so the anchor
  // is asserted present on the target rather than inferred from the link.
  const anchorSlug = (name) => name
    .normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const embedSpeakerAnchor = `speaker-${anchorSlug(EMBED_SPEAKER_NAME)}`;
  check("§5-3 the speaker card carries the anchor a session card links to",
    speakersEmbed.text.includes(`id="${embedSpeakerAnchor}"`),
    `expected id="${embedSpeakerAnchor}" on the gallery`);
  check("§5-3 the session card links each speaker name into the directory",
    enriched.text.includes(`/embed/speakers?event=${EVENT_ID}#${embedSpeakerAnchor}`),
    `expected a #${embedSpeakerAnchor} link on the schedule embed`);
  check("§5-3 the schedule embed offers a header link to the speaker directory",
    enriched.text.includes(`href="/embed/speakers?event=${EVENT_ID}"`)
    && (renderedText(enriched.text) ?? "").includes("Speakers"));
  check("§5-3 the speaker gallery offers the return link to the schedule",
    speakersEmbed.text.includes(`href="/embed/schedule?event=${EVENT_ID}"`)
    && (renderedText(speakersEmbed.text) ?? "").includes("Schedule"));
  // ...and the speaker -> session direction still lands on a real anchor.
  check("§5-3 a speaker's session link targets an anchor the schedule renders",
    speakersEmbed.text.includes(`/embed/schedule?event=${EVENT_ID}#session-${fx.sessionA.id}`)
    && enriched.text.includes(`id="session-${fx.sessionA.id}"`),
    "expected the session anchor round trip to close");
  // Both surfaces link within themselves: a framed reader is never navigated
  // onto the standalone site, and a canonical reader never into the frame.
  const canonicalSchedule = await req("GET", `/schedule?event=${EVENT_ID}`, null, null);
  check("§5-3 the canonical schedule cross-links to the canonical directory",
    canonicalSchedule.status === 200
    && canonicalSchedule.text.includes(`/speakers?event=${EVENT_ID}#${embedSpeakerAnchor}`)
    && !canonicalSchedule.text.includes(`/embed/speakers?event=${EVENT_ID}#`),
    "expected canonical-to-canonical speaker links");
  check("speaker detail opens with native details, not a JS-only modal",
    speakersEmbed.text.includes('<details class="speaker-detail">')
    && speakersEmbed.text.includes("Full profile")
    && !hasModal(speakersEmbed.text));
  // The derived-fallback case needs a speaker with genuinely no SpeakerProfile.
  // That cannot be one of the demo users: `lib/demo/seed.ts` upserts a global
  // profile (a distinct fictional title and company per speaker) for every demo
  // speaker, and the row is keyed by userId so the event-scoped wipe never
  // touches it.
  // Confirm the premise against the DB, then assert the rendered line.
  const noProfileRow = await prisma.speakerProfile.findUnique({
    where: { userId: fx.noProfileSpeaker.id }, select: { userId: true },
  });
  check("the derived-fallback fixture speaker really has no stored profile",
    noProfileRow === null, noProfileRow ? "a SpeakerProfile exists" : "none");

  const liveTrackName = (await prisma.scheduleSlot.findFirstOrThrow({
    where: { eventId: EVENT_ID, sessionId: fx.sessionA.id }, select: { track: { select: { name: true } } },
  })).track?.name ?? "";
  const speakersText = renderedText(speakersEmbed.text) ?? "";
  const expectedDerived = `1 session · ${liveTrackName}`;
  const renderedNoProfileLine = speakersEmbed.text
    .match(/<p class="speaker-metadata">([\s\S]*?)<\/p>/g)
    ?.map((block) => renderedText(block))
    .join(" | ") ?? "none";
  check("a speaker with no stored profile gets a derived line, not filler",
    speakersText.includes(expectedDerived),
    `expected "${expectedDerived}"; metadata lines rendered: ${renderedNoProfileLine}`);
  // The complementary half: a stored profile must still win over the fallback.
  check("a speaker with a stored profile shows it instead of the derived line",
    speakersText.includes("Head of Reliability at Northwind"),
    renderedNoProfileLine);

  // --- no admin-only data on any public embed --------------------------------
  // Scanned over the whole document, flight payload included: the speaker
  // gallery is a client island, so its props are serialized into the response.
  // The category NAME ("Applied AI") left this list when Session.categoryId
  // made topics deliberately public via the embed's topic chip; the category's
  // admin-only defaultTeamKey ("team-ai") must still never appear.
  const embedLeaks = [
    "sofia@greenroom-hq.com", "maya@greenroom-hq.com", "ravi@greenroom-hq.com",
    EMBED_SPEAKER_EMAIL, EMBED_NOPROFILE_EMAIL,
    "UNDER_REVIEW", "Scratch: Agents in Production", "Scratch: Maybe historical coverage",
    "Scratch Session B", "team-ai",
  ];
  for (const [label, html] of [["schedule", enriched.text], ["speakers", speakersEmbed.text]]) {
    const found = embedLeaks.filter((needle) => html.includes(needle));
    check(`no admin-only data in the ${label} embed response`, found.length === 0, found.join(" | ") || "none");
  }

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

  // --- ABS-12: an evaluator declares a conflict of interest ----------------
  // Its own abstract and assignment, created here rather than reusing a queue
  // row whose counts an earlier section already asserted.
  const conflictAbstract = await prisma.abstract.create({
    data: {
      eventId: EVENT_ID, formConfigId: fx.form.id, submitterId: fx.users.speaker,
      title: "Scratch: Conflict of interest", abstract: "A proposal from a close colleague.",
      format: "Talk", durationMinutes: 30, categoryId: fx.category.id,
      status: "UNDER_REVIEW", submittedAt: new Date(),
      speakers: { create: [{ userId: fx.users.speaker, isPrimary: true }] },
    },
  });
  await prisma.reviewAssignment.create({
    data: {
      planId: fx.plan.id, abstractId: conflictAbstract.id,
      evaluatorId: fx.users.evaluator, teamKey: "team-ai", status: "ASSIGNED",
    },
  });

  // A reviewer holding exactly this one assignment and nothing else. Ravi keeps
  // `setupAbstract` open at this point, so his workspace correctly opens on that
  // still-actionable row rather than the one he declined — which is the whole
  // point of the queue-departure behaviour, and is why the declared-conflict
  // panel cannot be observed on his page. This identity makes the declined row
  // the only row there is, so the panel is the one the page must open on.
  const conflictReviewerUser = await prisma.user.upsert({
    where: { email: CONFLICT_REVIEWER_EMAIL },
    update: { name: "Dana Whitfield" },
    create: { email: CONFLICT_REVIEWER_EMAIL, name: "Dana Whitfield" },
  });
  await prisma.eventMember.upsert({
    where: { eventId_userId: { eventId: EVENT_ID, userId: conflictReviewerUser.id } },
    update: { role: "EVALUATOR" },
    create: { eventId: EVENT_ID, userId: conflictReviewerUser.id, role: "EVALUATOR" },
  });
  await prisma.reviewAssignment.create({
    data: {
      planId: fx.plan.id, abstractId: conflictAbstract.id,
      evaluatorId: conflictReviewerUser.id, teamKey: "team-ai", status: "ASSIGNED",
    },
  });
  const conflictReviewer = {
    user: { id: "x", name: "Dana Whitfield", email: CONFLICT_REVIEWER_EMAIL },
    event: ev,
    role: "EVALUATOR",
  };

  // The queue size the reviewer is measured against, before and after.
  const queueDenominator = (html) => {
    const match = /(\d+) of (\d+) reviewable proposal/.exec(renderedText(html) ?? "");
    return match ? Number(match[2]) : null;
  };
  const conflictBefore = await req("GET", "/admin/evaluations", null, evaluator);
  const denominatorBefore = queueDenominator(conflictBefore.text);
  check("the new assignment counts towards the reviewer's queue before the declaration",
    conflictBefore.status === 200 && denominatorBefore !== null
    && conflictBefore.text.includes("Scratch: Conflict of interest"),
    `denominator=${denominatorBefore}`);
  check("an open assignment offers the declare-a-conflict control",
    conflictBefore.text.includes("Declare a conflict"));

  // The reviewer's finished work on another proposal, captured to prove the
  // declaration leaves it exactly as it was.
  const completedBefore = await prisma.reviewAssignment.findUnique({
    where: {
      planId_abstractId_evaluatorId: {
        planId: fx.plan.id, abstractId: fx.abstract.id, evaluatorId: fx.users.evaluator,
      },
    },
    select: { status: true, completedAt: true },
  });
  const scoresBefore = await prisma.reviewScore.count({
    where: { planId: fx.plan.id, abstractId: fx.abstract.id, evaluatorId: fx.users.evaluator },
  });

  const declare = await req("POST", "/api/evaluations/assignments/decline", {
    planId: fx.plan.id, abstractId: conflictAbstract.id,
  }, evaluator);
  check("an evaluator can declare a conflict on their own assignment → 200",
    declare.status === 200 && declare.data?.data?.status === "DECLINED",
    `${declare.status} ${JSON.stringify(declare.data?.error ?? declare.data?.data ?? "")}`);

  const declaredRow = await prisma.reviewAssignment.findUnique({
    where: {
      planId_abstractId_evaluatorId: {
        planId: fx.plan.id, abstractId: conflictAbstract.id, evaluatorId: fx.users.evaluator,
      },
    },
    select: { status: true },
  });
  check("the declaration writes the existing DECLINED assignment status",
    declaredRow?.status === "DECLINED", declaredRow?.status ?? "missing");

  const conflictAfter = await req("GET", "/admin/evaluations", null, evaluator);
  const denominatorAfter = queueDenominator(conflictAfter.text);
  check("the declined assignment leaves the reviewer's active queue",
    denominatorAfter !== null && denominatorBefore !== null
    && denominatorAfter === denominatorBefore - 1,
    `before=${denominatorBefore} after=${denominatorAfter}`);
  // What a *fresh* load of the declaring reviewer's page must show. It cannot
  // show the declared-conflict panel: the row left the active queue, so the
  // workspace opens on Ravi's still-open assignment instead. Asserting the
  // panel here would contradict the queue-departure check directly above it.
  check("the declined row stays listed and is named a conflict, not a bare status",
    conflictAfter.text.includes("Scratch: Conflict of interest")
    && conflictAfter.text.includes("Conflict declared"),
    `listed=${conflictAfter.text.includes("Scratch: Conflict of interest")} `
    + `named=${conflictAfter.text.includes("Conflict declared")}`);
  check("a fresh load opens on still-open work, not on the row just declined",
    !renderedText(conflictAfter.text).includes("You declared a conflict of interest")
    && conflictAfter.text.includes("Declare a conflict"),
    "the open row must be the one the workspace lands on, and it still offers the control");

  // The honest completed state itself, on the one page that can render it: a
  // reviewer whose only assignment is the one they just declined.
  const soleDeclare = await req("POST", "/api/evaluations/assignments/decline", {
    planId: fx.plan.id, abstractId: conflictAbstract.id,
  }, conflictReviewer);
  check("a second reviewer declares a conflict on the same proposal → 200",
    soleDeclare.status === 200 && soleDeclare.data?.data?.status === "DECLINED",
    `${soleDeclare.status} ${JSON.stringify(soleDeclare.data?.error ?? soleDeclare.data?.data ?? "")}`);
  const solePage = await req("GET", "/admin/evaluations", null, conflictReviewer);
  const solePageText = renderedText(solePage.text) ?? "";
  check("the declined row reports an honest completed state when it is the open row",
    solePage.status === 200
    && solePageText.includes("You declared a conflict of interest")
    && solePageText.includes("no score of yours counts towards its decision"),
    `status ${solePage.status}; panel copy ${solePageText.includes("You declared a conflict of interest")}`);
  check("the declared-conflict panel withholds the scoring form it cannot honour",
    !solePage.text.includes("Submit review")
    && !solePage.text.includes("Score every criterion")
    && !solePage.text.includes("Declare a conflict"),
    "a declined row must offer neither scoring nor a second declaration");
  check("a reviewer whose only assignment is declined has no reviewable work left",
    solePageText.includes("No reviewable proposals remain"),
    solePageText.includes("reviewable proposal") ? "a denominator still rendered" : "none");

  // --- ABS-12 integrity: a declaration survives a score write --------------
  // Greptile #1. Before the fix the score route checked the abstract's status
  // but never the assignment's, so this request would have moved the DECLINED
  // row straight to COMPLETED and its scores would have counted for a decision.
  const scoreAfterDecline = await req("POST", "/api/evaluations/scores", {
    planId: fx.plan.id,
    abstractId: conflictAbstract.id,
    scores: [{ rubricKey: "relevance", score: 5 }, { rubricKey: "clarity", score: 5 }],
    complete: true,
  }, conflictReviewer);
  check("a declared conflict refuses a score write with a stable code → 409",
    scoreAfterDecline.status === 409
    && scoreAfterDecline.data?.error?.code === "ASSIGNMENT_DECLINED",
    `${scoreAfterDecline.status} ${scoreAfterDecline.data?.error?.code ?? "none"}`);
  const declinedStillDeclined = await prisma.reviewAssignment.findUnique({
    where: {
      planId_abstractId_evaluatorId: {
        planId: fx.plan.id, abstractId: conflictAbstract.id, evaluatorId: conflictReviewerUser.id,
      },
    },
    select: { status: true, completedAt: true },
  });
  const refusedScoreRows = await prisma.reviewScore.count({
    where: {
      planId: fx.plan.id, abstractId: conflictAbstract.id, evaluatorId: conflictReviewerUser.id,
    },
  });
  check("the refused score write left the declaration and the scores untouched",
    declinedStillDeclined?.status === "DECLINED"
    && declinedStillDeclined?.completedAt === null
    && refusedScoreRows === 0,
    `status=${declinedStillDeclined?.status} completedAt=${declinedStillDeclined?.completedAt} scoreRows=${refusedScoreRows}`);

  // --- ABS-12 restoration: an explicit re-assignment brings the row back ----
  // Greptile #2. A completed review on a second proposal rides along in the
  // same admin call, to prove the reset is status-scoped and not blanket.
  const restoreControlAbstract = await prisma.abstract.create({
    data: {
      eventId: EVENT_ID, formConfigId: fx.form.id, submitterId: fx.users.speaker,
      title: "Scratch: Restoration control", abstract: "Reviewed and finished.",
      format: "Talk", durationMinutes: 30, categoryId: fx.category.id,
      status: "UNDER_REVIEW", submittedAt: new Date(),
      speakers: { create: [{ userId: fx.users.speaker, isPrimary: true }] },
    },
  });
  await prisma.reviewAssignment.create({
    data: {
      planId: fx.plan.id, abstractId: restoreControlAbstract.id,
      evaluatorId: conflictReviewerUser.id, teamKey: "team-ai", status: "ASSIGNED",
    },
  });
  const controlScore = await req("POST", "/api/evaluations/scores", {
    planId: fx.plan.id,
    abstractId: restoreControlAbstract.id,
    scores: [{ rubricKey: "relevance", score: 4 }, { rubricKey: "clarity", score: 4 }],
    complete: true,
  }, conflictReviewer);
  check("the restoration control review is submitted → 200", controlScore.status === 200,
    `${controlScore.status} ${JSON.stringify(controlScore.data?.error ?? "")}`);
  const controlBefore = await prisma.reviewAssignment.findUnique({
    where: {
      planId_abstractId_evaluatorId: {
        planId: fx.plan.id, abstractId: restoreControlAbstract.id, evaluatorId: conflictReviewerUser.id,
      },
    },
    select: { status: true, completedAt: true },
  });
  const controlScoresBefore = await prisma.reviewScore.count({
    where: {
      planId: fx.plan.id, abstractId: restoreControlAbstract.id, evaluatorId: conflictReviewerUser.id,
    },
  });

  const reassign = await req("POST", "/api/evaluations/assignments", {
    planId: fx.plan.id,
    abstractIds: [conflictAbstract.id, restoreControlAbstract.id],
    evaluatorIds: [conflictReviewerUser.id],
  }, admin);
  check("admin re-assignment of a declined proposal → 201", reassign.status === 201,
    `${reassign.status} ${JSON.stringify(reassign.data?.error ?? "")}`);
  const restored = await prisma.reviewAssignment.findUnique({
    where: {
      planId_abstractId_evaluatorId: {
        planId: fx.plan.id, abstractId: conflictAbstract.id, evaluatorId: conflictReviewerUser.id,
      },
    },
    select: { status: true, completedAt: true },
  });
  check("re-assignment restores the declined assignment to ASSIGNED",
    restored?.status === "ASSIGNED" && restored?.completedAt === null,
    `status=${restored?.status} completedAt=${restored?.completedAt}`);
  const controlAfterReassign = await prisma.reviewAssignment.findUnique({
    where: {
      planId_abstractId_evaluatorId: {
        planId: fx.plan.id, abstractId: restoreControlAbstract.id, evaluatorId: conflictReviewerUser.id,
      },
    },
    select: { status: true, completedAt: true },
  });
  const controlScoresAfter = await prisma.reviewScore.count({
    where: {
      planId: fx.plan.id, abstractId: restoreControlAbstract.id, evaluatorId: conflictReviewerUser.id,
    },
  });
  check("re-assignment never disturbs a completed review in the same call",
    controlBefore?.status === "COMPLETED"
    && controlAfterReassign?.status === "COMPLETED"
    && String(controlAfterReassign?.completedAt) === String(controlBefore?.completedAt)
    && controlScoresAfter === controlScoresBefore && controlScoresBefore > 0,
    `status ${controlBefore?.status}→${controlAfterReassign?.status}, `
    + `completedAt ${String(controlBefore?.completedAt)}→${String(controlAfterReassign?.completedAt)}, `
    + `scores ${controlScoresBefore}→${controlScoresAfter}`);

  const restoredPage = await req("GET", "/admin/evaluations", null, conflictReviewer);
  const restoredPageText = renderedText(restoredPage.text) ?? "";
  check("the restored proposal is back in the reviewer's queue and scoreable again",
    restoredPage.text.includes("Submit review")
    && restoredPage.text.includes("Declare a conflict")
    && !restoredPageText.includes("You declared a conflict of interest")
    && restoredPageText.includes("1 of 2 reviewable proposals scored"),
    `panel copy gone=${!restoredPageText.includes("You declared a conflict of interest")}`);
  const rescore = await req("POST", "/api/evaluations/scores", {
    planId: fx.plan.id,
    abstractId: conflictAbstract.id,
    scores: [{ rubricKey: "relevance", score: 3 }, { rubricKey: "clarity", score: 3 }],
    complete: true,
  }, conflictReviewer);
  check("the restored assignment accepts the score write it previously refused → 200",
    rescore.status === 200,
    `${rescore.status} ${scoreAfterDecline.data?.error?.code ?? ""} → ${JSON.stringify(rescore.data?.error ?? "")}`);

  // Nothing about the reviewer's finished review may move.
  const completedAfter = await prisma.reviewAssignment.findUnique({
    where: {
      planId_abstractId_evaluatorId: {
        planId: fx.plan.id, abstractId: fx.abstract.id, evaluatorId: fx.users.evaluator,
      },
    },
    select: { status: true, completedAt: true },
  });
  const scoresAfter = await prisma.reviewScore.count({
    where: { planId: fx.plan.id, abstractId: fx.abstract.id, evaluatorId: fx.users.evaluator },
  });
  check("a completed review elsewhere is untouched by the declaration",
    completedBefore?.status === "COMPLETED"
    && completedAfter?.status === "COMPLETED"
    && String(completedAfter?.completedAt) === String(completedBefore?.completedAt)
    && scoresAfter === scoresBefore && scoresBefore > 0,
    `status ${completedBefore?.status}→${completedAfter?.status}, scores ${scoresBefore}→${scoresAfter}`);

  // The refusals: the same rule the button uses, enforced server-side.
  const declareAgain = await req("POST", "/api/evaluations/assignments/decline", {
    planId: fx.plan.id, abstractId: conflictAbstract.id,
  }, evaluator);
  check("declaring the same conflict twice is refused → 409",
    declareAgain.status === 409 && declareAgain.data?.error?.code === "CONFLICT_ALREADY_DECLARED",
    `${declareAgain.status} ${declareAgain.data?.error?.code ?? "none"}`);

  const declareCompleted = await req("POST", "/api/evaluations/assignments/decline", {
    planId: fx.plan.id, abstractId: fx.abstract.id,
  }, evaluator);
  check("a submitted review cannot be self-declined away → 409",
    declareCompleted.status === 409
    && declareCompleted.data?.error?.code === "REVIEW_ALREADY_SUBMITTED",
    `${declareCompleted.status} ${declareCompleted.data?.error?.code ?? "none"}`);

  const declareUnassigned = await req("POST", "/api/evaluations/assignments/decline", {
    planId: fx.plan.id, abstractId: fx.maybeSetupAbstract.id,
  }, evaluator);
  check("a proposal assigned to somebody else cannot be declined → 403",
    declareUnassigned.status === 403 && declareUnassigned.data?.error?.code === "NOT_ASSIGNED",
    `${declareUnassigned.status} ${declareUnassigned.data?.error?.code ?? "none"}`);

  const declareAsSpeaker = await req("POST", "/api/evaluations/assignments/decline", {
    planId: fx.plan.id, abstractId: conflictAbstract.id,
  }, { user: { id: "x", name: "Sofia Marques", email: "sofia@greenroom-hq.com" }, event: ev, role: "EVALUATOR" });
  check("a speaker cannot reach the decline path even with a forged role claim",
    declareAsSpeaker.status === 401 || declareAsSpeaker.status === 403,
    `got ${declareAsSpeaker.status}`);

  // --- SPK-01 / SPK-02: the speaker roster and the add/edit form ------------
  // The roster is the union of "on a confirmed session" and "named a speaker
  // on this event". Priya is only ever the second, so every check that finds
  // her proves the widened read rather than the old SessionSpeaker one.
  // React's SSR separates adjacent text nodes with `<!-- -->`, so any assertion
  // spanning an interpolation has to read the stripped markup.
  const flat = (html) => html.replace(/<!-- -->/g, "");
  const confirmedCountOf = (html) => {
    const metric = flat(html).match(/Confirmed speakers<\/span><strong>(\d+)<\/strong>/);
    return metric ? Number(metric[1]) : null;
  };
  const awaitingCountOf = (html) => {
    const metric = flat(html).match(/Not on a session yet<\/span><strong>(\d+)<\/strong>/);
    return metric ? Number(metric[1]) : null;
  };

  const roster = await req("GET", "/admin/speakers", null, admin);
  check("speaker roster → 200", roster.status === 200, `got ${roster.status}`);
  check("roster lists a named speaker who is on no session yet",
    roster.text.includes(ROSTER_MEMBER_NAME) && roster.text.includes(ROSTER_MEMBER_EMAIL),
    `name ${roster.text.includes(ROSTER_MEMBER_NAME)}, email ${roster.text.includes(ROSTER_MEMBER_EMAIL)}`);
  check("a session-less speaker is named as awaiting a session, not as an unscheduled one",
    roster.text.includes("Not on a session yet") && roster.text.includes("Awaiting session"));
  check("roster renders a stored headshot as a real image with alt text naming the speaker",
    roster.text.includes(ROSTER_MEMBER_HEADSHOT) && roster.text.includes(`alt="Headshot of ${ROSTER_MEMBER_NAME}"`),
    `src ${roster.text.includes(ROSTER_MEMBER_HEADSHOT)}, alt ${roster.text.includes(`alt="Headshot of ${ROSTER_MEMBER_NAME}"`)}`);
  check("roster renders the stored bio verbatim", roster.text.includes(ROSTER_MEMBER_BIO));
  // The honest-absence half: a speaker with no profile row is told so rather
  // than shown filler, and gets no <img> at all.
  // Theo is asserted present here on purpose: the search checks below prove
  // themselves by his disappearing, which is worthless if he was never listed.
  check("a speaker with no stored bio is listed, told so, and given no image",
    roster.text.includes(EMBED_NOPROFILE_NAME)
    && roster.text.includes("No bio stored yet")
    && !roster.text.includes(`alt="Headshot of ${EMBED_NOPROFILE_NAME}"`),
    `listed ${roster.text.includes(EMBED_NOPROFILE_NAME)}, told ${roster.text.includes("No bio stored yet")}`);

  // PR #72 regression guard: widening the roster must not restate the
  // confirmed-speaker metric, nor the number the checklist fans out to (C33).
  const confirmedBefore = confirmedCountOf(roster.text);
  const awaitingBefore = awaitingCountOf(roster.text);
  const fanOutBefore = flat(roster.text).match(/assigned to all\s*(\d+) confirmed speaker/);
  check("the roster still reports a confirmed-speaker count and an awaiting count",
    typeof confirmedBefore === "number" && typeof awaitingBefore === "number" && awaitingBefore >= 1,
    `confirmed ${confirmedBefore}, awaiting ${awaitingBefore}`);
  check("the onboarding checklist still fans out to the confirmed cohort, not the whole roster",
    fanOutBefore !== null && Number(fanOutBefore[1]) === confirmedBefore,
    `checklist ${fanOutBefore?.[1] ?? "none"} vs confirmed ${confirmedBefore}`);
  check("due-date columns and task metrics from the task manager still render",
    roster.text.includes("Onboarding checklist") && roster.text.includes("Next required due"));

  // Search is a real server-rendered GET form, so it must narrow the server's
  // own HTML — not merely hide rows in the browser.
  const searchByName = await req("GET", "/admin/speakers?q=Priya", null, admin);
  check("search narrows the roster to the matching speaker",
    searchByName.status === 200
    && searchByName.text.includes(ROSTER_MEMBER_NAME)
    && !searchByName.text.includes(EMBED_NOPROFILE_NAME),
    `${searchByName.status}, priya ${searchByName.text.includes(ROSTER_MEMBER_NAME)}, theo ${searchByName.text.includes(EMBED_NOPROFILE_NAME)}`);
  const searchByCompany = await req("GET", "/admin/speakers?q=Lumen", null, admin);
  check("search matches a stored company, not only a name",
    searchByCompany.text.includes(ROSTER_MEMBER_NAME) && !searchByCompany.text.includes(EMBED_NOPROFILE_NAME));
  const rosterSearchMiss = await req("GET", "/admin/speakers?q=zzzznobody", null, admin);
  check("a search that matches nobody says so instead of showing an empty filter",
    rosterSearchMiss.text.includes("No speakers match this search") && !rosterSearchMiss.text.includes(ROSTER_MEMBER_NAME));
  check("the search box is a real GET form the page reads server-side",
    roster.text.includes('method="get"') && roster.text.includes('action="/admin/speakers"') && roster.text.includes('name="q"'));
  const searchWithFilter = await req("GET", "/admin/speakers?filter=unscheduled&q=Priya", null, admin);
  check("submitting a search keeps the active filter instead of dropping it",
    searchWithFilter.text.includes('type="hidden" name="filter" value="unscheduled"'));
  check("a filter link carries the active search instead of discarding it",
    searchByName.text.includes('href="/admin/speakers?filter=unscheduled&amp;q=Priya"'));

  // SPK-02: provisioning. Nothing below seeds a row directly.
  const addSpeaker = await req("POST", "/api/admin/speakers", {
    email: ROSTER_NEW_EMAIL, name: ROSTER_NEW_NAME,
    jobTitle: "Programme Lead", company: "Beacon Works",
  }, admin);
  check("adding a speaker creates the account and the membership → 201",
    addSpeaker.status === 201
    && addSpeaker.data?.data?.userCreated === true
    && addSpeaker.data?.data?.membershipCreated === true,
    `${addSpeaker.status} ${JSON.stringify(addSpeaker.data?.data ?? addSpeaker.data?.error ?? "none")}`);
  check("a brand-new speaker belongs to this event alone, so their profile is stored",
    addSpeaker.data?.data?.profileRequested === true
    && addSpeaker.data?.data?.profileApplied === true
    && addSpeaker.data?.data?.sharedAcrossEvents === false,
    JSON.stringify(addSpeaker.data?.data ?? "none"));
  const afterAdd = await req("GET", "/admin/speakers", null, admin);
  check("the added speaker appears on the roster immediately",
    afterAdd.text.includes(ROSTER_NEW_NAME) && afterAdd.text.includes(ROSTER_NEW_EMAIL));
  check("adding a session-less speaker moves the awaiting count, never the confirmed one",
    confirmedCountOf(afterAdd.text) === confirmedBefore && awaitingCountOf(afterAdd.text) === awaitingBefore + 1,
    `confirmed ${confirmedCountOf(afterAdd.text)} (was ${confirmedBefore}), awaiting ${awaitingCountOf(afterAdd.text)} (was ${awaitingBefore})`);

  // C17: the same email again is a reuse, not a duplicate, and the typed name
  // must not overwrite the name the account already carries.
  const addAgain = await req("POST", "/api/admin/speakers", {
    email: ROSTER_NEW_EMAIL, name: "Marcus B. Bell-Renamed",
  }, admin);
  check("re-adding the same speaker is idempotent → 200, nothing created",
    addAgain.status === 200
    && addAgain.data?.data?.userCreated === false
    && addAgain.data?.data?.membershipCreated === false,
    `${addAgain.status} ${JSON.stringify(addAgain.data?.data ?? addAgain.data?.error ?? "none")}`);
  check("the reused account keeps its own global name in the response",
    addAgain.data?.data?.speaker?.name === ROSTER_NEW_NAME,
    `got ${addAgain.data?.data?.speaker?.name ?? "none"}`);
  const storedUser = await prisma.user.findUnique({ where: { email: ROSTER_NEW_EMAIL }, select: { id: true, name: true } });
  check("the stored global name was never overwritten by the second add",
    storedUser?.name === ROSTER_NEW_NAME, `stored ${storedUser?.name ?? "none"}`);
  const membershipCount = await prisma.eventMember.count({ where: { eventId: EVENT_ID, userId: storedUser?.id ?? "none" } });
  check("re-adding did not duplicate the event membership", membershipCount === 1, `got ${membershipCount}`);

  const addAdmin = await req("POST", "/api/admin/speakers", {
    email: "maya@greenroom-hq.com", name: "Maya Chen",
  }, admin);
  check("someone who already holds another role is refused, not silently demoted → 409",
    addAdmin.status === 409 && addAdmin.data?.error?.code === "SPEAKER_ROLE_CONFLICT",
    `${addAdmin.status} ${addAdmin.data?.error?.code ?? "none"}`);
  const stillAdmin = await prisma.eventMember.findUnique({
    where: { eventId_userId: { eventId: EVENT_ID, userId: fx.users.admin } },
    select: { role: true },
  });
  check("the refused add left the organizer's role untouched", stillAdmin?.role === "ADMIN", `got ${stillAdmin?.role ?? "none"}`);

  const addBadEmail = await req("POST", "/api/admin/speakers", { email: "not-an-email", name: "X" }, admin);
  check("an unusable email is a field-scoped validation refusal",
    addBadEmail.status === 422 && Boolean(addBadEmail.data?.error?.fieldErrors?.email),
    `${addBadEmail.status} ${JSON.stringify(addBadEmail.data?.error?.fieldErrors ?? "none")}`);

  // SPK-02: editing, with the portal's own C13 null semantics.
  const editProfile = await req("PATCH", "/api/admin/speakers", {
    userId: fx.rosterMember.id,
    bio: "Priya now leads the reliability guild and mentors on-call engineers.",
    company: "Lumen Grid",
    headshotUrl: "https://images.example.test/priya-raman-2.jpg",
  }, admin);
  check("editing a speaker profile round-trips the stored values → 200",
    editProfile.status === 200
    && editProfile.data?.data?.profile?.company === "Lumen Grid"
    && editProfile.data?.data?.profile?.headshotUrl === "https://images.example.test/priya-raman-2.jpg"
    && editProfile.data?.data?.profile?.bio?.startsWith("Priya now leads"),
    `${editProfile.status} ${JSON.stringify(editProfile.data?.data?.profile ?? editProfile.data?.error ?? "none")}`);
  check("the edit left the job title alone because the patch never mentioned it",
    editProfile.data?.data?.profile?.jobTitle === "Director of Platform",
    `got ${editProfile.data?.data?.profile?.jobTitle ?? "none"}`);
  const afterEdit = await req("GET", "/admin/speakers", null, admin);
  check("the roster shows the edited bio and headshot on the next load",
    afterEdit.text.includes("Priya now leads the reliability guild")
    && afterEdit.text.includes("https://images.example.test/priya-raman-2.jpg"));

  const clearBio = await req("PATCH", "/api/admin/speakers", { userId: fx.rosterMember.id, bio: null }, admin);
  check("an explicit null clears one field and leaves every omitted one stored (C13)",
    clearBio.status === 200
    && clearBio.data?.data?.profile?.bio === null
    && clearBio.data?.data?.profile?.company === "Lumen Grid"
    && clearBio.data?.data?.profile?.jobTitle === "Director of Platform",
    `${clearBio.status} ${JSON.stringify(clearBio.data?.data?.profile ?? clearBio.data?.error ?? "none")}`);
  const afterClear = await req("GET", "/admin/speakers", null, admin);
  check("the cleared bio is reported as absent rather than left on screen",
    !afterClear.text.includes("Priya now leads the reliability guild") && afterClear.text.includes("No bio stored yet"));

  // T3 / SPK-04: where a speaker is in accepting their invitation.
  const rosterBeforeStatus = await req("GET", "/admin/speakers", null, admin);
  check("T3 an existing speaker is not silently marked unconfirmed by the new column",
    !rosterBeforeStatus.text.includes(">Invited<") && !rosterBeforeStatus.text.includes(">Declined<"),
    "expected no status chip before any status was set");
  const setInvited = await req("PATCH", "/api/admin/speakers", {
    userId: fx.rosterMember.id, status: "INVITED",
  }, admin);
  check("T3 a status-only edit is a real edit → 200",
    setInvited.status === 200 && setInvited.data?.data?.profile?.status === "INVITED",
    `${setInvited.status} ${JSON.stringify(setInvited.data?.data?.profile ?? setInvited.data?.error ?? "none")}`);
  check("T3 setting a status left every stored prose field alone",
    setInvited.data?.data?.profile?.company === "Lumen Grid"
    && setInvited.data?.data?.profile?.jobTitle === "Director of Platform",
    JSON.stringify(setInvited.data?.data?.profile ?? "none"));
  const rosterInvited = await req("GET", "/admin/speakers", null, admin);
  check("T3 the roster renders an Invited chip for that speaker",
    rosterInvited.text.includes(">Invited<"), "expected an Invited status chip");
  const setDeclined = await req("PATCH", "/api/admin/speakers", {
    userId: fx.rosterMember.id, status: "DECLINED",
  }, admin);
  const rosterDeclined = await req("GET", "/admin/speakers", null, admin);
  check("T3 a declined speaker is shown as declined",
    setDeclined.status === 200 && rosterDeclined.text.includes(">Declined<"),
    `${setDeclined.status}`);
  const badStatus = await req("PATCH", "/api/admin/speakers", {
    userId: fx.rosterMember.id, status: "MAYBE",
  }, admin);
  check("T3 a status outside the three known ones is refused",
    badStatus.status === 422, badStatus.status);
  const restoreStatus = await req("PATCH", "/api/admin/speakers", {
    userId: fx.rosterMember.id, status: "CONFIRMED",
  }, admin);
  check("T3 the status can be set back to confirmed",
    restoreStatus.status === 200 && restoreStatus.data?.data?.profile?.status === "CONFIRMED",
    restoreStatus.status);

  const renameAttempt = await req("PATCH", "/api/admin/speakers", { userId: fx.rosterMember.id, name: "Someone Else" }, admin);
  check("an organizer cannot rename a speaker's account through the profile edit",
    renameAttempt.status === 422, `got ${renameAttempt.status}`);
  const reEmailAttempt = await req("PATCH", "/api/admin/speakers", { userId: fx.rosterMember.id, email: "hijack@scratch.test" }, admin);
  check("an organizer cannot re-address a speaker's account through the profile edit",
    reEmailAttempt.status === 422, `got ${reEmailAttempt.status}`);
  const nameUnchanged = await prisma.user.findUnique({ where: { email: ROSTER_MEMBER_EMAIL }, select: { name: true } });
  check("the refused identity edits changed nothing about the account",
    nameUnchanged?.name === ROSTER_MEMBER_NAME, `got ${nameUnchanged?.name ?? "none"}`);

  // One indistinguishable 404 for every id the caller has no business editing.
  const foreignUser = await prisma.user.create({ data: { email: ROSTER_FOREIGN_EMAIL, name: "Foreign Speaker" } });
  await prisma.eventMember.create({ data: { eventId: S20_OTHER_EVENT_ID, userId: foreignUser.id, role: "SPEAKER" } });
  const editForeign = await req("PATCH", "/api/admin/speakers", { userId: foreignUser.id, bio: "should never land" }, admin);
  const editUnknown = await req("PATCH", "/api/admin/speakers", { userId: "user-does-not-exist", bio: "x" }, admin);
  const editReviewer = await req("PATCH", "/api/admin/speakers", { userId: fx.users.evaluator, bio: "x" }, admin);
  check("another event's speaker, an unknown id, and a reviewer are one identical 404",
    [editForeign, editUnknown, editReviewer].every((res) => res.status === 404 && res.data?.error?.code === "SPEAKER_NOT_FOUND"),
    `${editForeign.status}/${editUnknown.status}/${editReviewer.status}`);
  const foreignProfile = await prisma.speakerProfile.findUnique({ where: { userId: foreignUser.id }, select: { bio: true } });
  check("the refused cross-event edit wrote no profile row at all", foreignProfile === null,
    `got ${JSON.stringify(foreignProfile)}`);

  // A SpeakerProfile is one global row per person, read by every public speaker
  // surface. Dana is on this event's roster AND another event's, so writing her
  // profile here would change how she appears on the other event's public page.
  // This event's authority does not reach that far.
  const sharedUser = await prisma.user.create({ data: { email: ROSTER_SHARED_EMAIL, name: ROSTER_SHARED_NAME } });
  await prisma.eventMember.create({ data: { eventId: S20_OTHER_EVENT_ID, userId: sharedUser.id, role: "SPEAKER" } });
  const addShared = await req("POST", "/api/admin/speakers", {
    email: ROSTER_SHARED_EMAIL, name: ROSTER_SHARED_NAME,
    jobTitle: "Head of Content", company: "Two Events Ltd", bio: "should never be stored by this event",
  }, admin);
  check("a speaker shared with another event still joins this one → 201",
    addShared.status === 201 && addShared.data?.data?.membershipCreated === true,
    `${addShared.status} ${JSON.stringify(addShared.data?.data ?? addShared.data?.error ?? "none")}`);
  check("but the profile details typed for a shared speaker are withheld, and said to be",
    addShared.data?.data?.profileRequested === true
    && addShared.data?.data?.profileApplied === false
    && addShared.data?.data?.sharedAcrossEvents === true,
    JSON.stringify(addShared.data?.data ?? "none"));
  const sharedAfterAdd = await prisma.speakerProfile.findUnique({ where: { userId: sharedUser.id }, select: { bio: true } });
  check("adding a shared speaker created no global profile row", sharedAfterAdd === null,
    `got ${JSON.stringify(sharedAfterAdd)}`);

  const editShared = await req("PATCH", "/api/admin/speakers", {
    userId: sharedUser.id, bio: "should never be stored by this event either",
  }, admin);
  check("editing a shared speaker's global profile is refused → 409",
    editShared.status === 409 && editShared.data?.error?.code === "SPEAKER_SHARED_ACROSS_EVENTS",
    `${editShared.status} ${editShared.data?.error?.code ?? "none"}`);
  check("the refusal explains why and names the speaker's own portal as the way forward",
    typeof editShared.data?.error?.message === "string"
    && editShared.data.error.message.includes("another event")
    && editShared.data.error.message.includes("speaker portal"),
    editShared.data?.error?.message ?? "none");
  const sharedAfterEdit = await prisma.speakerProfile.findUnique({ where: { userId: sharedUser.id }, select: { bio: true } });
  check("the refused shared edit wrote no global profile row", sharedAfterEdit === null,
    `got ${JSON.stringify(sharedAfterEdit)}`);
  // T3 / SPK-04: status lives on that same global row, so it refuses identically
  // rather than becoming a back door into a shared speaker's profile.
  const statusShared = await req("PATCH", "/api/admin/speakers", {
    userId: sharedUser.id, status: "CONFIRMED",
  }, admin);
  check("T3 setting a shared speaker's status is refused with the identical 409",
    statusShared.status === 409
    && statusShared.data?.error?.code === "SPEAKER_SHARED_ACROSS_EVENTS"
    && statusShared.data?.error?.message === editShared.data?.error?.message,
    `${statusShared.status} ${statusShared.data?.error?.code ?? "none"}`);
  check("T3 the refused status write created no global profile row either",
    (await prisma.speakerProfile.findUnique({ where: { userId: sharedUser.id } })) === null);
  const addSharedWithStatus = await req("POST", "/api/admin/speakers", {
    email: ROSTER_SHARED_EMAIL, name: ROSTER_SHARED_NAME, status: "CONFIRMED",
  }, admin);
  check("T3 adding a shared speaker withholds their status alongside the rest",
    addSharedWithStatus.status === 200
    && addSharedWithStatus.data?.data?.profileRequested === true
    && addSharedWithStatus.data?.data?.profileApplied === false,
    JSON.stringify(addSharedWithStatus.data?.data ?? "none"));
  // The refusal must be targeted, not a blanket lockout of the edit feature.
  const editExclusive = await req("PATCH", "/api/admin/speakers", {
    userId: fx.rosterMember.id, company: "Lumen Grid Holdings",
  }, admin);
  check("a speaker who belongs to this event alone is still editable",
    editExclusive.status === 200 && editExclusive.data?.data?.profile?.company === "Lumen Grid Holdings",
    `${editExclusive.status} ${JSON.stringify(editExclusive.data?.data?.profile ?? editExclusive.data?.error ?? "none")}`);

  // ADMIN-only, enforced from the persisted membership rather than the cookie.
  const evaluatorAdd = await req("POST", "/api/admin/speakers", { email: "nope@scratch.test", name: "Nope" }, evaluator);
  const evaluatorEdit = await req("PATCH", "/api/admin/speakers", { userId: fx.rosterMember.id, bio: "x" }, evaluator);
  check("a reviewer can neither add nor edit a speaker → 403",
    evaluatorAdd.status === 403 && evaluatorEdit.status === 403,
    `add ${evaluatorAdd.status}, edit ${evaluatorEdit.status}`);
  const forgedAdmin = { user: { id: "x", name: "Sofia Marques", email: "sofia@greenroom-hq.com" }, event: ev, role: "ADMIN" };
  const forgedAdd = await req("POST", "/api/admin/speakers", { email: "nope2@scratch.test", name: "Nope" }, forgedAdmin);
  check("a forged ADMIN claim in the cookie does not grant speaker administration",
    forgedAdd.status === 401 || forgedAdd.status === 403, `got ${forgedAdd.status}`);
  const anonAdd = await req("POST", "/api/admin/speakers", { email: "nope3@scratch.test", name: "Nope" });
  check("an unauthenticated add is refused before any lock is taken → 401",
    anonAdd.status === 401, `got ${anonAdd.status}`);
  const speakerRoster = await reqManual("/admin/speakers", speaker);
  check("a speaker is redirected away from the roster page → 307",
    speakerRoster.status === 307, `got ${speakerRoster.status}`);
  const noSpeakerAdded = await prisma.user.count({ where: { email: { in: ["nope@scratch.test", "nope2@scratch.test", "nope3@scratch.test"] } } });
  check("no refused add created an account as a side effect", noSpeakerAdded === 0, `got ${noSpeakerAdded}`);

  // --- B7: the /admin dashboard -------------------------------------------
  // Every figure below is checked against a Prisma query written HERE, from a
  // different angle than the page's own read (counts and set unions rather than
  // groupBy folds), so a shared bug cannot make both sides agree. Nothing is
  // hardcoded: the scratch fixture has been mutated by the whole run above, and
  // these expectations are computed from the database as it now stands.
  // `<strong>{a} / {b}</strong>` puts two adjacent text children in one element,
  // and React separates those with an empty comment on the server. Stripping
  // comments is what makes "3 / 5" readable as itself rather than as
  // "3<!-- --> / <!-- -->5"; the whitespace collapse below covers formatting.
  const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, "");
  const collapse = (value) => (value === null ? null : value.replace(/\s+/g, " ").trim());
  const dashboardRow = (html, label) =>
    collapse(html.match(new RegExp(`<span class="dashboard-row-label">${label}</span>\\s*<strong>([^<]*)</strong>`))?.[1] ?? null);
  const dashboardFunnel = (html) => {
    const counts = new Map();
    for (const match of html.matchAll(/href="\/admin\/abstracts\?status=([A-Z_]+)"[\s\S]{0,400}?<strong>(\d+)<\/strong>/g)) {
      counts.set(match[1], Number(match[2]));
    }
    return counts;
  };

  const dashPage = await req("GET", "/admin", null, admin);
  check("B7 the admin dashboard renders → 200", dashPage.status === 200, `got ${dashPage.status}`);
  const dashHtml = stripComments(dashPage.text);

  // 1. CFP funnel — every segment against an independent groupBy.
  const funnelExpected = new Map(
    (await prisma.abstract.groupBy({
      by: ["status"], where: { eventId: EVENT_ID }, _count: { _all: true },
    })).map((row) => [row.status, row._count._all]),
  );
  const funnelRendered = dashboardFunnel(dashHtml);
  const funnelTotal = [...funnelExpected.values()].reduce((sum, n) => sum + n, 0);
  check("B7 the funnel is not vacuous — the scratch event really has proposals",
    funnelTotal > 0 && funnelRendered.size === 7,
    `db total ${funnelTotal}, rendered segments ${funnelRendered.size}`);
  const funnelMismatch = [...funnelRendered.entries()]
    .filter(([status, shown]) => shown !== (funnelExpected.get(status) ?? 0))
    .map(([status, shown]) => `${status}: page ${shown} vs db ${funnelExpected.get(status) ?? 0}`);
  check("B7 every funnel segment matches an independently counted status",
    funnelMismatch.length === 0, funnelMismatch.join("; "));
  const funnelMissing = [...funnelExpected.entries()]
    .filter(([status, n]) => n > 0 && !funnelRendered.has(status))
    .map(([status]) => status);
  check("B7 no status with stored proposals is missing a funnel segment",
    funnelMissing.length === 0, funnelMissing.join(", "));

  // 2. The segment links land on the chip they counted, and that chip is
  //    pressed in the FIRST response — not after client JavaScript runs.
  // Attribute-order independent on purpose: the chip's accessible name already
  // carries its label, and asserting on a fixed attribute order would make this
  // check about React's serializer rather than about which chip is pressed.
  const pressedChipName = (html) => {
    for (const tag of stripComments(html).match(/<button[^>]*>/g) ?? []) {
      if (!/\saria-pressed="true"/.test(tag)) continue;
      const label = tag.match(/\saria-label="([^:"]+):/)?.[1];
      if (label) return label;
    }
    return null;
  };
  const acceptedSegment = await req("GET", "/admin/abstracts?status=ACCEPTED", null, admin);
  check("B7 a funnel link opens the abstracts table with its own chip preselected",
    acceptedSegment.status === 200 && pressedChipName(acceptedSegment.text) === "Accepted",
    `${acceptedSegment.status}, pressed ${pressedChipName(acceptedSegment.text) ?? "none"}`);
  const withdrawnSegment = await req("GET", "/admin/abstracts?status=WITHDRAWN", null, admin);
  check("B7 a second segment presses its own chip, not a fixed one",
    withdrawnSegment.status === 200 && pressedChipName(withdrawnSegment.text) === "Withdrawn",
    `pressed ${pressedChipName(withdrawnSegment.text) ?? "none"}`);
  const unknownFilter = await req("GET", "/admin/abstracts?status=NOT_A_STATUS", null, admin);
  check("B7 an unrecognized status falls back to the unfiltered table",
    unknownFilter.status === 200 && pressedChipName(unknownFilter.text) === "All",
    `pressed ${pressedChipName(unknownFilter.text) ?? "none"}`);

  // 3. Programme health — counted off Session/ScheduleSlot/Room directly.
  const [dashSessions, dashScheduled, dashPublished, dashRooms, dashSlotRooms] = await Promise.all([
    prisma.session.count({ where: { eventId: EVENT_ID } }),
    prisma.session.count({ where: { eventId: EVENT_ID, scheduleSlot: { isNot: null } } }),
    prisma.session.count({ where: { eventId: EVENT_ID, contentStatus: "PUBLISHED" } }),
    prisma.room.count({ where: { eventId: EVENT_ID } }),
    prisma.scheduleSlot.findMany({ where: { eventId: EVENT_ID }, select: { roomId: true } }),
  ]);
  const dashRoomsInUse = new Set(dashSlotRooms.map((slot) => slot.roomId)).size;
  check("B7 the programme card is not vacuous", dashSessions > 0 && dashRooms > 0,
    `${dashSessions} sessions, ${dashRooms} rooms`);
  check("B7 scheduled counts talks holding a ScheduleSlot",
    dashboardRow(dashHtml, "Scheduled") === `${dashScheduled} / ${dashSessions}`,
    `page "${dashboardRow(dashHtml, "Scheduled")}" vs db ${dashScheduled} / ${dashSessions}`);
  check("B7 unplaced talks are the complement of the scheduled ones",
    dashboardRow(dashHtml, "Not yet placed") === `${dashSessions - dashScheduled}`,
    `page "${dashboardRow(dashHtml, "Not yet placed")}" vs db ${dashSessions - dashScheduled}`);
  check("B7 publication is counted independently of placement",
    dashboardRow(dashHtml, "Published to the public programme") === `${dashPublished} / ${dashSessions}`,
    `page "${dashboardRow(dashHtml, "Published to the public programme")}" vs db ${dashPublished} / ${dashSessions}`);
  check("B7 rooms in use are the distinct rooms holding a slot",
    dashboardRow(dashHtml, "Rooms in use") === `${dashRoomsInUse} / ${dashRooms}`,
    `page "${dashboardRow(dashHtml, "Rooms in use")}" vs db ${dashRoomsInUse} / ${dashRooms}`);

  // 4. Review progress — the round card against its own assignment groupBy,
  //    with withdrawn work excluded exactly as the evaluations screen does.
  const dashRoundGroups = await prisma.reviewAssignment.groupBy({
    by: ["planId", "status"],
    where: { plan: { eventId: EVENT_ID }, abstract: { status: { not: "WITHDRAWN" } } },
    _count: { _all: true },
  });
  const dashRoundRows = dashRoundGroups.filter((row) => row.planId === fx.plan.id);
  const dashAssigned = dashRoundRows.reduce((sum, row) => sum + row._count._all, 0);
  const dashCompleted = dashRoundRows
    .filter((row) => row.status === "COMPLETED")
    .reduce((sum, row) => sum + row._count._all, 0);
  const renderedRound = collapse(dashHtml
    .match(new RegExp(`href="/admin/evaluations\\?planId=${fx.plan.id}"[\\s\\S]{0,400}?<strong>([^<]*)</strong>`))?.[1] ?? null);
  check("B7 the review card is not vacuous — the round really has assignments",
    dashAssigned > 0, `${dashAssigned} assignments`);
  check("B7 round progress matches an independently grouped assignment count",
    renderedRound === `${dashCompleted} / ${dashAssigned}`,
    `page "${renderedRound}" vs db ${dashCompleted} / ${dashAssigned}`);
  const dashUnplacedAccepted = await prisma.abstract.count({
    where: {
      eventId: EVENT_ID, status: "ACCEPTED",
      OR: [{ session: { is: null } }, { session: { scheduleSlot: { is: null } } }],
    },
  });
  check("B7 the accepted-but-unplaced note agrees with the database",
    dashUnplacedAccepted === 0
      ? dashHtml.includes("Every accepted proposal is on the programme.")
      : new RegExp(`<strong>${dashUnplacedAccepted}</strong> accepted proposal`).test(dashHtml),
    `db says ${dashUnplacedAccepted}`);

  // 5. Speakers — the roster total as an independent set union of the two
  //    tables the roster page itself unions.
  const [dashMemberSpeakers, dashSessionSpeakers] = await Promise.all([
    prisma.eventMember.findMany({ where: { eventId: EVENT_ID, role: "SPEAKER" }, select: { userId: true } }),
    prisma.sessionSpeaker.findMany({ where: { session: { eventId: EVENT_ID } }, select: { userId: true } }),
  ]);
  const dashSpeakerTotal = new Set([
    ...dashMemberSpeakers.map((row) => row.userId),
    ...dashSessionSpeakers.map((row) => row.userId),
  ]).size;
  check("B7 the speaker card is not vacuous", dashSpeakerTotal > 0, `${dashSpeakerTotal} speakers`);
  check("B7 the speaker total is the union of named and session speakers",
    dashboardRow(dashHtml, "Speakers") === `${dashSpeakerTotal}`,
    `page "${dashboardRow(dashHtml, "Speakers")}" vs db ${dashSpeakerTotal}`);
  // And the dashboard must not restate the roster page's own headline figure.
  const dashRosterPage = stripComments((await req("GET", "/admin/speakers", null, admin)).text);
  const dashRosterConfirmed = dashRosterPage.match(/<span>Confirmed speakers<\/span><strong>(\d+)<\/strong>/)?.[1] ?? null;
  const dashOnboarded = dashboardRow(dashHtml, "Fully onboarded");
  check("B7 onboarding is measured over the same cohort the roster page reports",
    dashRosterConfirmed !== null && dashOnboarded?.endsWith(`/ ${dashRosterConfirmed}`) === true,
    `dashboard "${dashOnboarded}" vs roster confirmed ${dashRosterConfirmed ?? "none"}`);

  // 6. Recent activity — the five newest submissions, newest first, each
  //    deep-linked through the canonical `?abstract=` permalink (PR #88).
  const dashRecent = await prisma.abstract.findMany({
    where: { eventId: EVENT_ID, submittedAt: { not: null } },
    orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
    take: 5,
    select: { id: true, title: true },
  });
  check("B7 the activity strip is not vacuous", dashRecent.length > 0, `${dashRecent.length} rows`);
  const dashRecentPositions = dashRecent.map((row) => dashHtml.indexOf(`href="/admin/abstracts?abstract=${row.id}"`));
  check("B7 every recent submission is deep-linked with ?abstract=",
    dashRecentPositions.every((position) => position !== -1),
    dashRecent.filter((_, i) => dashRecentPositions[i] === -1).map((row) => row.id).join(", "));
  check("B7 recent submissions render newest first",
    dashRecentPositions.every((position, i) => i === 0 || position > dashRecentPositions[i - 1]),
    dashRecentPositions.join(" < "));
  check("B7 the activity strip is bounded at five rows per column",
    (dashHtml.match(/href="\/admin\/abstracts\?abstract=/g) ?? []).length <= 10,
    `${(dashHtml.match(/href="\/admin\/abstracts\?abstract=/g) ?? []).length} deep links`);
  check("B7 no activity link falls back to the legacy ?abstractId= form",
    !dashHtml.includes("/admin/abstracts?abstractId="));

  // 7. Authorization — identical to every sibling admin page.
  const dashSpeakerSession = await reqManual("/admin", speaker);
  check("B7 a speaker is redirected away from the dashboard → 307",
    dashSpeakerSession.status === 307, `got ${dashSpeakerSession.status}`);
  const dashForgedAdmin = await reqManual("/admin", { ...speaker, role: "ADMIN" });
  check("B7 a forged ADMIN claim in the cookie does not open the dashboard → 307",
    dashForgedAdmin.status === 307, `got ${dashForgedAdmin.status}`);
  const dashEvaluatorSession = await reqManual("/admin", evaluator);
  check("B7 a reviewer is redirected away from the dashboard → 307",
    dashEvaluatorSession.status === 307, `got ${dashEvaluatorSession.status}`);
  const dashAnon = await reqManual("/admin", null);
  check("B7 an unauthenticated dashboard request → 307 /login",
    dashAnon.status === 307 && dashAnon.location.includes("/login"),
    `${dashAnon.status} ${dashAnon.location || "no location"}`);

  // 8. Zero-state honesty — a card with nothing in it must offer the next step,
  //    not a zero in a vacuum. Driven by what the fresh event actually holds at
  //    this point in the run rather than by an assumed shape.
  const dashFreshAdmin = { ...admin, event: { id: FRESH_EVENT_ID, name: "Scratch Fresh", slug: FRESH_EVENT_ID } };
  const freshDash = await req("GET", "/admin", null, dashFreshAdmin);
  check("B7 the dashboard renders for a fresh event → 200", freshDash.status === 200, `got ${freshDash.status}`);
  const freshDashHtml = stripComments(freshDash.text);
  const [freshForms, freshAbstracts, freshSessions, freshRounds, freshNamedSpeakers, freshSessionSpeakers] =
    await Promise.all([
      prisma.formConfig.count({ where: { eventId: FRESH_EVENT_ID } }),
      prisma.abstract.count({ where: { eventId: FRESH_EVENT_ID } }),
      prisma.session.count({ where: { eventId: FRESH_EVENT_ID } }),
      prisma.evaluationPlan.count({ where: { eventId: FRESH_EVENT_ID } }),
      prisma.eventMember.count({ where: { eventId: FRESH_EVENT_ID, role: "SPEAKER" } }),
      prisma.sessionSpeaker.count({ where: { session: { eventId: FRESH_EVENT_ID } } }),
    ]);
  check("B7 an event with no proposals says so and points at the call",
    freshAbstracts > 0
      ? true
      : freshForms === 0
        ? freshDashHtml.includes("No CFP form yet") && freshDashHtml.includes('href="/admin/forms"')
        : freshDashHtml.includes("No proposals yet") && freshDashHtml.includes('href="/admin/forms"'),
    `${freshForms} forms, ${freshAbstracts} proposals`);
  check("B7 an event with no talks offers the agenda builder rather than a zero",
    freshSessions > 0
      ? true
      : freshDashHtml.includes("No talks yet") && freshDashHtml.includes('href="/admin/agenda"'),
    `${freshSessions} sessions`);
  check("B7 an event with no speakers offers the roster rather than a zero",
    freshNamedSpeakers + freshSessionSpeakers > 0
      ? true
      : freshDashHtml.includes("No speakers yet") && freshDashHtml.includes('href="/admin/speakers"'),
    `${freshNamedSpeakers} named, ${freshSessionSpeakers} on sessions`);
  check("B7 an event with no review round offers to create one",
    freshRounds > 0
      ? true
      : freshDashHtml.includes("No review round yet") && freshDashHtml.includes("Create the first round"),
    `${freshRounds} rounds`);
  // At least one of the four zero states must actually have been exercised, or
  // the block above proves nothing.
  check("B7 the fresh event really exercised at least one zero state",
    freshAbstracts === 0 || freshSessions === 0 || freshRounds === 0
      || freshNamedSpeakers + freshSessionSpeakers === 0,
    "the fresh scratch event is no longer empty in any dimension");

  // --- D-C5-16 #4: the /admin/reports process report ------------------------
  // Same discipline as the B7 block above: every figure is checked against a
  // Prisma query written HERE, from a different angle than the page's own read
  // (per-status counts, raw ScheduleSlot intervals, a membership scan), so a
  // shared bug cannot make both sides agree. Nothing is hardcoded — the scratch
  // fixture has been mutated by the whole run above.
  const reportsPage = await req("GET", "/admin/reports", null, admin);
  check("C5-REPORTS the reports page renders → 200", reportsPage.status === 200, `got ${reportsPage.status}`);
  const reportsHtml = stripComments(reportsPage.text);
  /** One panel's markup, so an assertion cannot match a neighbouring section. */
  const reportSection = (id, next) => {
    const start = reportsHtml.indexOf(`id="reports-${id}"`);
    if (start === -1) return "";
    const end = next ? reportsHtml.indexOf(`id="reports-${next}"`) : -1;
    return reportsHtml.slice(start, end === -1 ? reportsHtml.length : end);
  };
  const reportMetric = (label) =>
    collapse(reportsHtml.match(new RegExp(`<span>${label}</span>\\s*<strong>([^<]*)</strong>`))?.[1] ?? null);
  const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /** The numeric cells of one labelled table row, inner markup stripped. */
  const reportRow = (section, label) => {
    const match = section.match(new RegExp(`<th scope="row">${escapeRe(label)}</th>([\\s\\S]*?)</tr>`));
    if (!match) return null;
    return [...match[1].matchAll(/<td class="report-number">([\s\S]*?)<\/td>/g)]
      .map((cell) => collapse(cell[1].replace(/<[^>]*>/g, "")));
  };
  // Mirrors of lib/tz and lib/reports/metrics formatting, the way this script
  // already mirrors the HMAC and scrypt formats it cannot import.
  const dayKeyOf = (date, timeZone) => {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type).value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  };
  const dayLabelOf = (key) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })
      .format(new Date(`${key}T12:00:00Z`));
  const fmtMinutes = (minutes) => {
    if (minutes <= 0) return "—";
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0) return `${rest}m`;
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  };
  const fmtRate = (rate) => (rate === null ? "—" : `${Math.round(rate * 100)}%`);

  // 1. Acceptance — accepted over decided, where MAYBE is not a decision.
  const [repAccepted, repRejected, repMaybe] = await Promise.all([
    prisma.abstract.count({ where: { eventId: EVENT_ID, status: "ACCEPTED" } }),
    prisma.abstract.count({ where: { eventId: EVENT_ID, status: "REJECTED" } }),
    prisma.abstract.count({ where: { eventId: EVENT_ID, status: "MAYBE" } }),
  ]);
  check("C5-REPORTS the acceptance metric is not vacuous",
    repAccepted + repRejected > 0, `${repAccepted} accepted, ${repRejected} declined`);
  check("C5-REPORTS acceptance is accepted over decided, counted independently",
    reportMetric("Acceptance rate") === fmtRate(repAccepted / (repAccepted + repRejected)),
    `page "${reportMetric("Acceptance rate")}" vs db ${repAccepted}/${repAccepted + repRejected}`);
  // A maybe in the denominator would move the number; prove it is excluded.
  check("C5-REPORTS a maybe is excluded from the acceptance denominator",
    repMaybe === 0
      || reportMetric("Acceptance rate") !== fmtRate(repAccepted / (repAccepted + repRejected + repMaybe)),
    `${repMaybe} maybes did not change the rate`);

  // 2. Review load — grouped per evaluator, withdrawn excluded, restricted to
  //    the members the page can actually name.
  const repMembers = await prisma.eventMember.findMany({
    where: { eventId: EVENT_ID, role: { in: ["EVALUATOR", "ADMIN"] } },
    select: { userId: true, user: { select: { name: true, email: true } } },
  });
  const repMemberIds = new Set(repMembers.map((member) => member.userId));
  const repLoadGroups = await prisma.reviewAssignment.groupBy({
    by: ["evaluatorId", "status"],
    where: { plan: { eventId: EVENT_ID }, abstract: { status: { not: "WITHDRAWN" } } },
    _count: { _all: true },
  });
  const repLoad = new Map();
  for (const row of repLoadGroups) {
    if (!repMemberIds.has(row.evaluatorId)) continue;
    const totals = repLoad.get(row.evaluatorId) ?? { assigned: 0, completed: 0 };
    totals.assigned += row._count._all;
    if (row.status === "COMPLETED") totals.completed += row._count._all;
    repLoad.set(row.evaluatorId, totals);
  }
  const repAssigned = [...repLoad.values()].reduce((sum, row) => sum + row.assigned, 0);
  const repCompleted = [...repLoad.values()].reduce((sum, row) => sum + row.completed, 0);
  check("C5-REPORTS the review load is not vacuous", repAssigned > 0, `${repAssigned} assignments`);
  check("C5-REPORTS outstanding reviews match an independently grouped count",
    reportMetric("Reviews outstanding") === String(repAssigned - repCompleted),
    `page "${reportMetric("Reviews outstanding")}" vs db ${repAssigned - repCompleted}`);
  const reviewSection = reportSection("review", "utilization");
  const loadMismatch = repMembers
    .map((member) => {
      const totals = repLoad.get(member.userId) ?? { assigned: 0, completed: 0 };
      const rendered = reportRow(reviewSection, member.user.name);
      const expected = [
        String(totals.assigned),
        String(totals.completed),
        String(Math.max(0, totals.assigned - totals.completed)),
      ];
      return rendered && rendered.slice(0, 3).join("/") === expected.join("/")
        ? null
        : `${member.user.name}: page ${rendered?.slice(0, 3).join("/") ?? "missing"} vs db ${expected.join("/")}`;
    })
    .filter(Boolean);
  check("C5-REPORTS every reviewer's assigned/completed/outstanding matches the database",
    loadMismatch.length === 0, loadMismatch.join("; "));
  check("C5-REPORTS the review section names reviewers without exposing their address",
    repMembers.every((member) => !reviewSection.includes(member.user.email)),
    "a reviewer email reached the report");
  check("C5-REPORTS the report carries no score, rubric or per-abstract review link",
    !/rubric|weighted|reviewScore/i.test(reportsHtml)
      && !reportsHtml.includes("/admin/abstracts?abstract="),
    "review detail leaked onto the process report");

  // 3. Per-category funnel — the fixture category against its own groupBy, in
  //    the abstracts page's chip order.
  const REPORT_FUNNEL_ORDER = ["SUBMITTED", "UNDER_REVIEW", "MAYBE", "ACCEPTED", "REJECTED", "DRAFT", "WITHDRAWN"];
  const repCategoryGroups = await prisma.abstract.groupBy({
    by: ["status"],
    where: { eventId: EVENT_ID, categoryId: fx.category.id },
    _count: { _all: true },
  });
  const repCategoryCounts = new Map(repCategoryGroups.map((row) => [row.status, row._count._all]));
  const repCategoryDecided = (repCategoryCounts.get("ACCEPTED") ?? 0) + (repCategoryCounts.get("REJECTED") ?? 0);
  const funnelSection = reportSection("funnel", "review");
  const renderedCategory = reportRow(funnelSection, fx.category.name);
  const expectedCategory = [
    ...REPORT_FUNNEL_ORDER.map((status) => String(repCategoryCounts.get(status) ?? 0)),
    String(repCategoryDecided),
    fmtRate(repCategoryDecided === 0 ? null : (repCategoryCounts.get("ACCEPTED") ?? 0) / repCategoryDecided),
  ];
  check("C5-REPORTS the category funnel row is not vacuous",
    [...repCategoryCounts.values()].reduce((sum, n) => sum + n, 0) > 0, "the fixture category holds no proposals");
  check("C5-REPORTS the category row matches an independent per-status count",
    renderedCategory !== null && renderedCategory.join("|") === expectedCategory.join("|"),
    `page ${renderedCategory?.join("|") ?? "missing"} vs db ${expectedCategory.join("|")}`);
  // The foot must equal the whole event, counted without any category join.
  const repAllGroups = await prisma.abstract.groupBy({
    by: ["status"], where: { eventId: EVENT_ID }, _count: { _all: true },
  });
  const repAllCounts = new Map(repAllGroups.map((row) => [row.status, row._count._all]));
  const renderedTotals = reportRow(funnelSection, "All categories");
  check("C5-REPORTS the totals row equals the event's own status counts",
    renderedTotals !== null
      && renderedTotals.slice(0, 7).join("|")
        === REPORT_FUNNEL_ORDER.map((status) => String(repAllCounts.get(status) ?? 0)).join("|"),
    `page ${renderedTotals?.slice(0, 7).join("|") ?? "missing"}`);

  // 4. Room utilization — recomputed from raw ScheduleSlot intervals.
  const repEvent = await prisma.event.findUnique({
    where: { id: EVENT_ID }, select: { timezone: true },
  });
  const [repSlots, repRooms] = await Promise.all([
    prisma.scheduleSlot.findMany({
      where: { eventId: EVENT_ID }, select: { roomId: true, startsAt: true, endsAt: true },
    }),
    prisma.room.findMany({ where: { eventId: EVENT_ID }, select: { id: true, name: true } }),
  ]);
  const repRoomName = new Map(repRooms.map((room) => [room.id, room.name]));
  const repBookedTotal = repSlots.reduce(
    (sum, slot) => sum + Math.max(0, Math.round((slot.endsAt.getTime() - slot.startsAt.getTime()) / 60000)), 0);
  check("C5-REPORTS the utilization section is not vacuous",
    repSlots.length > 0 && repRooms.length > 0, `${repSlots.length} slots, ${repRooms.length} rooms`);
  check("C5-REPORTS booked programme time is the sum of the placed slot intervals",
    reportMetric("Programme time booked") === fmtMinutes(repBookedTotal),
    `page "${reportMetric("Programme time booked")}" vs db ${fmtMinutes(repBookedTotal)}`);

  const repPerRoomDay = new Map();
  for (const slot of repSlots) {
    const key = `${dayLabelOf(dayKeyOf(slot.startsAt, repEvent.timezone))}|${repRoomName.get(slot.roomId)}`;
    const totals = repPerRoomDay.get(key) ?? { slots: 0, minutes: 0 };
    totals.slots += 1;
    totals.minutes += Math.max(0, Math.round((slot.endsAt.getTime() - slot.startsAt.getTime()) / 60000));
    repPerRoomDay.set(key, totals);
  }
  const utilSection = reportSection("utilization", "readiness");
  const utilTable = new Map();
  let utilDay = null;
  for (const match of utilSection.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const row = match[1];
    const dayLabel = row.match(/<div class="cell-title">([^<]*)<\/div>/)?.[1];
    if (dayLabel) utilDay = dayLabel;
    const roomName = row.match(/<td>([^<]*)<\/td>/)?.[1];
    const numbers = [...row.matchAll(/<td class="report-number">([\s\S]*?)<\/td>/g)]
      .map((cell) => collapse(cell[1].replace(/<[^>]*>/g, "")));
    if (roomName && numbers.length === 4) utilTable.set(`${utilDay}|${roomName}`, numbers);
  }
  const utilMismatch = [...repPerRoomDay.entries()]
    .map(([key, totals]) => {
      const rendered = utilTable.get(key);
      return rendered && rendered[0] === String(totals.slots) && rendered[1] === fmtMinutes(totals.minutes)
        ? null
        : `${key}: page ${rendered?.slice(0, 2).join("/") ?? "missing"} vs db ${totals.slots}/${fmtMinutes(totals.minutes)}`;
    })
    .filter(Boolean);
  check("C5-REPORTS every booked room-day matches an independently summed interval",
    repPerRoomDay.size > 0 && utilMismatch.length === 0,
    utilMismatch.join("; ") || `${repPerRoomDay.size} room-days`);
  const idleRooms = repRooms.filter((room) => ![...repPerRoomDay.keys()].some((key) => key.endsWith(`|${room.name}`)));
  check("C5-REPORTS an idle room is still listed, as a zero row rather than a gap",
    idleRooms.length === 0
      || idleRooms.every((room) => [...utilTable.keys()].some((key) => key.endsWith(`|${room.name}`))),
    idleRooms.map((room) => room.name).join(", "));

  // 5. Readiness — measured over the same cohort the roster page reports.
  const repRosterHtml = stripComments((await req("GET", "/admin/speakers", null, admin)).text);
  const repRosterConfirmed = repRosterHtml.match(/<span>Confirmed speakers<\/span><strong>(\d+)<\/strong>/)?.[1] ?? null;
  const readinessSection = reportSection("readiness", null);
  const readinessBuckets = [...readinessSection.matchAll(/<strong>(\d+) \/ (\d+)<\/strong>/g)]
    .map((match) => [Number(match[1]), Number(match[2])]);
  check("C5-REPORTS the readiness ladder renders all three buckets",
    readinessBuckets.length === 3, `${readinessBuckets.length} buckets`);
  check("C5-REPORTS readiness is measured over the roster page's own confirmed cohort",
    repRosterConfirmed !== null && readinessBuckets.every(([, cohort]) => String(cohort) === repRosterConfirmed),
    `report cohorts ${readinessBuckets.map(([, cohort]) => cohort).join(",")} vs roster ${repRosterConfirmed ?? "none"}`);
  check("C5-REPORTS the readiness buckets partition the cohort exactly",
    readinessBuckets.length === 3
      && readinessBuckets.reduce((sum, [count]) => sum + count, 0) === Number(repRosterConfirmed),
    `${readinessBuckets.map(([count]) => count).join("+")} vs ${repRosterConfirmed}`);

  // 6. The exports are reachable from the page, including the ABS-13 one.
  const reportExportLinks = [
    "/api/admin/speakers/export",
    "/api/admin/sessions/export",
    "/api/admin/schedule/export",
    "/api/admin/abstracts/export",
  ].filter((href) => !reportsHtml.includes(`href="${href}"`));
  check("C5-REPORTS all four CSV exports are offered beside their sections",
    reportExportLinks.length === 0, reportExportLinks.join(", "));
  check("C5-REPORTS the sidebar offers Reports to an admin",
    reportsHtml.includes('href="/admin/reports"'), "no sidebar entry");

  // 7. Authorization — identical to every sibling admin page.
  const reportsSpeaker = await reqManual("/admin/reports", speaker);
  check("C5-REPORTS a speaker is redirected away from the reports page → 307",
    reportsSpeaker.status === 307, `got ${reportsSpeaker.status}`);
  const reportsForged = await reqManual("/admin/reports", { ...speaker, role: "ADMIN" });
  check("C5-REPORTS a forged ADMIN claim in the cookie does not open the reports page → 307",
    reportsForged.status === 307, `got ${reportsForged.status}`);
  const reportsEvaluator = await reqManual("/admin/reports", evaluator);
  check("C5-REPORTS a reviewer is redirected away from the reports page → 307",
    reportsEvaluator.status === 307, `got ${reportsEvaluator.status}`);
  const reportsAnon = await reqManual("/admin/reports", null);
  check("C5-REPORTS an unauthenticated reports request → 307 /login",
    reportsAnon.status === 307 && reportsAnon.location.includes("/login"),
    `${reportsAnon.status} ${reportsAnon.location || "no location"}`);
  // A SPEAKER must not see the entry advertised either.
  const speakerShell = await req("GET", "/portal", null, speaker);
  check("C5-REPORTS the sidebar hides Reports from a speaker",
    !speakerShell.text.includes('href="/admin/reports"'), "the entry was advertised to a speaker");

  // 8. Zero-state honesty on the fresh event.
  const freshReports = await req("GET", "/admin/reports", null,
    { ...admin, event: { id: FRESH_EVENT_ID, name: "Scratch Fresh", slug: FRESH_EVENT_ID } });
  check("C5-REPORTS the reports page renders for a fresh event → 200",
    freshReports.status === 200, `got ${freshReports.status}`);
  const freshReportsHtml = stripComments(freshReports.text);
  const [freshReportSlots, freshReportAssignments] = await Promise.all([
    prisma.scheduleSlot.count({ where: { eventId: FRESH_EVENT_ID } }),
    prisma.reviewAssignment.count({ where: { plan: { eventId: FRESH_EVENT_ID } } }),
  ]);
  check("C5-REPORTS an event with nothing placed says so and points at the builder",
    freshReportSlots > 0
      ? true
      : freshReportsHtml.includes("Nothing is placed yet") && freshReportsHtml.includes('href="/admin/agenda"'),
    `${freshReportSlots} slots`);
  check("C5-REPORTS an unstarted acceptance rate reads as a dash, never as zero percent",
    freshReportsHtml.includes("<strong>—</strong>") || freshReportAssignments > 0,
    "a fresh event reported 0% acceptance");

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
  const speakerSess = { user: { id: "x", name: "Sofia Marques", email: "sofia@greenroom-hq.com" }, event: ev, role: "ADMIN" };
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
