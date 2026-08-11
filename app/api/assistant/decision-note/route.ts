import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireContext, type ApiContext } from "@/lib/api/context";
import { handle, ok } from "@/lib/api/http";
import { runAssistant, type AssistantRequest, type AssistantResult } from "@/lib/assistant/client";
import {
  buildDecisionNoteProjection,
  DECISION_NOTE_ABSTRACT_SELECT,
  DECISION_NOTE_COMMENT_READ_LIMIT,
  DECISION_NOTE_COMMENT_SELECT,
  DECISION_NOTE_INSTRUCTIONS,
  DECISION_NOTE_MAX_BODY_BYTES,
  DECISION_NOTE_REQUEST_MAX_OUTPUT_CHARS,
  DECISION_NOTE_TEXT_FORMAT,
  decisionNoteRequestSchema,
  decisionNoteUnavailable,
  parseBoundedJson,
  parseDecisionNoteDraft,
  renderDecisionNoteInput,
  resolveDecisionNoteTarget,
  type DecisionNoteAbstract,
} from "@/lib/assistant/decision-note";
import { enforceAssistantRateLimit } from "@/lib/services/assistant-rate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The route's collaborators, injected so the handler can be driven for real in
 * a unit test — with a fake context, a fake database that records the exact
 * `select` it was handed, and a fake provider that captures the outbound
 * prompt. Source regexes cannot prove any of those; this can.
 *
 * The database is passed as a narrow shape rather than the Prisma client, so
 * the query arguments the route builds are observable at the boundary instead
 * of disappearing into a helper.
 */
export type DecisionNoteQuery = { where: Record<string, unknown>; select: Record<string, unknown> };

export type DecisionNoteDeps = {
  requireContext: (roles: UserRole[]) => Promise<ApiContext>;
  enforceRateLimit: (input: { userId: string; eventId: string }) => Promise<void>;
  db: {
    findAbstract: (query: DecisionNoteQuery) => Promise<DecisionNoteAbstract | null>;
    findComments: (
      query: DecisionNoteQuery & { orderBy: unknown; take: number },
    ) => Promise<Array<{ comment: string | null }>>;
  };
  runAssistant: (request: AssistantRequest) => Promise<AssistantResult>;
};

/**
 * POST /api/assistant/decision-note — suggest a personal note for the decision
 * email an organizer is about to compose.
 *
 * Advisory and read-only. It writes nothing but its own rate-bucket rows, takes
 * no abstract lock, and has no authority over the decision or the email: the
 * organizer edits or discards whatever comes back, and the existing preview
 * proof in `/api/comms/decision` remains the only thing that authorizes a send.
 * Staleness therefore needs no version column — accepting the suggestion makes
 * it the organizer's own text, and the email route re-reads and re-digests
 * everything at preview time regardless.
 *
 * The privacy surface is the projection built in `lib/assistant/decision-note`.
 * No identity, address, score, rubric, or id column is loaded at all: the two
 * `select`s below are the enforcement, not a filter applied downstream. What
 * they cannot bound is the CONTENT of a reviewer comment, which is sent
 * verbatim when the organizer opts in and may itself name a person or a score —
 * the panel's disclosure says exactly that.
 */
export function createDecisionNotePost(deps: DecisionNoteDeps): (req: Request) => Promise<Response> {
  return handle(async (req) => {
    const ctx = await deps.requireContext(["ADMIN"]);
    // Charged first thing after authentication, before the body is even read.
    // Charging later would make a malformed body or an unknown id the cheap
    // path and turn the endpoint into a free proposal-id oracle.
    await deps.enforceRateLimit({ userId: ctx.userId, eventId: ctx.eventId });
    const input = await parseBoundedJson(req, decisionNoteRequestSchema, DECISION_NOTE_MAX_BODY_BYTES);

    const abstract = await deps.db.findAbstract({
      where: { id: input.abstractId },
      select: { ...DECISION_NOTE_ABSTRACT_SELECT },
    });
    const resolved = resolveDecisionNoteTarget(abstract, ctx.eventId);
    if (!resolved.ok) throw resolved.error;

    // Read regardless of the organizer's choice, so `commentsAvailable` reports
    // what this proposal really has. `includeFeedback` decides what is SENT,
    // which is the decision that matters and is made in the projection.
    const commentRows = await deps.db.findComments({
      where: { abstractId: input.abstractId, comment: { not: null } },
      select: { ...DECISION_NOTE_COMMENT_SELECT },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: DECISION_NOTE_COMMENT_READ_LIMIT,
    });

    const { projection, grounding } = buildDecisionNoteProjection({
      eventName: resolved.target.eventName,
      title: resolved.target.title,
      decision: resolved.target.decision,
      comments: commentRows.map((row) => row.comment ?? ""),
      includeFeedback: input.includeFeedback,
    });

    const result = await deps.runAssistant({
      instructions: DECISION_NOTE_INSTRUCTIONS,
      input: renderDecisionNoteInput(projection),
      textFormat: { ...DECISION_NOTE_TEXT_FORMAT },
      maxOutputChars: DECISION_NOTE_REQUEST_MAX_OUTPUT_CHARS,
    });
    // No deterministic stand-in. Greenroom's decision email already has
    // truthful default wording; presenting it as a generated draft would be a
    // lie about what happened, and the organizer can still write the note.
    if (!result.ok) throw decisionNoteUnavailable(result.reason);

    // The foundation stays feature-agnostic and hands back the raw JSON string,
    // so validating this feature's own schema happens here.
    const parsed = parseDecisionNoteDraft(result.text);
    if (!parsed.ok) throw decisionNoteUnavailable(parsed.reason);

    const response = ok({ draft: parsed.draft, grounding });
    // A generated note is per-request, per-organizer, and derived from reviewer
    // comments. Nothing between here and the browser may keep a copy.
    response.headers.set("Cache-Control", "no-store");
    return response;
  });
}

export const POST = createDecisionNotePost({
  requireContext,
  enforceRateLimit: enforceAssistantRateLimit,
  db: {
    // The narrow shapes above are structurally what Prisma returns for these
    // selects; the cast is the one place that bridges the injected boundary.
    findAbstract: (query) =>
      prisma.abstract.findUnique(query as never) as unknown as Promise<DecisionNoteAbstract | null>,
    findComments: (query) =>
      prisma.reviewScore.findMany(query as never) as unknown as Promise<Array<{ comment: string | null }>>,
  },
  runAssistant,
});
