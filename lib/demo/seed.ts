import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * Deterministic, idempotent demo seed for Greenroom.
 *
 * Running it again wipes and rebuilds all data scoped to the demo event, so it
 * doubles as the demo-reset payload. Global `User` rows are upserted by email
 * (matching the auth contract: users are resolved by lowercased email, not id)
 * so persona and email logins survive a reseed.
 */

export const DEMO_EVENT = {
  id: "demo-event",
  name: "Forward 2026",
  slug: "forward-2026",
  timezone: "America/Los_Angeles",
} as const;

// Personas must match lib/auth.ts DEMO_PERSONAS emails.
const PERSONAS = {
  admin: { email: "maya@greenroom.demo", name: "Maya Chen" },
  evaluator: { email: "ravi@greenroom.demo", name: "Ravi Patel" },
  speaker: { email: "sofia@greenroom.demo", name: "Sofia Marques" },
} as const;

const CATEGORIES = [
  { key: "ai", name: "AI & Machine Learning", teamKey: "team-ai" },
  { key: "platform", name: "Platform Engineering", teamKey: "team-platform" },
  { key: "product", name: "Product & Design", teamKey: "team-product" },
  { key: "security", name: "Security & Trust", teamKey: "team-security" },
] as const;

const TRACKS = [
  { key: "mainstage", name: "Mainstage", color: "#6366f1" },
  { key: "deepdive", name: "Deep Dives", color: "#0ea5e9" },
  { key: "workshops", name: "Workshops", color: "#f59e0b" },
] as const;

const ROOMS = [
  { key: "ballroom", name: "Grand Ballroom", capacity: 600 },
  { key: "hall-a", name: "Hall A", capacity: 180 },
  { key: "hall-b", name: "Hall B", capacity: 180 },
  { key: "lab", name: "Workshop Lab", capacity: 60 },
] as const;

const RUBRIC: Prisma.InputJsonValue = [
  { key: "relevance", label: "Relevance", description: "Fit for the audience and event theme.", min: 1, max: 5, weight: 1.5 },
  { key: "originality", label: "Originality", description: "Fresh perspective or novel material.", min: 1, max: 5, weight: 1 },
  { key: "clarity", label: "Clarity", description: "Well-structured, understandable abstract.", min: 1, max: 5, weight: 1 },
  { key: "speaker", label: "Speaker Readiness", description: "Track record and delivery signals.", min: 1, max: 5, weight: 1 },
];

const RUBRIC_KEYS = ["relevance", "originality", "clarity", "speaker"] as const;

const FIRST = [
  "Alex", "Priya", "Diego", "Mei", "Noah", "Fatima", "Lucas", "Aisha", "Kenji", "Zoe",
  "Omar", "Nadia", "Ivan", "Grace", "Mateo", "Leila", "Sven", "Yara", "Tomas", "Isla",
  "Rahul", "Elena", "Kofi", "Sara", "Bjorn", "Anaya", "Pablo", "Mina", "Andre", "Hana",
  "Viktor", "Lucia", "Samir", "Nora", "Dmitri", "Keiko", "Marco", "Amara", "Felix", "Ruth",
  "Hugo", "Talia", "Owen", "Vera",
];
const LAST = [
  "Nguyen", "Okafor", "Silva", "Kim", "Patel", "Haddad", "Rossi", "Ali", "Tanaka", "Meyer",
  "Costa", "Ivanova", "Bauer", "Chen", "Lopez", "Farah", "Larsson", "Diallo", "Novak", "Murphy",
  "Sharma", "Petrov", "Mensah", "Cohen", "Andersen", "Reddy", "Marino", "Sato", "Dubois", "Kaur",
  "Volkov", "Romano", "Haidar", "Bianchi", "Sokolov", "Yamada", "Greco", "Owusu", "Schmidt", "Levi",
  "Berg", "Nasser", "Walsh", "Falk",
];

const FORMATS = ["Talk (30 min)", "Deep Dive (45 min)", "Workshop (90 min)", "Lightning (10 min)"] as const;
const DURATIONS = [30, 45, 90, 10] as const;

const TITLE_PREFIX = [
  "Scaling", "Rethinking", "Inside", "Beyond", "Practical", "The Hidden Cost of", "Building", "Debugging",
  "From Zero to", "Lessons from", "A Field Guide to", "Taming", "Designing", "Operating", "The Future of",
];
const TITLE_SUBJECT = [
  "Vector Search", "Event-Driven Systems", "Design Systems", "Zero-Trust Networks", "LLM Evaluation",
  "Multi-Region Postgres", "Incident Response", "Feature Flags", "Edge Rendering", "Observability",
  "Developer Platforms", "Data Contracts", "Realtime Pipelines", "Accessibility", "Cost Governance",
];

type SeedSummary = Record<string, number>;

function slugifyEmail(name: string, i: number): string {
  const base = name.toLowerCase().replace(/[^a-z]+/g, ".");
  return `${base}.${i}@speakers.demo`;
}

/**
 * Advisory-lock key for the demo seed. Any arbitrary constant works; every
 * seeding process just has to agree on it.
 */
const SEED_LOCK_KEY = 8_675_309;

/**
 * Seed the demo data.
 *
 * Runs as a **single transaction** holding a Postgres advisory lock, which fixes
 * two real failures observed during the sprint:
 *
 * 1. **Concurrent seeds deadlocked (40P01).** Two seeds both bulk-delete and
 *    re-insert identical unique keys, so they interleave and deadlock. The
 *    `pg_advisory_xact_lock` makes a second concurrent seed *wait* for the first
 *    to finish instead of racing it. The lock is transaction-scoped, so it is
 *    released automatically on commit *or* rollback — a crashed seed cannot
 *    wedge the lock.
 * 2. **A failed seed left the DB half-wiped.** Delete and rebuild used to be
 *    separate transactions, so an interrupted run destroyed the demo data
 *    without replacing it. Now the whole thing commits or rolls back as a unit.
 *
 * The timeout is generous because a full seed issues several hundred statements.
 */
export async function seedDemo(prisma: PrismaClient): Promise<SeedSummary> {
  return prisma.$transaction(
    async (tx) => {
      // Serialize against any other seeding process before touching a row.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SEED_LOCK_KEY}::bigint)`;
      return seedWithin(tx);
    },
    { maxWait: 60_000, timeout: 300_000 },
  );
}

async function seedWithin(db: Prisma.TransactionClient): Promise<SeedSummary> {
  const eventId = DEMO_EVENT.id;

  // --- 1. Reset all event-scoped data (idempotent reseed) --------------------
  // Sequential deletes: we are already inside one transaction, and child rows
  // must go before their parents.
  await db.emailDispatch.deleteMany({ where: { template: { eventId } } });
  await db.reviewScore.deleteMany({ where: { abstract: { eventId } } });
  await db.reviewAssignment.deleteMany({ where: { abstract: { eventId } } });
  await db.formAnswer.deleteMany({ where: { abstract: { eventId } } });
  await db.abstractSpeaker.deleteMany({ where: { abstract: { eventId } } });
  await db.speakerTask.deleteMany({ where: { task: { eventId } } });
  await db.scheduleSlot.deleteMany({ where: { eventId } });
  await db.sessionSpeaker.deleteMany({ where: { session: { eventId } } });
  await db.session.deleteMany({ where: { eventId } });
  await db.abstract.deleteMany({ where: { eventId } });
  await db.formField.deleteMany({ where: { formConfig: { eventId } } });
  await db.onboardingTask.deleteMany({ where: { eventId } });
  await db.formConfig.deleteMany({ where: { eventId } });
  await db.evaluationPlan.deleteMany({ where: { eventId } });
  await db.category.deleteMany({ where: { eventId } });
  await db.track.deleteMany({ where: { eventId } });
  await db.room.deleteMany({ where: { eventId } });
  await db.resourceWiki.deleteMany({ where: { eventId } });
  await db.emailTemplate.deleteMany({ where: { eventId } });
  await db.eventMember.deleteMany({ where: { eventId } });

  // --- 2. Event --------------------------------------------------------------
  const startsAt = new Date("2026-05-12T00:00:00.000Z");
  const endsAt = new Date("2026-05-14T00:00:00.000Z");
  await db.event.upsert({
    where: { id: eventId },
    update: { name: DEMO_EVENT.name, slug: DEMO_EVENT.slug, timezone: DEMO_EVENT.timezone, startsAt, endsAt },
    create: { id: eventId, name: DEMO_EVENT.name, slug: DEMO_EVENT.slug, timezone: DEMO_EVENT.timezone, startsAt, endsAt },
  });

  // --- 3. Persona + evaluator + speaker users --------------------------------
  async function upsertUser(email: string, name: string): Promise<string> {
    const lower = email.toLowerCase();
    const user = await db.user.upsert({
      where: { email: lower },
      update: { name },
      create: { email: lower, name },
    });
    return user.id;
  }

  const adminId = await upsertUser(PERSONAS.admin.email, PERSONAS.admin.name);
  const evaluatorPrimaryId = await upsertUser(PERSONAS.evaluator.email, PERSONAS.evaluator.name);
  const speakerPrimaryId = await upsertUser(PERSONAS.speaker.email, PERSONAS.speaker.name);

  // Two more evaluators for a realistic review team.
  const evaluator2Id = await upsertUser("lena@greenroom.demo", "Lena Fischer");
  const evaluator3Id = await upsertUser("theo@greenroom.demo", "Theo Almeida");
  const evaluatorIds = [evaluatorPrimaryId, evaluator2Id, evaluator3Id];

  // Speaker pool (Sofia is index 0 so she owns real abstracts/tasks).
  const speakerUsers: { id: string; name: string; email: string }[] = [
    { id: speakerPrimaryId, name: PERSONAS.speaker.name, email: PERSONAS.speaker.email },
  ];
  for (let i = 0; i < 40; i++) {
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;
    const email = slugifyEmail(name, i);
    const id = await upsertUser(email, name);
    speakerUsers.push({ id, name, email });
  }

  // --- 4. Memberships --------------------------------------------------------
  const memberships: Prisma.EventMemberCreateManyInput[] = [
    { eventId, userId: adminId, role: "ADMIN" },
    ...evaluatorIds.map((userId) => ({ eventId, userId, role: "EVALUATOR" as const })),
    ...speakerUsers.map((s) => ({ eventId, userId: s.id, role: "SPEAKER" as const })),
  ];
  await db.eventMember.createMany({ data: memberships, skipDuplicates: true });

  // --- 5. Speaker profiles ----------------------------------------------------
  // `SpeakerProfile` is global (keyed by userId), so it is not covered by the
  // event-scoped wipe above. Reset the demo fields explicitly on update as well
  // as create, otherwise edits made through the portal survive a reseed and the
  // demo drifts (observed: a smoke-test job title persisting across seeds).
  for (const s of speakerUsers) {
    const demoProfile = {
      bio: `${s.name} is a practitioner and frequent conference speaker.`,
      company: "Acme Labs",
      jobTitle: "Staff Engineer",
      headshotUrl: null,
      slideDeckUrl: null,
      socialLinks: Prisma.DbNull,
    };
    await db.speakerProfile.upsert({
      where: { userId: s.id },
      update: demoProfile,
      create: { userId: s.id, ...demoProfile },
    });
  }

  // --- 6. Categories, tracks, rooms -----------------------------------------
  const categoryIds: Record<string, string> = {};
  for (const [i, c] of CATEGORIES.entries()) {
    const row = await db.category.create({
      data: { eventId, name: c.name, defaultTeamKey: c.teamKey, sortOrder: i },
    });
    categoryIds[c.key] = row.id;
  }
  const trackIds: Record<string, string> = {};
  for (const [i, t] of TRACKS.entries()) {
    const row = await db.track.create({ data: { eventId, name: t.name, color: t.color, sortOrder: i } });
    trackIds[t.key] = row.id;
  }
  const roomIds: Record<string, string> = {};
  for (const [i, r] of ROOMS.entries()) {
    const row = await db.room.create({ data: { eventId, name: r.name, capacity: r.capacity, sortOrder: i } });
    roomIds[r.key] = row.id;
  }

  // --- 7. CFP form + a task form --------------------------------------------
  const cfp = await db.formConfig.create({
    data: {
      eventId,
      name: "2026 Call for Speakers",
      slug: "call-for-speakers",
      welcomeText: "We're building Forward 2026 with the community. Pitch your talk below.",
      thankYouText: "Thanks for submitting! You'll hear from the program team within three weeks.",
      // Relative to seed time so the CFP is always open when the demo runs
      // (requests/frontend-seed-cfp-window-closed.md — a fixed window went stale).
      opensAt: new Date(Date.now() - 30 * 86400000),
      closesAt: new Date(Date.now() + 60 * 86400000),
      submissionLimit: 3,
      minSpeakers: 1,
      maxSpeakers: 4,
      maxBioLength: 1500,
      published: true,
      fields: {
        create: [
          { key: "audience_level", label: "Audience level", type: "SELECT", required: true, sortOrder: 0,
            options: [ { label: "Beginner", value: "beginner" }, { label: "Intermediate", value: "intermediate" }, { label: "Advanced", value: "advanced" } ] },
          { key: "learning_objectives", label: "What will attendees learn?", helpText: "Three concrete takeaways.", type: "LONG_TEXT", required: true, sortOrder: 1 },
          { key: "prior_talk_url", label: "Link to a prior talk", type: "URL", required: false, sortOrder: 2 },
          { key: "needs_av", label: "Requires special A/V", type: "CHECKBOX", required: false, sortOrder: 3 },
          { key: "code_of_conduct", label: "I agree to the code of conduct", type: "CHECKBOX", required: true, sortOrder: 4 },
        ],
      },
    },
    include: { fields: true },
  });
  const fieldByKey = Object.fromEntries(cfp.fields.map((f) => [f.key, f]));

  const avForm = await db.formConfig.create({
    data: {
      eventId,
      name: "A/V & Logistics",
      slug: "av-logistics",
      welcomeText: "Help us prep the room for your session.",
      thankYouText: "Got it — see you on site!",
      minSpeakers: 1,
      maxSpeakers: 1,
      maxBioLength: 1000,
      published: true,
      fields: {
        create: [
          { key: "shirt_size", label: "Speaker shirt size", type: "SELECT", required: true, sortOrder: 0,
            options: [ { label: "S", value: "s" }, { label: "M", value: "m" }, { label: "L", value: "l" }, { label: "XL", value: "xl" } ] },
          { key: "av_needs", label: "A/V or accessibility needs", type: "LONG_TEXT", required: false, sortOrder: 1 },
          { key: "arrival_date", label: "Arrival date", type: "SHORT_TEXT", required: false, sortOrder: 2 },
        ],
      },
    },
  });

  // --- 8. Abstracts across every status -------------------------------------
  const STATUS_PLAN: { status: "DRAFT" | "SUBMITTED" | "UNDER_REVIEW" | "ACCEPTED" | "REJECTED" | "WITHDRAWN"; count: number }[] = [
    { status: "ACCEPTED", count: 12 },
    { status: "REJECTED", count: 8 },
    { status: "UNDER_REVIEW", count: 8 },
    { status: "SUBMITTED", count: 8 },
    { status: "WITHDRAWN", count: 2 },
    { status: "DRAFT", count: 2 },
  ];

  const catKeys = CATEGORIES.map((c) => c.key);
  type SeededAbstract = { id: string; status: string; categoryKey: string; submitterId: string; primarySpeakerId: string; title: string; durationMinutes: number; format: string };
  const abstracts: SeededAbstract[] = [];
  let idx = 0;
  for (const bucket of STATUS_PLAN) {
    for (let n = 0; n < bucket.count; n++, idx++) {
      // idx 0 is the first ACCEPTED abstract; speakerUsers[0] is Sofia (the
      // speaker persona) so she owns a confirmed session + onboarding tasks.
      const submitter = speakerUsers[idx % speakerUsers.length] ?? speakerUsers[1];
      const catKey = catKeys[idx % catKeys.length];
      const fmt = idx % FORMATS.length;
      const title = `${TITLE_PREFIX[idx % TITLE_PREFIX.length]} ${TITLE_SUBJECT[(idx * 3) % TITLE_SUBJECT.length]}`;
      const isDecided = bucket.status === "ACCEPTED" || bucket.status === "REJECTED";
      const isSubmitted = bucket.status !== "DRAFT";
      const submittedAt = isSubmitted ? new Date(2026, 1, 1 + (idx % 20), 9, 0, 0) : null;
      const decidedAt = isDecided ? new Date(2026, 2, 10 + (idx % 10), 12, 0, 0) : null;

      const created = await db.abstract.create({
        data: {
          eventId,
          formConfigId: cfp.id,
          submitterId: submitter.id,
          title,
          abstract: `A practical, example-driven session on ${TITLE_SUBJECT[(idx * 3) % TITLE_SUBJECT.length].toLowerCase()}. Attendees leave with patterns they can apply on Monday.`,
          format: FORMATS[fmt],
          durationMinutes: DURATIONS[fmt],
          categoryId: categoryIds[catKey],
          status: bucket.status,
          submittedAt,
          decidedAt,
          speakers: {
            create: [
              { userId: submitter.id, isPrimary: true },
              // ~1 in 4 abstracts has a co-speaker
              ...(idx % 4 === 0 ? [{ userId: speakerUsers[(idx + 5) % speakerUsers.length].id, isPrimary: false }] : []),
            ],
          },
          answers: {
            create: [
              { formFieldId: fieldByKey["audience_level"].id, value: ["beginner", "intermediate", "advanced"][idx % 3] },
              { formFieldId: fieldByKey["learning_objectives"].id, value: "1) Core concepts 2) Real tradeoffs 3) A checklist to take home." },
              { formFieldId: fieldByKey["code_of_conduct"].id, value: true },
            ],
          },
        },
      });
      abstracts.push({ id: created.id, status: bucket.status, categoryKey: catKey, submitterId: submitter.id, primarySpeakerId: submitter.id, title, durationMinutes: DURATIONS[fmt], format: FORMATS[fmt] });
    }
  }

  // --- 9. Evaluation plan, assignments, scores ------------------------------
  const plan = await db.evaluationPlan.create({
    data: { eventId, name: "Round 1 — Program Committee", ordinal: 1, isBlind: false, rubric: RUBRIC,
      startsAt: new Date("2026-03-02T00:00:00.000Z"), endsAt: new Date("2026-03-20T00:00:00.000Z") },
  });

  const reviewed = abstracts.filter((a) => ["UNDER_REVIEW", "ACCEPTED", "REJECTED"].includes(a.status));
  for (const a of reviewed) {
    const teamKey = CATEGORIES.find((c) => c.key === a.categoryKey)?.teamKey ?? null;
    const decided = a.status !== "UNDER_REVIEW";
    for (const evalId of evaluatorIds) {
      await db.reviewAssignment.create({
        data: {
          planId: plan.id, abstractId: a.id, evaluatorId: evalId, teamKey,
          status: decided ? "COMPLETED" : "IN_PROGRESS",
          completedAt: decided ? new Date("2026-03-15T00:00:00.000Z") : null,
        },
      });
      if (decided) {
        // Accepted abstracts score higher than rejected.
        const base = a.status === "ACCEPTED" ? 4 : 2;
        for (const [ri, key] of RUBRIC_KEYS.entries()) {
          const score = Math.min(5, Math.max(1, base + ((ri + evaluatorIds.indexOf(evalId)) % 2)));
          await db.reviewScore.create({
            data: { planId: plan.id, abstractId: a.id, evaluatorId: evalId, rubricKey: key, score,
              comment: ri === 0 ? (a.status === "ACCEPTED" ? "Strong fit, clear takeaways." : "Interesting but needs sharper focus.") : null },
          });
        }
      }
    }
  }

  // --- 10. Sessions (accepted -> session) + one guaranteed keynote ----------
  const accepted = abstracts.filter((a) => a.status === "ACCEPTED");
  const sessions: { id: string; title: string; durationMinutes: number; primarySpeakerId: string }[] = [];
  for (const a of accepted) {
    const s = await db.session.create({
      data: {
        eventId, sourceAbstractId: a.id, title: a.title,
        description: "Confirmed session converted from an accepted abstract.",
        format: a.format, durationMinutes: a.durationMinutes,
        speakers: { create: [{ userId: a.primarySpeakerId, isPrimary: true }] },
      },
    });
    sessions.push({ id: s.id, title: a.title, durationMinutes: a.durationMinutes, primarySpeakerId: a.primarySpeakerId });
  }
  const keynote = await db.session.create({
    data: {
      eventId, title: "Opening Keynote: The Next Decade of Developer Experience",
      description: "Invited keynote (guaranteed session, no source abstract).",
      format: "Keynote (45 min)", durationMinutes: 45,
      speakers: { create: [{ userId: speakerUsers[3].id, isPrimary: true }] },
    },
  });
  sessions.unshift({ id: keynote.id, title: keynote.title, durationMinutes: 45, primarySpeakerId: speakerUsers[3].id });

  // --- 11. Schedule most sessions; leave a DELIBERATE room conflict ---------
  const day1 = "2026-05-12";
  const day2 = "2026-05-13";
  const roomOrder = [roomIds["ballroom"], roomIds["hall-a"], roomIds["hall-b"], roomIds["lab"]];
  const trackOrder = [trackIds["mainstage"], trackIds["deepdive"], trackIds["deepdive"], trackIds["workshops"]];
  const startHours = [9, 10, 11, 13, 14, 15];

  const toSchedule = sessions.slice(0, 10);
  let slotIdx = 0;
  for (const s of toSchedule) {
    const day = slotIdx < 6 ? day1 : day2;
    const roomI = slotIdx % roomOrder.length;
    const hour = startHours[slotIdx % startHours.length];
    const startsAtSlot = new Date(`${day}T${String(hour).padStart(2, "0")}:00:00.000Z`);
    const endsAtSlot = new Date(startsAtSlot.getTime() + s.durationMinutes * 60_000);
    await db.scheduleSlot.create({
      data: { eventId, sessionId: s.id, roomId: roomOrder[roomI], trackId: trackOrder[roomI], startsAt: startsAtSlot, endsAt: endsAtSlot },
    });
    slotIdx++;
  }
  // Deliberate conflict: schedule one more session in the SAME room + time as the first slot.
  if (sessions.length > 10) {
    const conflictStart = new Date(`${day1}T09:00:00.000Z`);
    const conflicting = sessions[10];
    await db.scheduleSlot.create({
      data: {
        eventId, sessionId: conflicting.id, roomId: roomOrder[0], trackId: trackOrder[0],
        startsAt: conflictStart, endsAt: new Date(conflictStart.getTime() + conflicting.durationMinutes * 60_000),
      },
    });
  }

  // --- 12. Onboarding tasks (incl. a form-in-task) + per-speaker status ------
  const taskDefs = [
    { title: "Complete your speaker profile", required: true, formConfigId: null as string | null },
    { title: "Upload a headshot", required: true, formConfigId: null },
    { title: "Submit A/V & logistics form", required: true, formConfigId: avForm.id },
    { title: "Confirm session details", required: true, formConfigId: null },
    { title: "Upload your slide deck", required: false, formConfigId: null },
  ];
  const tasks = [];
  for (const [i, t] of taskDefs.entries()) {
    const row = await db.onboardingTask.create({
      data: { eventId, title: t.title, required: t.required, formConfigId: t.formConfigId, sortOrder: i,
        dueAt: new Date("2026-04-15T00:00:00.000Z"),
        description: t.formConfigId ? "Fill out the linked form to complete this task." : undefined },
    });
    tasks.push(row);
  }

  // Assign tasks to every confirmed session speaker.
  const sessionSpeakerIds = Array.from(new Set(sessions.map((s) => s.primarySpeakerId)));
  const taskStatuses = ["COMPLETED", "COMPLETED", "IN_PROGRESS", "TODO", "TODO"] as const;
  for (const userId of sessionSpeakerIds) {
    for (const [i, task] of tasks.entries()) {
      // Sofia (speakerPrimaryId) gets exactly 3/5 complete to match the portal summary.
      const status = userId === speakerPrimaryId
        ? (i < 3 ? "COMPLETED" : "TODO")
        : taskStatuses[(i + sessionSpeakerIds.indexOf(userId)) % taskStatuses.length];
      await db.speakerTask.create({
        data: {
          taskId: task.id, userId, status,
          completedAt: status === "COMPLETED" ? new Date("2026-04-01T00:00:00.000Z") : null,
          responses: task.formConfigId && status === "COMPLETED" ? { shirt_size: "m", av_needs: "Wireless lav mic", arrival_date: "2026-05-11" } : undefined,
        },
      });
    }
  }

  // --- 13. Email templates + resource wiki ----------------------------------
  const templates = [
    { key: "cfp-accepted", subject: "Your talk was accepted for Forward 2026 🎉", trigger: "abstract.accepted",
      htmlBody: "<p>Hi {{speakerName}},</p><p>Great news — <strong>{{talkTitle}}</strong> was accepted! Please complete your onboarding tasks in the speaker portal.</p>" },
    { key: "cfp-rejected", subject: "Update on your Forward 2026 submission", trigger: "abstract.rejected",
      htmlBody: "<p>Hi {{speakerName}},</p><p>Thank you for submitting <strong>{{talkTitle}}</strong>. Unfortunately we couldn't include it this year.</p>" },
    { key: "task-reminder", subject: "Reminder: finish your speaker tasks", trigger: "task.reminder",
      htmlBody: "<p>Hi {{speakerName}},</p><p>You have {{openTasks}} onboarding task(s) still open. Please wrap them up before {{dueDate}}.</p>" },
    { key: "session-scheduled", subject: "Your session is scheduled", trigger: "session.scheduled",
      htmlBody: "<p>Hi {{speakerName}},</p><p><strong>{{talkTitle}}</strong> is scheduled for {{slotTime}} in {{roomName}}. A calendar invite is attached.</p>" },
  ];
  for (const t of templates) {
    await db.emailTemplate.create({ data: { eventId, ...t } });
  }

  const resources = [
    { slug: "speaker-handbook", title: "Speaker Handbook", summary: "Everything you need before you present.", published: true,
      htmlContent: "<h2>Welcome, speakers!</h2><p>This handbook covers arrival, A/V, and stage logistics.</p><ul><li>Arrive 30 minutes early.</li><li>Bring your own adapter.</li><li>Slides due one week prior.</li></ul>" },
    { slug: "venue-guide", title: "Venue & Travel Guide", summary: "Getting to and around the venue.", published: true,
      htmlContent: "<h2>Venue</h2><p>Moscone West, San Francisco.</p><p>Nearest transit: Powell St BART.</p>" },
  ];
  for (const r of resources) {
    await db.resourceWiki.create({ data: { eventId, ...r } });
  }

  // --- 14. Summary -----------------------------------------------------------
  const [userCount, abstractCount, sessionCount, slotCount, taskCount, speakerTaskCount] = await Promise.all([
    db.user.count(),
    db.abstract.count({ where: { eventId } }),
    db.session.count({ where: { eventId } }),
    db.scheduleSlot.count({ where: { eventId } }),
    db.onboardingTask.count({ where: { eventId } }),
    db.speakerTask.count({ where: { task: { eventId } } }),
  ]);

  return {
    users: userCount,
    categories: CATEGORIES.length,
    tracks: TRACKS.length,
    rooms: ROOMS.length,
    forms: 2,
    abstracts: abstractCount,
    sessions: sessionCount,
    scheduleSlots: slotCount,
    onboardingTasks: taskCount,
    speakerTasks: speakerTaskCount,
    emailTemplates: templates.length,
    resources: resources.length,
  };
}
