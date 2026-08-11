import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { handle, ok, parseBody } from "@/lib/api/http";
import { runAssistant } from "@/lib/assistant/client";
import {
  buildDecisionNoteProjection,
  DECISION_NOTE_COMMENT_READ_LIMIT,
  DECISION_NOTE_INSTRUCTIONS,
  DECISION_NOTE_MAX_DRAFT_CHARS,
  decisionNoteRequestSchema,
  decisionNoteUnavailable,
  renderDecisionNoteInput,
  resolveDecisionNoteTarget,
} from "@/lib/assistant/decision-note";
import { enforceAssistantRateLimit } from "@/lib/services/assistant-rate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/assistant/decision-note — suggest a personal note for the decision
 * email an organizer is about to compose.
 *
 * Advisory and read-only. It writes nothing but its own rate-bucket rows, takes
 * no abstract lock, and has no authority over the decision or the email: the
 * organizer edits or discards whatever comes back, and the existing preview
 * proof in `/api/comms/decision` is still the only thing that authorizes a
 * send. That is why staleness needs no version column here — accepting the
 * suggestion makes it the organizer's own text, and the email route re-reads
 * and re-digests everything at preview time regardless.
 *
 * The whole privacy surface is the projection built in
 * `lib/assistant/decision-note.ts`: event name, proposal title, decision, and
 * the reviewer comments the organizer explicitly chose to include. No speaker
 * address, reviewer identity, score, user id, or event id is loaded here to
 * begin with — the `select` below is the enforcement, not a filter downstream.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  // First thing after auth, before any read. A provider call costs money, and
  // charging before the lookup means probing for proposal ids costs the prober
  // exactly what a real draft costs — an unknown id is never the cheap path.
  await enforceAssistantRateLimit({ userId: ctx.userId, eventId: ctx.eventId });
  const input = await parseBody(req, decisionNoteRequestSchema);

  const abstract = await prisma.abstract.findUnique({
    where: { id: input.abstractId },
    select: { id: true, eventId: true, title: true, status: true, event: { select: { name: true } } },
  });
  const resolved = resolveDecisionNoteTarget(abstract, ctx.eventId);
  if (!resolved.ok) throw resolved.error;

  // Read regardless of the organizer's choice, so `commentsAvailable` reports
  // what this proposal really has. `includeFeedback` decides what is *sent*,
  // which is the decision that matters and is made in the projection.
  const commentRows = await prisma.reviewScore.findMany({
    where: { abstractId: input.abstractId, comment: { not: null } },
    select: { comment: true },
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

  const result = await runAssistant({
    instructions: DECISION_NOTE_INSTRUCTIONS,
    input: renderDecisionNoteInput(projection),
    maxOutputChars: DECISION_NOTE_MAX_DRAFT_CHARS,
  });
  // No deterministic stand-in. Greenroom's decision email already has truthful
  // default wording; presenting it as a generated draft would be a lie about
  // what happened, and the organizer can still write the note by hand.
  if (!result.ok) throw decisionNoteUnavailable(result.reason);

  return ok({ draft: result.text, grounding });
});
