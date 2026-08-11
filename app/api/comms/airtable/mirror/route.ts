import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { assertEventScope, requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { assertEventQueryBound, OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import { useMockIntegrations } from "@/lib/env";
import {
  buildAirtableProjection,
  countUnpublishedExclusions,
  mirrorAirtableTables,
  projectionCounts,
  type MirrorSession,
  resolveAirtableMirrorMode,
  summarizeMirrorReport,
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
        // GRA2-02: the mirror may not export what the public site withholds.
        contentStatus: true,
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

  const mirrorSessions: MirrorSession[] = sessions.map((session) => ({
    id: session.id,
    sourceAbstractId: session.sourceAbstractId,
    sourceAbstractStatus: session.sourceAbstract?.status ?? null,
    contentStatus: session.contentStatus,
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
  }));

  const projection = buildAirtableProjection(event, mirrorSessions);
  const counts = projectionCounts(projection);
  // Additive to the documented envelope: `counts` keeps its exact shape and
  // meaning, and this states why it may be smaller than the workspace shows.
  const excluded = { unpublishedSessions: countUnpublishedExclusions(mirrorSessions) };
  const decision = resolveAirtableMirrorMode({
    dryRun: input.dryRun,
    mockExternalApis: useMockIntegrations(),
    apiKey: process.env.AIRTABLE_API_KEY,
    baseId: process.env.AIRTABLE_BASE_ID,
  });

  if (decision.mode !== "live") {
    return ok({ ...decision, counts, excluded, report: null });
  }

  // Partial-write recovery lives in the mirror: rows that Airtable rejects are
  // reported individually instead of discarding the rows that did land. Re-running
  // the mirror is the resume path (upsert on External ID, never deletes).
  const report = await mirrorAirtableTables(fetch, {
    apiKey: process.env.AIRTABLE_API_KEY!,
    baseId: process.env.AIRTABLE_BASE_ID!,
  }, projection);

  if (report.status !== "complete") {
    console.error(`[airtable] mirror ${report.status}: ${summarizeMirrorReport(report)}`);
  }
  if (report.status === "failed") {
    throw new ApiError(502, "AIRTABLE_SYNC_FAILED", `The Airtable mirror wrote nothing: ${summarizeMirrorReport(report)}`);
  }
  return ok({ mode: "live" as const, counts, excluded, report });
});
