import { prisma } from "@/lib/prisma";
import { abstractToSessionSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/evaluations/convert — convert an ACCEPTED abstract into a
 * schedulable Session (admin). Creates at most one Session per abstract
 * (INV-DOMAIN-001, enforced by the unique `sourceAbstractId`) and copies the
 * abstract's speakers onto the session. Idempotent: re-running returns the
 * existing session.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, abstractToSessionSchema);

  const abstract = await prisma.abstract.findUnique({
    where: { id: input.abstractId },
    include: { speakers: true, session: true },
  });
  if (!abstract || abstract.eventId !== ctx.eventId) {
    throw new ApiError(404, "ABSTRACT_NOT_FOUND", "Abstract not found.");
  }
  if (abstract.status !== "ACCEPTED") {
    throw new ApiError(409, "NOT_ACCEPTED", "Only accepted abstracts can become sessions.");
  }
  if (abstract.session) {
    return ok({ sessionId: abstract.session.id, created: false });
  }

  const session = await prisma.$transaction(async (tx) => {
    const created = await tx.session.create({
      data: {
        eventId: abstract.eventId,
        sourceAbstractId: abstract.id,
        title: abstract.title,
        description: abstract.abstract,
        format: abstract.format,
        durationMinutes: input.durationMinutes,
      },
    });
    if (abstract.speakers.length > 0) {
      await tx.sessionSpeaker.createMany({
        data: abstract.speakers.map((s) => ({
          sessionId: created.id,
          userId: s.userId,
          isPrimary: s.isPrimary,
        })),
      });
    }
    return created;
  });

  return ok({ sessionId: session.id, created: true }, 201);
});
