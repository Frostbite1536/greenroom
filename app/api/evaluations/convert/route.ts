import { prisma } from "@/lib/prisma";
import { abstractToSessionSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { lockAbstractForWrite } from "@/lib/services/abstract-lock";
import { provisionAcceptedAbstract } from "@/lib/services/session-provisioning";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/evaluations/convert — convert an ACCEPTED abstract into a
 * schedulable Session (admin). Creates at most one Session per abstract
 * (INV-DOMAIN-001, enforced by the unique `sourceAbstractId`) and copies the
 * abstract's speakers onto the session. Idempotent: re-running returns the
 * existing session.
 *
 * Accepting an abstract now provisions this automatically (WAVE1-B1), so this
 * endpoint remains for two jobs: converting with an explicit duration, and
 * acting as the manual backfill for talks accepted before that existed — the
 * idempotent branch still tops up missing onboarding assignments.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, abstractToSessionSchema);

  // Check and create under the same per-abstract advisory lock the speaker
  // PATCH takes: conversion snapshots the roster onto the Session, so a
  // concurrent roster edit racing this check could otherwise leave the two
  // records disagreeing (INV-DOMAIN-001).
  const result = await prisma.$transaction(async (tx) => {
    await lockAbstractForWrite(tx, input.abstractId);

    const abstract = await tx.abstract.findUnique({
      where: { id: input.abstractId },
      include: { speakers: true, session: true },
    });
    if (!abstract || abstract.eventId !== ctx.eventId) {
      throw new ApiError(404, "ABSTRACT_NOT_FOUND", "Abstract not found.");
    }
    if (abstract.status !== "ACCEPTED") {
      throw new ApiError(409, "NOT_ACCEPTED", "Only accepted abstracts can become sessions.");
    }

    return provisionAcceptedAbstract(tx, abstract, input.durationMinutes);
  });

  return ok(result, result.created ? 201 : 200);
});
