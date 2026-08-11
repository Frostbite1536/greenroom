import { Prisma, type PrismaClient } from "@prisma/client";
import { CFP_SUBMITTED_TEMPLATE_KEY } from "@/lib/comms/notifications";
import { hashPassword } from "@/lib/password-credential";
import { zonedToUtcIso } from "@/lib/tz";

/**
 * Deterministic, idempotent demo seed for Greenroom.
 *
 * Running it again wipes and rebuilds all data scoped to the demo event, so it
 * doubles as the demo-reset payload. Global `User` rows are upserted by email
 * (matching the auth contract: users are resolved by lowercased email, not id)
 * so fixed seeded persona sessions survive a reseed.
 */

export const DEMO_EVENT = {
  id: "demo-event",
  name: "Forward 2026",
  slug: "forward-2026",
  timezone: "America/Los_Angeles",
} as const;

/** Event-local calendar dates; all persisted instants are derived from these. */
export const DEMO_EVENT_DATES = {
  startsOn: "2026-05-12",
  endsOn: "2026-05-14",
} as const;

/**
 * Seeded onboarding deadlines deliberately staircase into the May 12–14 event.
 * The definitive recipient addresses remain an Architect-window decision, so
 * this schedule contains no speculative delivery address.
 */
export const DEMO_TASK_SCHEDULE = [
  { title: "Complete your speaker profile", form: "none", required: true, dueDate: "2026-04-17", description: "Add your bio, company and headshot so we can publish your session." },
  { title: "Tell us about your hotel stay", form: "hotel", required: true, dueDate: "2026-04-24", description: "We book speaker rooms as a block — tell us which nights you need." },
  { title: "Claim your flight reimbursement", form: "flight", required: true, dueDate: "2026-05-01", description: "Send us your travel costs and where to pay them." },
  { title: "Submit A/V & logistics form", form: "av", required: true, dueDate: "2026-05-04", description: "Shirt size, A/V needs and arrival details for the stage crew." },
  { title: "Confirm your session details", form: "none", required: true, dueDate: "2026-05-06", description: "Review the public schedule and tell the program team about any corrections." },
  { title: "Upload your slide deck", form: "none", required: false, dueDate: "2026-05-11", description: "Optional, but it helps the crew test your slides in advance." },
] as const;

export const DEMO_EMAIL_TEMPLATES = [
  { key: CFP_SUBMITTED_TEMPLATE_KEY, subject: "We received your proposal for Forward 2026", trigger: "abstract.submitted",
    htmlBody: "<p>Hi {{speakerName}},</p><p>Thanks for submitting <strong>{{talkTitle}}</strong> to {{eventName}}. The program team will be in touch by email.</p>" },
  { key: "cfp-accepted", subject: "Your talk was accepted for Forward 2026 🎉", trigger: "abstract.accepted",
    htmlBody: "<p>Hi {{speakerName}},</p><p>Great news — <strong>{{talkTitle}}</strong> was accepted! Please complete your onboarding tasks in the speaker portal.</p>" },
  { key: "cfp-rejected", subject: "Update on your Forward 2026 submission", trigger: "abstract.rejected",
    htmlBody: "<p>Hi {{speakerName}},</p><p>Thank you for submitting <strong>{{talkTitle}}</strong>. Unfortunately we couldn't include it this year.</p>" },
  { key: "task-reminder", subject: "Reminder: finish your speaker tasks", trigger: "task.reminder",
    htmlBody: "<p>Hi {{speakerName}},</p><p>You have {{openTasks}} onboarding task(s) still open. Please check each task card for its individual deadline.</p>" },
  { key: "session-scheduled", subject: "Your session is scheduled", trigger: "session.scheduled",
    htmlBody: "<p>Hi {{speakerName}},</p><p><strong>{{talkTitle}}</strong> is scheduled for {{slotTime}} in {{roomName}}. A calendar invite is attached.</p>" },
] as const;

/**
 * The three one-click personas. Exported so a test can assert, in both
 * directions, that these are exactly `lib/auth.ts` `DEMO_PERSONAS` — a signed
 * session resolves to a `User` by email, so a one-sided edit would silently
 * bounce every persona button back to `/login`.
 *
 * Their addresses sit on the DELIVERABLE `greenroom-hq.com` domain (a catch-all
 * forwards it) so the demo can prove a real send. Every OTHER seeded address
 * below stays on a deliberately non-routable domain: the 40-strong speaker pool
 * (`@speakers.demo`) and the two supporting evaluators (`@greenroom.demo`) are
 * bulk fiction, and pointing them at a live mailbox would turn any future
 * broadcast into real mail.
 */
export const DEMO_SEED_PERSONAS = {
  admin: { email: "maya@greenroom-hq.com", name: "Maya Chen" },
  evaluator: { email: "ravi@greenroom-hq.com", name: "Ravi Patel" },
  speaker: { email: "sofia@greenroom-hq.com", name: "Sofia Marques" },
} as const;

const PERSONAS = DEMO_SEED_PERSONAS;

/**
 * One-time, idempotent address migration (C5): the personas moved off the
 * non-routable `@greenroom.demo` domain.
 *
 * `User.email` is `@unique` and every lookup keys on it, so simply changing the
 * constant above would make the upsert below CREATE a second row and strand the
 * original — which still owns the persona's id and therefore its global,
 * userId-keyed `SpeakerProfile` plus any membership in a non-demo event. Renaming
 * the surviving row in place keeps one identity with one id.
 */
const PERSONA_EMAIL_MIGRATIONS = [
  { from: "maya@greenroom.demo", to: PERSONAS.admin.email },
  { from: "ravi@greenroom.demo", to: PERSONAS.evaluator.email },
  { from: "sofia@greenroom.demo", to: PERSONAS.speaker.email },
] as const;

/* ==========================================================================
 * DEMO CREDENTIALS — PUBLIC BY DESIGN, NOT SECRETS
 * ==========================================================================
 * These plaintext values exist so an evaluation harness or a reviewer can sign
 * in with email + password (D-C5-6). They are demo constants for demo data and
 * this file is their ONLY home: they must never be copied into a coordination
 * file, a status note, a log line, or any response body. Nothing outside this
 * module ever sees a plaintext — the seed hashes them with scrypt
 * (`lib/password-credential.ts`) before any write.
 *
 * Rotating a password here is the whole rotation procedure: the next seed or
 * demo reset overwrites `User.passwordHash` for exactly these identities.
 * ========================================================================== */

/** One shared password for the three one-click demo personas. */
export const DEMO_PERSONA_PASSWORD = "GreenroomDemo!2026";

/**
 * The evaluation harness's fixture identities.
 *
 * `emails` carries EVERY address form the harness is known to use for one
 * person, and each form is seeded as its own credentialed `User`. That is
 * deliberate: the harness's `fixtures/sample-data.json` uses
 * `sbek-<role>@example.com` while its scenario specs type
 * `<first>.<role>@sbek-test.example.com`, and sign-in has to succeed either
 * way. The first address is the canonical one — extra forms are aliases with
 * the same name, role, and password, and hold no data of their own.
 */
export const DEMO_FIXTURE_IDENTITIES = [
  {
    name: "Jordan Alvarez",
    role: "ADMIN",
    password: "SbekTest!2027-org",
    emails: ["sbek-organizer@example.com", "jordan.organizer@sbek-test.example.com"],
  },
  {
    name: "Priya Raman",
    role: "SPEAKER",
    password: "SbekTest!2027-spk",
    emails: ["sbek-speaker@example.com", "priya.speaker@sbek-test.example.com"],
  },
  {
    name: "Sam Whitfield",
    role: "EVALUATOR",
    password: "SbekTest!2027-rev",
    emails: ["sbek-reviewer@example.com", "sam.reviewer@sbek-test.example.com"],
  },
] as const satisfies readonly {
  name: string;
  role: "ADMIN" | "EVALUATOR" | "SPEAKER";
  password: string;
  emails: readonly string[];
}[];

/** email -> plaintext, for every identity that gets a seeded credential. */
function demoCredentialPlaintext(): Map<string, string> {
  const byEmail = new Map<string, string>();
  for (const persona of Object.values(PERSONAS)) {
    byEmail.set(persona.email.toLowerCase(), DEMO_PERSONA_PASSWORD);
  }
  for (const identity of DEMO_FIXTURE_IDENTITIES) {
    for (const email of identity.emails) byEmail.set(email.toLowerCase(), identity.password);
  }
  return byEmail;
}

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

/**
 * The `RUBRIC` weights again, positionally aligned to `RUBRIC_KEYS`.
 *
 * Only the seeded-score tests read this — the app reads the weights out of the
 * stored `RUBRIC` JSON — but a drift between the two would make every asserted
 * average wrong while every test still passed, so `seed-invariants.test.ts`
 * holds the two equal.
 */
export const DEMO_RUBRIC_WEIGHTS = [1.5, 1, 1, 1] as const;

/**
 * Seeded reviewer verdicts: one entry per DECIDED proposal, in seed order —
 * indices 0-11 are the twelve ACCEPTED proposals, 12-19 the eight REJECTED
 * ones. Each entry is three rows of four scores: one row per evaluator, one
 * score per `RUBRIC_KEYS` entry.
 *
 * This replaces a formula (`base + ((rubricIndex + evaluatorIndex) % 2)`, base
 * 4 for accepted and 2 for rejected) whose arithmetic collapsed: EVERY accepted
 * proposal scored exactly 4.48 and every rejected one exactly 2.48, so the
 * review queue was two numbers repeated twenty times and no reviewer ever
 * disagreed with another. The table is deliberately shaped instead:
 *
 * - the weighted means run from about 2.0 to about 4.9 with no two identical;
 * - indices 11 and 12 straddle the accept line — the weakest accepted proposal
 *   scores BELOW the strongest rejected one, which is what a real committee
 *   decision that went beyond the rubric looks like;
 * - indices 7 and 13 are split decisions, where one reviewer is enthusiastic
 *   and another is not, so the "reviewers disagree" case is visible on screen.
 *
 * Fixed values, never randomised: a demo reset has to reproduce the same
 * screenshot.
 */
export const DEMO_REVIEW_PROFILES = [
  // --- ACCEPTED (0-11), strongest first ---
  [[5, 5, 5, 5], [5, 5, 4, 5], [5, 4, 5, 5]],
  [[5, 4, 5, 5], [5, 5, 4, 4], [4, 5, 5, 5]],
  [[5, 4, 4, 5], [4, 5, 5, 4], [5, 4, 5, 4]],
  [[4, 5, 4, 5], [5, 4, 4, 4], [4, 4, 5, 5]],
  [[5, 3, 5, 4], [4, 4, 4, 5], [5, 4, 4, 4]],
  [[4, 4, 5, 4], [5, 4, 3, 4], [4, 5, 4, 4]],
  [[4, 4, 4, 4], [4, 5, 4, 3], [5, 3, 4, 4]],
  [[5, 5, 5, 5], [2, 3, 2, 3], [4, 4, 5, 4]], // split decision
  [[4, 3, 4, 4], [4, 4, 4, 4], [3, 4, 4, 4]],
  [[4, 3, 4, 3], [3, 4, 4, 4], [4, 4, 3, 4]],
  [[3, 4, 4, 3], [4, 3, 3, 4], [3, 4, 3, 4]],
  [[3, 4, 3, 4], [4, 3, 3, 3], [3, 3, 4, 3]], // weakest accept — below the top reject
  // --- REJECTED (12-19), strongest first ---
  [[4, 3, 4, 3], [3, 4, 3, 4], [4, 3, 3, 4]], // strongest reject — above the weakest accept
  [[5, 4, 4, 4], [2, 2, 3, 2], [3, 3, 3, 3]], // split decision
  [[3, 3, 4, 3], [3, 3, 3, 3], [4, 3, 3, 2]],
  [[3, 3, 3, 3], [2, 3, 3, 3], [3, 3, 2, 3]],
  [[3, 2, 3, 3], [2, 3, 3, 2], [3, 3, 2, 2]],
  [[2, 3, 2, 3], [3, 2, 2, 3], [2, 2, 3, 2]],
  [[2, 2, 3, 2], [2, 3, 2, 2], [2, 2, 2, 3]],
  [[2, 2, 2, 2], [1, 2, 3, 2], [2, 2, 2, 2]],
] as const satisfies readonly (readonly (readonly [number, number, number, number])[])[];

/**
 * Ten distinct reviewer comments, pooled by verdict.
 *
 * The old seed wrote one of two sentences site-wide, and wrote the positive one
 * onto every accepted proposal regardless of what that reviewer had scored.
 * `demoReviewComment()` picks from the pool that matches THIS reviewer's own
 * weighted mean, so on a split decision the enthusiastic row and the sceptical
 * row read like two people who disagreed rather than one template.
 */
export const DEMO_REVIEW_COMMENTS = {
  positive: [
    "Exactly the talk this track needs — the tradeoffs are named up front and the takeaways are concrete.",
    "Clear structure with a real production story behind it. I would happily put this on the mainstage.",
    "Strong material, and the abstract already reads like a finished talk. No reservations from me.",
    "The examples are specific and it is honest about what it will not cover. Easy yes.",
  ],
  mixed: [
    "Solid material, but the abstract promises more than the slot can hold. Worth taking if the speaker narrows it.",
    "I like the topic and I think the speaker can deliver it; the takeaways are still vague enough that I hesitated.",
    "Useful and well scoped, though it overlaps with two other submissions in this category.",
  ],
  critical: [
    "The problem is real, but the abstract never says what the audience actually leaves with.",
    "Reads more like a product walkthrough than a talk — I could not find the transferable lesson.",
    "Too introductory for this audience, and the outline stops just before the hard part.",
  ],
} as const;

/** Weighted mean of one reviewer's four rubric scores, on the rubric's scale. */
export function demoWeightedMean(scores: readonly number[]): number {
  const total = DEMO_RUBRIC_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
  return scores.reduce((sum, score, i) => sum + score * DEMO_RUBRIC_WEIGHTS[i], 0) / total;
}

/**
 * The comment this reviewer leaves, chosen by their own verdict and then
 * rotated by position so one pool does not repeat a single sentence.
 */
export function demoReviewComment(scores: readonly number[], decidedIndex: number, evaluatorIndex: number): string {
  const mean = demoWeightedMean(scores);
  const pool = mean >= 4
    ? DEMO_REVIEW_COMMENTS.positive
    : mean >= 3
      ? DEMO_REVIEW_COMMENTS.mixed
      : DEMO_REVIEW_COMMENTS.critical;
  return pool[(decidedIndex + evaluatorIndex) % pool.length];
}

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

/**
 * The 40 seeded proposals, in seed order.
 *
 * Authored as an explicit table rather than generated from a prefix x subject
 * cross-product. The generator produced only 15 distinct strings for 40 rows —
 * ten titles appeared three times and five twice — so the pipeline, the review
 * queue and the public schedule all showed the same handful of talks over and
 * over, and a reviewer could not tell two rows apart. Every title here is
 * distinct; `seed-invariants.test.ts` holds that.
 *
 * Order is load-bearing twice over. `DEMO_STATUS_PLAN` walks this list in
 * order, so index 0-11 are the ACCEPTED proposals (and therefore the sessions
 * that get scheduled), and the category is `index % 4` against `CATEGORIES` —
 * so each entry is written to fit the category it will land in.
 *
 * `topic` is the noun phrase the seeded abstract body uses; it keeps the body
 * about the same subject as the title without repeating it verbatim.
 */
export const DEMO_TALKS = [
  // Category cycles AI / Platform / Product / Security every four entries.
  { title: "Scaling Vector Search Past the First Million Documents", topic: "vector search at scale" },
  { title: "Multi-Region Postgres Without the 3 a.m. Pager", topic: "multi-region Postgres" },
  { title: "Designing a System Your Designers Will Actually Use", topic: "design system adoption" },
  { title: "Zero-Trust Networks for People Who Own One Cluster", topic: "zero-trust networking" },
  { title: "Evaluating LLM Output Without a Human in the Loop", topic: "automated LLM evaluation" },
  { title: "Rethinking Event-Driven Systems After Two Outages", topic: "event-driven architecture" },
  { title: "The Hidden Cost of a Settings Page", topic: "product surface area" },
  { title: "Debugging a Breach That Never Happened", topic: "triaging false-positive security alerts" },
  { title: "Retrieval That Survives Contact With Real Documents", topic: "retrieval-augmented generation" },
  { title: "Lessons from Rebuilding Our Realtime Pipeline", topic: "realtime data pipelines" },
  { title: "Accessibility Is a Release Blocker", topic: "accessibility in the release process" },
  { title: "Secrets Rotation Without a Maintenance Window", topic: "secrets rotation" },
  { title: "Fine-Tuning Was the Wrong Answer Three Times", topic: "when not to fine-tune a model" },
  { title: "Feature Flags Are a Database You Did Not Design", topic: "feature flag hygiene" },
  { title: "Onboarding Flows That Do Not Lie", topic: "honest onboarding" },
  { title: "The Audit Log You Wish You Had Written", topic: "audit logging" },
  { title: "Prompt Regressions Are Regressions", topic: "regression testing for prompts" },
  { title: "Observability on a Budget", topic: "cost-aware observability" },
  { title: "Killing a Feature Gracefully", topic: "feature deprecation" },
  { title: "Threat Modelling in Ninety Minutes", topic: "lightweight threat modelling" },
  { title: "The Cost Curve of a Chat Feature", topic: "inference cost control" },
  { title: "The Internal Platform Nobody Asked For", topic: "internal developer platforms" },
  { title: "Research Notes Nobody Reads", topic: "making user research usable" },
  { title: "Supply Chain Risk in Your Own Build", topic: "build supply chain security" },
  { title: "Small Models, Boring Wins", topic: "small-model deployments" },
  { title: "Data Contracts Between Teams That Do Not Talk", topic: "data contracts" },
  { title: "Pricing Pages Are an Engineering Problem", topic: "pricing page implementation" },
  { title: "A Field Guide to Least Privilege", topic: "least-privilege access" },
  { title: "Guardrails That Do Not Break the Product", topic: "safety guardrails in production" },
  { title: "Edge Rendering: What Actually Got Faster", topic: "edge rendering tradeoffs" },
  { title: "One Empty State, Rewritten Eleven Times", topic: "empty-state design" },
  { title: "Passkeys in a Legacy Codebase", topic: "migrating to passkeys" },
  { title: "Teaching a Model Your Company's Vocabulary", topic: "domain adaptation" },
  { title: "Taming a Monorepo of Forty Services", topic: "monorepo build systems" },
  { title: "The Roadmap Survived First Contact", topic: "roadmap planning" },
  { title: "What Our Bug Bounty Actually Bought", topic: "running a bug bounty" },
  { title: "From Notebook to Nightly Batch", topic: "productionising a model pipeline" },
  { title: "Incident Response for Teams of Four", topic: "small-team incident response" },
  { title: "Writing Error Messages People Can Act On", topic: "error message design" },
  { title: "Tabletop Exercises That Are Not Theatre", topic: "security tabletop exercises" },
] as const satisfies readonly { title: string; topic: string }[];

/**
 * How the 40 proposals are distributed across statuses. Exported because the
 * total is a published contract — the judging docs, the install rehearsal and
 * the reset summary all say "40 abstracts" — so a test can hold it equal to
 * `DEMO_TALKS.length` instead of leaving the two to drift apart.
 */
export const DEMO_STATUS_PLAN = [
  { status: "ACCEPTED", count: 12 },
  { status: "REJECTED", count: 8 },
  { status: "UNDER_REVIEW", count: 8 },
  { status: "SUBMITTED", count: 8 },
  { status: "WITHDRAWN", count: 2 },
  { status: "DRAFT", count: 2 },
] as const satisfies readonly {
  status: "DRAFT" | "SUBMITTED" | "UNDER_REVIEW" | "ACCEPTED" | "REJECTED" | "WITHDRAWN";
  count: number;
}[];

/** Pool position of the invited keynote speaker, and the keynote's length. */
const KEYNOTE_SPEAKER_POOL_INDEX = 3;
const KEYNOTE_DURATION_MINUTES = 45;

/** The three event-local calendar days, in order. */
const SCHEDULE_DAYS = [DEMO_EVENT_DATES.startsOn, "2026-05-13", DEMO_EVENT_DATES.endsOn] as const;
const SLOT_HOURS = [9, 10, 11, 13, 14, 15] as const;
const SLOT_ROOM_ORDER = ["ballroom", "hall-a", "hall-b", "lab"] as const;
const SLOT_TRACK_ORDER = ["mainstage", "deepdive", "deepdive", "workshops"] as const;

/**
 * Format (and therefore duration) for the proposal at seed position `index`.
 *
 * Steps once per group of four so it does NOT move in lockstep with the
 * category, which is `index % 4`. Keying both off the same modulus made every
 * Security & Trust proposal a ten-minute lightning talk and every Product &
 * Design one a 90-minute workshop.
 */
export function demoFormatIndex(index: number): number {
  return Math.floor(index / FORMATS.length) % FORMATS.length;
}

export type DemoPlacement = {
  /** Position in the seeded session list; 0 is the invited keynote. */
  sessionIndex: number;
  /** Pool position of the session's primary speaker. */
  speakerPoolIndex: number;
  durationMinutes: number;
  /** Event-local calendar date. */
  day: string;
  /** Event-local start hour, on the hour. */
  hour: number;
  roomKey: string;
  trackKey: string;
};

/**
 * The whole seeded programme as a pure plan, so the placements can be checked
 * without a database.
 *
 * Exported because "the seeded programme is conflict-free and uses all three
 * days" is now a real claim: the seed used to ship a deliberate room
 * double-booking (the keynote's own slot, re-used) and to leave 14 May empty on
 * a three-day event. `seed-invariants.test.ts` walks this plan for room and
 * speaker overlaps and for day coverage.
 *
 * Sessions are indexed as the seed builds them: 0 is the invited keynote, and
 * session `k` (k >= 1) is the k-1'th ACCEPTED proposal, whose primary speaker
 * is pool position k-1.
 */
export function demoSchedulePlan(): DemoPlacement[] {
  const durationOf = (sessionIndex: number) =>
    sessionIndex === 0 ? KEYNOTE_DURATION_MINUTES : DURATIONS[demoFormatIndex(sessionIndex - 1)];
  const speakerOf = (sessionIndex: number) =>
    sessionIndex === 0 ? KEYNOTE_SPEAKER_POOL_INDEX : sessionIndex - 1;

  const placements: DemoPlacement[] = [];
  for (let i = 0; i < 10; i++) {
    const roomI = i % SLOT_ROOM_ORDER.length;
    placements.push({
      sessionIndex: i,
      speakerPoolIndex: speakerOf(i),
      durationMinutes: durationOf(i),
      day: i < 6 ? SCHEDULE_DAYS[0] : SCHEDULE_DAYS[1],
      hour: SLOT_HOURS[i % SLOT_HOURS.length],
      roomKey: SLOT_ROOM_ORDER[roomI],
      trackKey: SLOT_TRACK_ORDER[roomI],
    });
  }
  // The eleventh placement closes the event on DAY 3.
  //
  // It used to be a deliberate double-booking — the same room and time as the
  // opening keynote — seeded so the admin Conflicts view had something in it.
  // That is superseded: the walkthrough demonstrates the refusal live by trying
  // an occupied slot, so the seeded programme no longer has to ship a mistake,
  // and a Conflicts view reading zero is the honest result.
  //
  // Day 3 being empty on a three-day event was the other half of the same
  // problem. Moving this placement fixes both and keeps the count at 11.
  //
  // Room and hour are not free choices: the walkthrough is scripted against
  // this programme and needs Hall A on 12 May at 10:00 to stay OCCUPIED (the
  // refusal it demonstrates) and the Grand Ballroom on 14 May to stay FREE (the
  // clean placement that follows it). Hall B in the afternoon satisfies both.
  placements.push({
    sessionIndex: 10,
    speakerPoolIndex: speakerOf(10),
    durationMinutes: durationOf(10),
    day: SCHEDULE_DAYS[2],
    hour: 13,
    roomKey: "hall-b",
    trackKey: "deepdive",
  });
  return placements;
}

/**
 * Distinct profiles for the ten speakers who reach the public gallery.
 *
 * `/speakers` lists exactly the speakers on a SCHEDULED, published session, and
 * the seeded schedule places the keynote plus the first ten accepted proposals
 * — whose primary speakers are pool positions 0-9. Every one of them used to
 * carry the same "Staff Engineer at Acme Labs" and the same one-line bio, so
 * the gallery read as one person copied ten times.
 *
 * Positional: entry `i` is applied to speaker pool position `i` (0 is Sofia
 * Marques, the speaker persona). Nothing here names a person, so a reordering
 * of the pool cannot attach the wrong name to a bio — the bio sentence is
 * built from the speaker's own `name` plus the `bio` tail below.
 *
 * Each entry also fits the category its owner submits to: pool position `i`
 * submits the proposal at index `i`, whose category is `i % 4`, so the search
 * engineer is on the AI proposal and the SRE on the platform one.
 *
 * Companies are invented. Every seeded speaker address is on the non-routable
 * `@speakers.demo` domain and none of these organisations exists.
 */
export const HEADLINE_SPEAKER_PROFILES = [
  { jobTitle: "Principal Engineer", company: "Foxglove Labs",
    bio: "leads the search platform team at Foxglove Labs and has spent the last six years making retrieval boring." },
  { jobTitle: "Staff Site Reliability Engineer", company: "Ironwood Bank",
    bio: "keeps a regulated payments platform online at Ironwood Bank, and has the incident reviews to prove it." },
  { jobTitle: "Design Systems Lead", company: "Cobalt Ferry",
    bio: "owns the component library every Cobalt Ferry product ships on, and negotiates the exceptions to it." },
  { jobTitle: "VP of Engineering", company: "Lumeria",
    bio: "has grown Lumeria's engineering organisation from nine people to two hundred, and writes about what broke on the way." },
  { jobTitle: "Director of Applied ML", company: "Petrichor Health",
    bio: "runs the applied machine learning group at Petrichor Health, where a wrong answer is a clinical problem and not a metric." },
  { jobTitle: "Principal Platform Engineer", company: "Saltmarsh Media",
    bio: "rebuilt Saltmarsh Media's publishing backbone after two outages nobody wants described in a conference bio." },
  { jobTitle: "Principal Product Manager", company: "Tessellate",
    bio: "has shipped and then deliberately removed more Tessellate features than most people have launched." },
  { jobTitle: "Security Operations Lead", company: "Bluewhistle",
    bio: "runs detection and response at Bluewhistle and spends more time on false positives than on real intrusions." },
  { jobTitle: "Head of Search & Discovery", company: "Meridian Freight",
    bio: "makes Meridian Freight's document search work against the paperwork freight actually generates." },
  { jobTitle: "Staff Engineer", company: "Kestrel Analytics",
    bio: "builds the realtime ingest path at Kestrel Analytics and has migrated it, twice, without a maintenance window." },
] as const;

/**
 * Everyone else in the 40-strong pool. Rotated on co-prime cycle lengths
 * (11 companies x 7 titles) so the supporting cast in the admin speaker list
 * is not visibly one row repeated either; the bio sentence carries the
 * speaker's own name, so no two are identical.
 */
const SUPPORTING_COMPANIES = [
  "Halcyon Systems", "Cindermark", "Vantage Loom", "Tidewater Logistics", "Marlowe & Fern",
  "Quillfeather", "Ashgrove Energy", "Steepwater", "Nine Rivers Media", "Baytree Robotics", "Oxbow Financial",
] as const;
const SUPPORTING_TITLES = [
  "Senior Software Engineer", "Engineering Manager", "Platform Engineer", "Product Designer",
  "Data Engineer", "Security Engineer", "Developer Advocate",
] as const;
const SUPPORTING_BIOS = [
  "has been building and operating production systems for a decade and speaks about the parts that do not fit in a blog post.",
  "works on the unglamorous middle of the stack and enjoys explaining it to people who would rather not think about it.",
  "spends most of the week on migrations nobody asked for, and the rest writing down what they cost.",
  "joined a small team, watched it become a large one, and has opinions about which parts of that were avoidable.",
  "is a first-time conference speaker bringing a case study straight out of last quarter.",
] as const;

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
  // scrypt is deliberately expensive, so derive every credential BEFORE the
  // transaction opens. Hashing inside it would hold the advisory lock for
  // hundreds of milliseconds of pure CPU for no reason.
  const credentials = new Map<string, string>();
  for (const [email, plaintext] of demoCredentialPlaintext()) {
    credentials.set(email, await hashPassword(plaintext));
  }
  return prisma.$transaction(
    async (tx) => {
      // Serialize against any other seeding process before touching a row.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SEED_LOCK_KEY}::bigint)`;
      return seedWithin(tx, credentials);
    },
    { maxWait: 60_000, timeout: 300_000 },
  );
}

async function seedWithin(
  db: Prisma.TransactionClient,
  credentials: ReadonlyMap<string, string>,
): Promise<SeedSummary> {
  const eventId = DEMO_EVENT.id;

  // --- 1. Reset all event-scoped data (idempotent reseed) --------------------
  // Sequential deletes: we are already inside one transaction, and child rows
  // must go before their parents.
  await db.reviewerInvite.deleteMany({ where: { eventId } });
  await db.publicSubmissionRateBucket.deleteMany({ where: { eventId } });
  await db.importJob.deleteMany({ where: { eventId } });
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
  // These are authored as the event's Los Angeles calendar boundaries, then
  // stored as UTC instants so every viewer sees May 12–14 in event time.
  const startsAt = new Date(zonedToUtcIso(DEMO_EVENT_DATES.startsOn, "00:00", DEMO_EVENT.timezone));
  const endsAt = new Date(zonedToUtcIso(DEMO_EVENT_DATES.endsOn, "23:59", DEMO_EVENT.timezone));
  await db.event.upsert({
    where: { id: eventId },
    update: { name: DEMO_EVENT.name, slug: DEMO_EVENT.slug, timezone: DEMO_EVENT.timezone, startsAt, endsAt },
    create: { id: eventId, name: DEMO_EVENT.name, slug: DEMO_EVENT.slug, timezone: DEMO_EVENT.timezone, startsAt, endsAt },
  });

  // --- 3. Persona + evaluator + speaker users --------------------------------
  // Global `User` rows are upserted, never deleted and recreated, so ids and
  // any non-demo relations survive. A seeded credential is (re)applied on both
  // create and update: the documented demo password must work after every
  // reset, and rotating the constant above must actually take effect. Users
  // without a seeded credential keep whatever `passwordHash` they had — the
  // update simply omits the field.
  async function upsertUser(email: string, name: string): Promise<string> {
    const lower = email.toLowerCase();
    const passwordHash = credentials.get(lower);
    const user = await db.user.upsert({
      where: { email: lower },
      update: { name, ...(passwordHash ? { passwordHash } : {}) },
      create: { email: lower, name, ...(passwordHash ? { passwordHash } : {}) },
    });
    return user.id;
  }

  // Rename any surviving pre-C5 persona row BEFORE the upserts, so the upsert
  // finds the migrated row instead of creating a duplicate. Idempotent three
  // ways: a fresh database has no legacy row, an already-migrated database has
  // no legacy row, and if BOTH addresses somehow exist we leave the legacy row
  // untouched rather than delete it — this seed never removes a `User`. Such a
  // leftover is inert: the reset above wipes every demo-event `EventMember`, and
  // only the migrated ids are re-added, so an orphan resolves to no membership
  // and `getResolvedSession()` grants it nothing.
  for (const { from, to } of PERSONA_EMAIL_MIGRATIONS) {
    const legacy = await db.user.findUnique({ where: { email: from }, select: { id: true } });
    if (!legacy) continue;
    const existing = await db.user.findUnique({ where: { email: to }, select: { id: true } });
    if (existing) continue;
    await db.user.update({ where: { id: legacy.id }, data: { email: to } });
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

  // Harness fixture identities (D-C5-6 ruling 3). Created idempotently by
  // email — `upsertUser` never deletes a row, so an identity that already
  // exists keeps its id and everything hanging off it.
  //
  // They are deliberately NOT appended to `speakerUsers`: that list drives the
  // deterministic abstract/session/task distribution below, and inserting into
  // it would shift every seeded index. A fixture speaker therefore starts with
  // an empty portal, which is the state the harness's own scenarios begin from.
  const fixtureUsers: { id: string; name: string; email: string; role: "ADMIN" | "EVALUATOR" | "SPEAKER" }[] = [];
  for (const identity of DEMO_FIXTURE_IDENTITIES) {
    for (const email of identity.emails) {
      fixtureUsers.push({
        id: await upsertUser(email, identity.name),
        name: identity.name,
        email: email.toLowerCase(),
        role: identity.role,
      });
    }
  }

  // --- 4. Memberships --------------------------------------------------------
  // Note on the fixture rows, so this is not re-litigated: the admin reviewer
  // roster (`getEvaluationSetup`, lib/data/reads.ts) lists every EventMember
  // whose role is EVALUATOR **or ADMIN**, so the four fixture memberships below
  // — Jordan Alvarez and Sam Whitfield, each on two address forms — show up
  // there with nothing assigned. That is untidy but load-bearing: D-C5-6 seeds
  // those credentials so the harness can sign in as either address form, and
  // the membership is what gives that session its role. Drop them and the
  // fixture login lands on a page it has no permission for. The duplication is
  // not accidental either — the harness types `sbek-<role>@example.com` in one
  // place and `<first>.<role>@sbek-test.example.com` in another, so BOTH forms
  // need the role. Nothing to prune here without breaking the harness.
  const memberships: Prisma.EventMemberCreateManyInput[] = [
    { eventId, userId: adminId, role: "ADMIN" },
    ...evaluatorIds.map((userId) => ({ eventId, userId, role: "EVALUATOR" as const })),
    ...speakerUsers.map((s) => ({ eventId, userId: s.id, role: "SPEAKER" as const })),
    ...fixtureUsers.map((f) => ({ eventId, userId: f.id, role: f.role })),
  ];
  await db.eventMember.createMany({ data: memberships, skipDuplicates: true });

  // --- 5. Speaker profiles ----------------------------------------------------
  // `SpeakerProfile` is global (keyed by userId), so it is not covered by the
  // event-scoped wipe above. Reset the demo fields explicitly on update as well
  // as create, otherwise edits made through the portal survive a reseed and the
  // demo drifts (observed: a smoke-test job title persisting across seeds).
  const profileTargets = [...speakerUsers, ...fixtureUsers.filter((f) => f.role === "SPEAKER")];
  for (const [i, s] of profileTargets.entries()) {
    const headline = HEADLINE_SPEAKER_PROFILES[i];
    const persona = headline ?? {
      jobTitle: SUPPORTING_TITLES[i % SUPPORTING_TITLES.length],
      company: SUPPORTING_COMPANIES[i % SUPPORTING_COMPANIES.length],
      bio: SUPPORTING_BIOS[i % SUPPORTING_BIOS.length],
    };
    const demoProfile = {
      bio: `${s.name} ${persona.bio}`,
      company: persona.company,
      jobTitle: persona.jobTitle,
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
      //
      // KNOWN TENSION, deliberately left: this window is relative to the reseed
      // while the rest of the demo timeline is fixed in 2026 (submissions in
      // February, reviews in March, onboarding in April, the event on 12-14
      // May). Once wall-clock time passes the event, the landing page reads
      // "closes" on a date AFTER the conference. Both alternatives are worse:
      // a close date before the event is in the past, which shuts the public
      // form and breaks the golden-path walkthrough and every smoke that
      // submits to it — the exact regression the request above was filed for.
      // Making it coherent means moving the whole demo timeline forward, which
      // is an Architect-level change: `DEMO_EVENT_DATES`, the six task due
      // dates, the review round, the schedule days and the verbatim dates in
      // the video script and judging docs all move together. Until then the
      // form stays OPEN, because a demo that cannot accept a submission is a
      // broken demo and a date that reads oddly is not.
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

  // Task forms the director named as must-haves. They are ordinary FormConfigs
  // so they render, validate and store through exactly the same machinery as
  // the CFP form; `published: false` keeps them off the public /cfp routes
  // while remaining fully usable inside a task.
  const hotelForm = await db.formConfig.create({
    data: {
      eventId,
      name: "Hotel stay",
      slug: "hotel-stay",
      welcomeText: "We hold a block of speaker rooms — tell us what you need.",
      thankYouText: "Thanks — the travel team will confirm your booking by email.",
      minSpeakers: 1,
      maxSpeakers: 1,
      maxBioLength: 1000,
      published: false,
      fields: {
        create: [
          { key: "needs_hotel", label: "Do you need a hotel room?", type: "SELECT", required: true, sortOrder: 0,
            helpText: "We cover two nights for speakers travelling from outside the Bay Area.",
            options: [{ label: "Yes, please book a room", value: "yes" }, { label: "No, I'll arrange my own", value: "no" }] },
          { key: "check_in", label: "Check-in date", type: "SHORT_TEXT", required: true, sortOrder: 1,
            helpText: "For example: 11 May 2026.",
            conditionalLogic: { match: "all", rules: [{ fieldKey: "needs_hotel", operator: "equals", value: "yes" }] } },
          { key: "check_out", label: "Check-out date", type: "SHORT_TEXT", required: true, sortOrder: 2,
            conditionalLogic: { match: "all", rules: [{ fieldKey: "needs_hotel", operator: "equals", value: "yes" }] } },
          { key: "room_preference", label: "Room preference", type: "SELECT", required: false, sortOrder: 3,
            options: [{ label: "No preference", value: "any" }, { label: "Quiet floor", value: "quiet" }, { label: "Accessible room", value: "accessible" }],
            conditionalLogic: { match: "all", rules: [{ fieldKey: "needs_hotel", operator: "equals", value: "yes" }] } },
          { key: "hotel_notes", label: "Anything else we should know?", type: "LONG_TEXT", required: false, sortOrder: 4 },
        ],
      },
    },
  });

  const flightForm = await db.formConfig.create({
    data: {
      eventId,
      name: "Flight reimbursement",
      slug: "flight-reimbursement",
      welcomeText: "Send us your travel costs and we'll reimburse them after the event.",
      thankYouText: "Got it — finance will process this within 30 days of the event.",
      minSpeakers: 1,
      maxSpeakers: 1,
      maxBioLength: 1000,
      published: false,
      fields: {
        create: [
          { key: "claiming_travel", label: "Are you claiming travel costs?", type: "SELECT", required: true, sortOrder: 0,
            options: [{ label: "Yes", value: "yes" }, { label: "No, my employer covers it", value: "no" }] },
          { key: "departure_city", label: "Departure city", type: "SHORT_TEXT", required: true, sortOrder: 1,
            conditionalLogic: { match: "all", rules: [{ fieldKey: "claiming_travel", operator: "equals", value: "yes" }] } },
          { key: "amount", label: "Total amount (USD)", type: "NUMBER", required: true, sortOrder: 2,
            helpText: "Economy fares up to $800 are reimbursed in full.",
            conditionalLogic: { match: "all", rules: [{ fieldKey: "claiming_travel", operator: "equals", value: "yes" }] } },
          { key: "receipt_url", label: "Link to your receipt", type: "URL", required: true, sortOrder: 3,
            helpText: "A shared link to a PDF or photo is fine.",
            conditionalLogic: { match: "all", rules: [{ fieldKey: "claiming_travel", operator: "equals", value: "yes" }] } },
          { key: "payee_email", label: "Where should we send confirmation?", type: "SHORT_TEXT", required: true, sortOrder: 4,
            conditionalLogic: { match: "all", rules: [{ fieldKey: "claiming_travel", operator: "equals", value: "yes" }] } },
        ],
      },
    },
  });

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
  const STATUS_PLAN = DEMO_STATUS_PLAN;

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
      // Format must NOT key off `idx % 4` — the category already does, so the
      // two moved in lockstep and every Security & Trust proposal was a
      // ten-minute lightning talk while every Product one was a 90-minute
      // workshop. Stepping once per group of four decorrelates them, so all
      // sixteen category/format pairs appear.
      const fmt = demoFormatIndex(idx);
      const talk = DEMO_TALKS[idx % DEMO_TALKS.length];
      const title = talk.title;
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
          abstract: `A practical, example-driven session on ${talk.topic}. Attendees leave with patterns they can apply on Monday.`,
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
  // `abstracts` is built in `STATUS_PLAN` order, so the decided rows come
  // first and in the same order as `DEMO_REVIEW_PROFILES`: twelve ACCEPTED,
  // then eight REJECTED, then the UNDER_REVIEW ones, which score nothing.
  let decidedIndex = 0;
  for (const a of reviewed) {
    const teamKey = CATEGORIES.find((c) => c.key === a.categoryKey)?.teamKey ?? null;
    const decided = a.status !== "UNDER_REVIEW";
    const profile = decided ? DEMO_REVIEW_PROFILES[decidedIndex % DEMO_REVIEW_PROFILES.length] : null;
    for (const [ei, evalId] of evaluatorIds.entries()) {
      await db.reviewAssignment.create({
        data: {
          planId: plan.id, abstractId: a.id, evaluatorId: evalId, teamKey,
          status: decided ? "COMPLETED" : "IN_PROGRESS",
          completedAt: decided ? new Date("2026-03-15T00:00:00.000Z") : null,
        },
      });
      if (profile) {
        const scores = profile[ei % profile.length];
        // One comment per reviewer, on the first rubric row, matched to what
        // that reviewer actually scored.
        const comment = demoReviewComment(scores, decidedIndex, ei);
        for (const [ri, key] of RUBRIC_KEYS.entries()) {
          await db.reviewScore.create({
            data: { planId: plan.id, abstractId: a.id, evaluatorId: evalId, rubricKey: key, score: scores[ri],
              comment: ri === 0 ? comment : null },
          });
        }
      }
    }
    if (decided) decidedIndex++;
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
      format: `Keynote (${KEYNOTE_DURATION_MINUTES} min)`, durationMinutes: KEYNOTE_DURATION_MINUTES,
      speakers: { create: [{ userId: speakerUsers[KEYNOTE_SPEAKER_POOL_INDEX].id, isPrimary: true }] },
    },
  });
  sessions.unshift({
    id: keynote.id, title: keynote.title, durationMinutes: KEYNOTE_DURATION_MINUTES,
    primarySpeakerId: speakerUsers[KEYNOTE_SPEAKER_POOL_INDEX].id,
  });

  // --- 11. Schedule 11 of the 13 sessions, across all three days ------------
  // The geometry lives in `demoSchedulePlan()` so it can be checked for room
  // and speaker overlaps without a database; this loop only resolves ids and
  // converts each event-local day/hour to a UTC instant.
  for (const placement of demoSchedulePlan()) {
    const s = sessions[placement.sessionIndex];
    if (!s) continue;
    const startsAtSlot = new Date(
      zonedToUtcIso(placement.day, `${String(placement.hour).padStart(2, "0")}:00`, DEMO_EVENT.timezone),
    );
    const endsAtSlot = new Date(startsAtSlot.getTime() + s.durationMinutes * 60_000);
    await db.scheduleSlot.create({
      data: {
        eventId, sessionId: s.id,
        roomId: roomIds[placement.roomKey], trackId: trackIds[placement.trackKey],
        startsAt: startsAtSlot, endsAt: endsAtSlot,
      },
    });
  }

  // --- 12. Onboarding tasks (incl. form-in-task) + per-speaker status --------
  // Hotel stay and flight reimbursement are the director's named must-have
  // examples (requirements delta #2, answer 5): both are FORMS a speaker fills
  // in, not checkboxes, because the programme team needs the answers.
  const formIds = { none: null, hotel: hotelForm.id, flight: flightForm.id, av: avForm.id } as const;
  const taskDefs = DEMO_TASK_SCHEDULE.map((task) => ({ ...task, formConfigId: formIds[task.form] }));
  const tasks = [];
  for (const [i, t] of taskDefs.entries()) {
    const row = await db.onboardingTask.create({
      data: { eventId, title: t.title, required: t.required, formConfigId: t.formConfigId, sortOrder: i,
        dueAt: new Date(zonedToUtcIso(t.dueDate, "23:59", DEMO_EVENT.timezone)),
        description: t.description },
    });
    tasks.push(row);
  }

  // Assign tasks to every confirmed session speaker.
  const sessionSpeakerIds = Array.from(new Set(sessions.map((s) => s.primarySpeakerId)));
  const taskStatuses = ["COMPLETED", "COMPLETED", "IN_PROGRESS", "TODO", "TODO", "TODO"] as const;

  // Answers must match each form's own field keys, otherwise a "completed"
  // task would render an empty form when a judge opens it.
  const seededResponses: Record<string, Record<string, unknown>> = {
    [avForm.id]: { shirt_size: "m", av_needs: "Wireless lav mic", arrival_date: "2026-05-11" },
    [hotelForm.id]: { needs_hotel: "yes", check_in: "11 May 2026", check_out: "13 May 2026", room_preference: "quiet", hotel_notes: "" },
    [flightForm.id]: { claiming_travel: "yes", departure_city: "Lisbon", amount: 720, receipt_url: "https://example.com/receipt.pdf", payee_email: PERSONAS.speaker.email },
  };

  for (const userId of sessionSpeakerIds) {
    for (const [i, task] of tasks.entries()) {
      // Sofia (speakerPrimaryId) is the demo speaker: profile, hotel form and
      // A/V form done, flight reimbursement still owed — so the portal shows a
      // completed task form to review AND an outstanding one to fill in.
      const status = userId === speakerPrimaryId
        ? (i === 0 || i === 1 || i === 3 ? "COMPLETED" : "TODO")
        : taskStatuses[(i + sessionSpeakerIds.indexOf(userId)) % taskStatuses.length];
      await db.speakerTask.create({
        data: {
          taskId: task.id, userId, status,
          completedAt: status === "COMPLETED" ? new Date("2026-04-01T00:00:00.000Z") : null,
          responses: task.formConfigId && status === "COMPLETED"
            ? (seededResponses[task.formConfigId] as never)
            : undefined,
        },
      });
    }
  }

  // --- 13. Email templates + resource wiki ----------------------------------
  for (const t of DEMO_EMAIL_TEMPLATES) {
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
    forms: 4,
    abstracts: abstractCount,
    sessions: sessionCount,
    scheduleSlots: slotCount,
    onboardingTasks: taskCount,
    speakerTasks: speakerTaskCount,
    emailTemplates: DEMO_EMAIL_TEMPLATES.length,
    resources: resources.length,
  };
}
