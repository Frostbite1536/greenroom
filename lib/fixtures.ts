/**
 * Typed demo fixtures for the frontend golden-path screens.
 *
 * These mirror the locked Prisma models and `types/api.ts` contracts so screens
 * render realistic data before the backend APIs land. Shapes are intentionally
 * view-model friendly (denormalised speaker names, precomputed averages) and are
 * safe to swap for API responses without changing component props.
 */
import { z } from "zod";
import {
  formFieldTypeSchema,
  abstractStatusSchema,
  conditionalRuleSchema,
} from "@/types/api";

// Inferred locally from the Architect-owned Zod contracts in types/api.ts.
export type FormFieldType = z.infer<typeof formFieldTypeSchema>;
export type AbstractStatus = z.infer<typeof abstractStatusSchema>;

export type ConditionalLogic = {
  match: "all" | "any";
  rules: z.infer<typeof conditionalRuleSchema>[];
};

export type FieldType = z.infer<typeof formFieldTypeSchema>;
export type Status = z.infer<typeof abstractStatusSchema>;

export type FormFieldModel = {
  id: string;
  key: string;
  label: string;
  helpText?: string;
  type: FieldType;
  required: boolean;
  options?: { label: string; value: string }[];
  conditionalLogic?: ConditionalLogic;
  locked?: boolean;
};

export type FormModel = {
  id: string;
  eventId: string;
  name: string;
  slug: string;
  externalTitle: string;
  welcomeHeading: string;
  welcomeText: string;
  thankYouText: string;
  opensAt?: string;
  closesAt?: string;
  submissionLimit?: number;
  minSpeakers: number;
  maxSpeakers: number;
  maxBioLength: number;
  published: boolean;
  submissionCount: number;
  draftCount: number;
  createdAt: string;
  fields: FormFieldModel[];
};

export type CategoryModel = {
  id: string;
  name: string;
  defaultTeamKey: string;
};

export const DEMO_EVENT_ID = "demo-event";

export const CATEGORIES: CategoryModel[] = [
  { id: "cat_appliedai", name: "Applied AI", defaultTeamKey: "team-ai" },
  { id: "cat_infra", name: "Infrastructure & Scaling", defaultTeamKey: "team-infra" },
  { id: "cat_product", name: "AI Product & UX", defaultTeamKey: "team-product" },
  { id: "cat_research", name: "Research & Frontier", defaultTeamKey: "team-research" },
];

const CFP_FIELDS: FormFieldModel[] = [
  {
    id: "fld_title",
    key: "title",
    label: "Session title",
    helpText: "A crisp, compelling title (this is public if accepted).",
    type: "SHORT_TEXT",
    required: true,
    locked: true,
  },
  {
    id: "fld_abstract",
    key: "abstract",
    label: "Abstract",
    helpText: "What will attendees learn? 150–300 words works best.",
    type: "LONG_TEXT",
    required: true,
    locked: true,
  },
  {
    id: "fld_format",
    key: "format",
    label: "Session format",
    type: "SELECT",
    required: true,
    options: [
      { label: "Talk (30 min)", value: "talk-30" },
      { label: "Talk (45 min)", value: "talk-45" },
      { label: "Workshop (90 min)", value: "workshop-90" },
      { label: "Lightning (10 min)", value: "lightning-10" },
    ],
  },
  {
    id: "fld_level",
    key: "audience_level",
    label: "Audience level",
    type: "SELECT",
    required: true,
    options: [
      { label: "Beginner", value: "beginner" },
      { label: "Intermediate", value: "intermediate" },
      { label: "Advanced", value: "advanced" },
    ],
  },
  {
    id: "fld_prereq",
    key: "workshop_prereqs",
    label: "Workshop prerequisites",
    helpText: "Only asked for workshops — what should attendees install or know?",
    type: "LONG_TEXT",
    required: true,
    conditionalLogic: {
      match: "all",
      rules: [{ fieldKey: "format", operator: "equals", value: "workshop-90" }],
    },
  },
  {
    id: "fld_recorded",
    key: "consent_recording",
    label: "I consent to my session being recorded and published.",
    type: "CHECKBOX",
    required: true,
  },
  {
    id: "fld_repo",
    key: "code_url",
    label: "Code / demo repository",
    helpText: "Optional link to a repo or live demo.",
    type: "URL",
    required: false,
  },
];

export const FORMS: FormModel[] = [
  {
    id: "form_cfp2026",
    eventId: DEMO_EVENT_ID,
    name: "Forward 2026 — Call for Speakers",
    slug: "forward-2026-cfp",
    externalTitle: "Speak at Forward 2026",
    welcomeHeading: "Welcome to Forward 2026",
    welcomeText:
      "Forward 2026 brings together builders, researchers, and operators shaping applied AI. Sessions on the agenda are selected from these submissions. Submit your proposal below — you can save a draft any time before the window closes.",
    thankYouText:
      "Thanks for your submission! Track its status any time from your speaker portal. If accepted, you'll receive onboarding tasks to complete.",
    opensAt: "2026-06-01T00:00:00.000Z",
    closesAt: "2026-09-15T06:59:00.000Z",
    submissionLimit: 3,
    minSpeakers: 1,
    maxSpeakers: 4,
    maxBioLength: 600,
    published: true,
    submissionCount: 128,
    draftCount: 17,
    createdAt: "2026-05-20T00:00:00.000Z",
    fields: CFP_FIELDS,
  },
  {
    id: "form_sponsor",
    eventId: DEMO_EVENT_ID,
    name: "Sponsor Session Intake",
    slug: "forward-2026-sponsor",
    externalTitle: "Sponsor Session Submission",
    welcomeHeading: "Sponsor sessions",
    welcomeText: "Confirmed sponsors can submit a guaranteed session for the agenda.",
    thankYouText: "Received — our team will confirm scheduling details shortly.",
    minSpeakers: 1,
    maxSpeakers: 2,
    maxBioLength: 400,
    published: true,
    submissionCount: 6,
    draftCount: 0,
    createdAt: "2026-06-10T00:00:00.000Z",
    fields: CFP_FIELDS.slice(0, 3),
  },
  {
    id: "form_draft",
    eventId: DEMO_EVENT_ID,
    name: "Workshop Track (draft)",
    slug: "forward-2026-workshops",
    externalTitle: "Workshop proposals",
    welcomeHeading: "Workshops",
    welcomeText: "Hands-on, 90-minute deep dives.",
    thankYouText: "Thanks!",
    minSpeakers: 1,
    maxSpeakers: 3,
    maxBioLength: 500,
    published: false,
    submissionCount: 0,
    draftCount: 0,
    createdAt: "2026-07-01T00:00:00.000Z",
    fields: CFP_FIELDS.slice(0, 5),
  },
];

export function getForm(id: string): FormModel | undefined {
  return FORMS.find((f) => f.id === id || f.slug === id);
}

// ---- Abstracts pipeline ---------------------------------------------------

export type AbstractSpeakerModel = { name: string; email: string; isPrimary: boolean };

export type AbstractModel = {
  id: string;
  title: string;
  abstract: string;
  status: Status;
  format: string;
  categoryId: string;
  categoryName: string;
  speakers: AbstractSpeakerModel[];
  submittedAt?: string;
  avgScore?: number;
  reviewsComplete: number;
  reviewsTotal: number;
  source: string;
};

const SPEAKER_POOL: AbstractSpeakerModel[] = [
  { name: "Sofia Marques", email: "sofia@greenroom.demo", isPrimary: true },
  { name: "Devon Wills", email: "devon@example.com", isPrimary: true },
  { name: "Amara Okafor", email: "amara@example.com", isPrimary: true },
  { name: "Liang Wei", email: "liang@example.com", isPrimary: true },
  { name: "Priya Nair", email: "priya@example.com", isPrimary: true },
  { name: "Marco Rossi", email: "marco@example.com", isPrimary: true },
];

function speaker(i: number, co?: number): AbstractSpeakerModel[] {
  const list = [SPEAKER_POOL[i % SPEAKER_POOL.length]];
  if (co !== undefined) {
    list.push({ ...SPEAKER_POOL[co % SPEAKER_POOL.length], isPrimary: false });
  }
  return list;
}

const ABSTRACT_TITLES: [string, string, AbstractStatus, number, number, number][] = [
  ["Shipping Agents That Don't Hallucinate in Production", "cat_appliedai", "ACCEPTED", 4.6, 3, 3],
  ["Vector Search at 10B Embeddings: A Cost Story", "cat_infra", "ACCEPTED", 4.3, 3, 3],
  ["Designing Trust: UX Patterns for AI Copilots", "cat_product", "UNDER_REVIEW", 3.8, 2, 3],
  ["Fine-tuning Small Models Beats Prompting Big Ones", "cat_research", "UNDER_REVIEW", 4.1, 2, 3],
  ["Observability for LLM Pipelines", "cat_infra", "SUBMITTED", 0, 0, 3],
  ["From RAG to Riches: Retrieval Evaluation in Practice", "cat_appliedai", "SUBMITTED", 0, 0, 3],
  ["The Product Manager's Guide to Eval-Driven Development", "cat_product", "UNDER_REVIEW", 3.2, 3, 3],
  ["Distributed Training on a Startup Budget", "cat_infra", "REJECTED", 2.4, 3, 3],
  ["Multimodal Agents for Field Operations", "cat_appliedai", "ACCEPTED", 4.8, 3, 3],
  ["Guardrails, Not Handcuffs: Safe Tool Use", "cat_research", "SUBMITTED", 0, 0, 3],
  ["Prompt Caching Saved Us $2M", "cat_infra", "UNDER_REVIEW", 4.0, 1, 3],
  ["A Practical Taxonomy of Agent Failures", "cat_research", "DRAFT", 0, 0, 0],
];

export const ABSTRACTS: AbstractModel[] = ABSTRACT_TITLES.map(
  ([title, categoryId, status, avg, done, total], i) => {
    const cat = CATEGORIES.find((c) => c.id === categoryId)!;
    return {
      id: `abs_${i + 1}`,
      title,
      abstract:
        "A practical, example-driven session drawn from real production experience, with takeaways attendees can apply the next day.",
      status,
      format: i % 4 === 2 ? "Workshop (90 min)" : "Talk (30 min)",
      categoryId,
      categoryName: cat.name,
      speakers: speaker(i, i % 3 === 0 ? i + 1 : undefined),
      submittedAt: status === "DRAFT" ? undefined : `2026-08-${String((i % 27) + 1).padStart(2, "0")}T18:30:00.000Z`,
      avgScore: avg || undefined,
      reviewsComplete: done,
      reviewsTotal: total,
      source: "Forward 2026 — Call for Speakers",
    };
  },
);

export const ABSTRACT_STATUS_META: Record<Status, { label: string; tone: string }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  SUBMITTED: { label: "Submitted", tone: "info" },
  UNDER_REVIEW: { label: "Under review", tone: "warn" },
  ACCEPTED: { label: "Accepted", tone: "good" },
  REJECTED: { label: "Declined", tone: "bad" },
  WITHDRAWN: { label: "Withdrawn", tone: "neutral" },
};

// ---- Evaluation -----------------------------------------------------------

export type RubricCriterion = {
  key: string;
  label: string;
  description?: string;
  min: number;
  max: number;
  weight: number;
};

export type EvaluationPlanModel = {
  id: string;
  name: string;
  ordinal: number;
  isBlind: boolean;
  rubric: RubricCriterion[];
  assignedCount: number;
  completedCount: number;
};

export const EVALUATION_PLAN: EvaluationPlanModel = {
  id: "plan_round1",
  name: "Round 1 — Program Committee",
  ordinal: 1,
  isBlind: true,
  assignedCount: 12,
  completedCount: 7,
  rubric: [
    { key: "relevance", label: "Relevance", description: "Fit for our audience and theme.", min: 1, max: 5, weight: 1 },
    { key: "originality", label: "Originality", description: "Fresh angle, not a rehash.", min: 1, max: 5, weight: 1 },
    { key: "clarity", label: "Clarity", description: "Is the proposal well-structured and clear?", min: 1, max: 5, weight: 1 },
    { key: "speaker", label: "Speaker credibility", description: "Track record and depth.", min: 1, max: 5, weight: 0.5 },
  ],
};

export type QueueItem = {
  abstractId: string;
  title: string;
  categoryName: string;
  teamKey: string;
  status: "ASSIGNED" | "IN_PROGRESS" | "COMPLETED";
  myScores?: Record<string, number>;
};

export const REVIEW_QUEUE: QueueItem[] = [
  { abstractId: "abs_5", title: ABSTRACTS[4].title, categoryName: "Infrastructure & Scaling", teamKey: "team-infra", status: "ASSIGNED" },
  { abstractId: "abs_6", title: ABSTRACTS[5].title, categoryName: "Applied AI", teamKey: "team-ai", status: "ASSIGNED" },
  { abstractId: "abs_3", title: ABSTRACTS[2].title, categoryName: "AI Product & UX", teamKey: "team-product", status: "IN_PROGRESS", myScores: { relevance: 4, originality: 3 } },
  { abstractId: "abs_10", title: ABSTRACTS[9].title, categoryName: "Research & Frontier", teamKey: "team-research", status: "ASSIGNED" },
  { abstractId: "abs_1", title: ABSTRACTS[0].title, categoryName: "Applied AI", teamKey: "team-ai", status: "COMPLETED", myScores: { relevance: 5, originality: 4, clarity: 5, speaker: 5 } },
  { abstractId: "abs_2", title: ABSTRACTS[1].title, categoryName: "Infrastructure & Scaling", teamKey: "team-infra", status: "COMPLETED", myScores: { relevance: 4, originality: 4, clarity: 5, speaker: 4 } },
];

// ---- Agenda ---------------------------------------------------------------

export type RoomModel = { id: string; name: string; capacity: number };
export type TrackModel = { id: string; name: string; color: string };

export const ROOMS: RoomModel[] = [
  { id: "room_grand", name: "Grand Ballroom", capacity: 800 },
  { id: "room_a", name: "Hall A", capacity: 300 },
  { id: "room_b", name: "Hall B", capacity: 300 },
  { id: "room_lab", name: "Workshop Lab", capacity: 80 },
];

export const TRACKS: TrackModel[] = [
  { id: "trk_ai", name: "Applied AI", color: "#167565" },
  { id: "trk_infra", name: "Infrastructure", color: "#2f6fb0" },
  { id: "trk_product", name: "Product & UX", color: "#b0592f" },
  { id: "trk_research", name: "Research", color: "#6c4bb0" },
];

export type SlotModel = {
  id: string;
  sessionId: string;
  title: string;
  speakers: string;
  roomId: string;
  trackId: string;
  startsAt: string; // ISO
  endsAt: string;
};

// Event day: Oct 12, 2026
const DAY = "2026-10-12";
function at(time: string) {
  return `${DAY}T${time}:00.000-07:00`;
}

export const SLOTS: SlotModel[] = [
  { id: "slot_1", sessionId: "ses_1", title: "Opening Keynote: The Applied AI Decade", speakers: "Amara Okafor", roomId: "room_grand", trackId: "trk_ai", startsAt: at("09:00"), endsAt: at("09:45") },
  { id: "slot_2", sessionId: "ses_2", title: "Shipping Agents That Don't Hallucinate", speakers: "Sofia Marques", roomId: "room_a", trackId: "trk_ai", startsAt: at("10:00"), endsAt: at("10:30") },
  { id: "slot_3", sessionId: "ses_3", title: "Vector Search at 10B Embeddings", speakers: "Liang Wei", roomId: "room_b", trackId: "trk_infra", startsAt: at("10:00"), endsAt: at("10:30") },
  // Deliberate room conflict: slot_4 overlaps slot_2 in Hall A
  { id: "slot_4", sessionId: "ses_4", title: "Designing Trust: UX for AI Copilots", speakers: "Priya Nair", roomId: "room_a", trackId: "trk_product", startsAt: at("10:15"), endsAt: at("10:45") },
  { id: "slot_5", sessionId: "ses_5", title: "Multimodal Agents for Field Operations", speakers: "Amara Okafor", roomId: "room_grand", trackId: "trk_ai", startsAt: at("11:00"), endsAt: at("11:30") },
  // Deliberate speaker conflict: Amara double-booked (slot_5 & slot_6 overlap)
  { id: "slot_6", sessionId: "ses_6", title: "Panel: Frontier Research in the Wild", speakers: "Amara Okafor", roomId: "room_b", trackId: "trk_research", startsAt: at("11:15"), endsAt: at("11:45") },
  { id: "slot_7", sessionId: "ses_7", title: "Hands-on: Eval-Driven Development", speakers: "Marco Rossi", roomId: "room_lab", trackId: "trk_product", startsAt: at("13:00"), endsAt: at("14:30") },
];

export type ConflictModel = {
  type: "ROOM_OVERLAP" | "SPEAKER_OVERLAP";
  slotId: string;
  conflictingSlotId: string;
  message: string;
};

/** Detect room + speaker overlaps client-side (mirrors backend conflict rules). */
export function detectConflicts(slots: SlotModel[]): ConflictModel[] {
  const conflicts: ConflictModel[] = [];
  const overlap = (a: SlotModel, b: SlotModel) =>
    new Date(a.startsAt) < new Date(b.endsAt) && new Date(b.startsAt) < new Date(a.endsAt);
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i];
      const b = slots[j];
      if (!overlap(a, b)) continue;
      if (a.roomId === b.roomId) {
        conflicts.push({
          type: "ROOM_OVERLAP",
          slotId: a.id,
          conflictingSlotId: b.id,
          message: `${ROOMS.find((r) => r.id === a.roomId)?.name} is double-booked`,
        });
      }
      if (a.speakers === b.speakers) {
        conflicts.push({
          type: "SPEAKER_OVERLAP",
          slotId: a.id,
          conflictingSlotId: b.id,
          message: `${a.speakers} is scheduled in two places at once`,
        });
      }
    }
  }
  return conflicts;
}

export const EVENT_META = {
  name: "Forward 2026",
  slug: "forward-2026",
  dateLabel: "October 12–14, 2026",
  location: "San Francisco, CA",
};

