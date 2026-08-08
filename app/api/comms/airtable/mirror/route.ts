import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { assertEventScope, requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { assertEventQueryBound, OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import { useMockIntegrations } from "@/lib/env";
import {
  AIRTABLE_TABLES,
  AirtableMirrorError,
  buildAirtableProjection,
  projectionCounts,
  resolveAirtableMirrorMode,
  upsertAirtableTable,
} from "@/lib/airtable/mirror";

const mirrorRequestSchema = z.object({
  eventId: z.string().trim().min(1).max(191),
  // Preview is deliberately the default: no accidental third-party writes.
  dryRun: z.boolean().default(true),
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/comms/airtable/mirror — admin-only one-way projection to Airtable. */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, mirrorRequestSchema);
  assertEventScope(ctx, input.eventId);

  const [event, sessions] = await Promise.all([
    prisma.event.findUnique({ where: { id: ctx.eventId }, select: { id: true, name: true } }),
    prisma.session.findMany({
      where: { eventId: ctx.eventId },
      select: {
        id: true, sourceAbstractId: true, title: true, description: true, format: true, durationMinutes: true,
        sourceAbstract: { select: { status: true } },
        speakers: {
          select: { user: { select: {
            id: true, name: true, email: true,
            speakerProfile: { select: { bio: true, company: true, jobTitle: true } },
          } } },
          take: OPERATOR_QUERY_LIMITS.sessionSpeakersPerSession + 1,
        },
        scheduleSlot: { select: {
          id: true, startsAt: true, endsAt: true,
          room: { select: { name: true } }, track: { select: { name: true } },
        } },
      },
      orderBy: { title: "asc" },
      take: OPERATOR_QUERY_LIMITS.mirrorSessions + 1,
    }),
  ]);
  if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found.");
  assertEventQueryBound(sessions, OPERATOR_QUERY_LIMITS.mirrorSessions, "sessions for the Airtable mirror");
  for (const session of sessions) {
    assertEventQueryBound(
      session.speakers,
      OPERATOR_QUERY_LIMITS.sessionSpeakersPerSession,
      `speakers on session '${session.id}'`,
    );
  }

  const projection = buildAirtableProjection(event, sessions.map((session) => ({
    id: session.id,
    sourceAbstractId: session.sourceAbstractId,
    sourceAbstractStatus: session.sourceAbstract?.status ?? null,
    title: session.title,
    description: session.description,
    format: session.format,
    durationMinutes: session.durationMinutes,
    speakers: session.speakers.map(({ user }) => ({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        profile: user.speakerProfile,
      },
    })),
    scheduleSlot: session.scheduleSlot ? {
      id: session.scheduleSlot.id,
      startsAt: session.scheduleSlot.startsAt,
      endsAt: session.scheduleSlot.endsAt,
      roomName: session.scheduleSlot.room.name,
      trackName: session.scheduleSlot.track?.name ?? null,
    } : null,
  })));
  const counts = projectionCounts(projection);
  const decision = resolveAirtableMirrorMode({
    dryRun: input.dryRun,
    mockExternalApis: useMockIntegrations(),
    apiKey: process.env.AIRTABLE_API_KEY,
    baseId: process.env.AIRTABLE_BASE_ID,
  });

  if (decision.mode !== "live") {
    return ok({ ...decision, counts, batches: 0 });
  }

  try {
    let batches = 0;
    for (const table of AIRTABLE_TABLES) {
      batches += await upsertAirtableTable(fetch, {
        apiKey: process.env.AIRTABLE_API_KEY!,
        baseId: process.env.AIRTABLE_BASE_ID!,
      }, table, projection.tables[table]);
    }
    return ok({ mode: "live" as const, counts, batches });
  } catch (error) {
    if (error instanceof AirtableMirrorError) {
      console.error(`[airtable] ${error.table} upsert failed with status ${error.status}`);
      throw new ApiError(502, "AIRTABLE_SYNC_FAILED", "The Airtable mirror did not complete.");
    }
    throw error;
  }
});
