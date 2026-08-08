import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { assertEventScope, requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { assertEventQueryBound, OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import { useMockIntegrations } from "@/lib/env";
import {
  AcceleventsPushError,
  acceleventsPushSummary,
  buildAcceleventsPushPayload,
  postAcceleventsPush,
  resolveAcceleventsPushMode,
} from "@/lib/accelevents/push";

const pushRequestSchema = z.object({
  eventId: z.string().trim().min(1).max(191),
  // External writes must be deliberately requested.
  dryRun: z.boolean().default(true),
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/integrations/accelevents/push — admin-scoped program push to an operator-configured endpoint. */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, pushRequestSchema);
  assertEventScope(ctx, input.eventId);

  const [event, sessions] = await Promise.all([
    prisma.event.findUnique({ where: { id: ctx.eventId }, select: { id: true, name: true, slug: true } }),
    prisma.session.findMany({
      where: { eventId: ctx.eventId },
      select: {
        id: true, sourceAbstractId: true, title: true, description: true, format: true, durationMinutes: true,
        sourceAbstract: { select: { status: true } },
        speakers: { select: { user: { select: {
          id: true, name: true, email: true,
          speakerProfile: { select: { bio: true, company: true, jobTitle: true } },
        } } } },
        scheduleSlot: { select: {
          id: true, startsAt: true, endsAt: true,
          room: { select: { name: true } }, track: { select: { name: true } },
        } },
      },
      orderBy: { title: "asc" },
      take: OPERATOR_QUERY_LIMITS.acceleventsSessions + 1,
    }),
  ]);
  if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found.");
  assertEventQueryBound(sessions, OPERATOR_QUERY_LIMITS.acceleventsSessions, "sessions for the Accelevents push");

  const payload = buildAcceleventsPushPayload(event, sessions.map((session) => ({
    id: session.id,
    sourceAbstractId: session.sourceAbstractId,
    sourceAbstractStatus: session.sourceAbstract?.status ?? null,
    title: session.title,
    description: session.description,
    format: session.format,
    durationMinutes: session.durationMinutes,
    speakers: session.speakers.map(({ user }) => ({
      user: { id: user.id, name: user.name, email: user.email, profile: user.speakerProfile },
    })),
    scheduleSlot: session.scheduleSlot ? {
      id: session.scheduleSlot.id,
      startsAt: session.scheduleSlot.startsAt,
      endsAt: session.scheduleSlot.endsAt,
      roomName: session.scheduleSlot.room.name,
      trackName: session.scheduleSlot.track?.name ?? null,
    } : null,
  })));
  const summary = acceleventsPushSummary(payload);
  const decision = resolveAcceleventsPushMode({
    dryRun: input.dryRun,
    mockExternalApis: useMockIntegrations(),
    endpoint: process.env.ACCELEVENTS_BASE_URL,
  });

  if (decision.mode !== "live") return ok({ ...decision, summary });

  try {
    await postAcceleventsPush(fetch, {
      endpoint: process.env.ACCELEVENTS_BASE_URL!,
      apiKey: process.env.ACCELEVENTS_API_KEY,
    }, payload);
    return ok({ mode: "live" as const, summary });
  } catch (error) {
    if (error instanceof AcceleventsPushError) {
      console.error(`[accelevents] configured endpoint returned ${error.status}`);
      throw new ApiError(502, "ACCELEVENTS_PUSH_FAILED", "The Accelevents program push did not complete.");
    }
    throw error;
  }
});
