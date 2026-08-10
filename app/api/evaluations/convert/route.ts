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
 * endpoint remains for three jobs: converting a legacy accepted abstract that
 * has no Session yet (using the requested duration), acting as the manual
 * checklist backfill for existing Sessions, and reconciling a Session whose
 * topic has moved on the proposal since it was created. A requested duration
 * never mutates a Session that already exists; scheduling owns later duration
 * changes.
 *
 * The topic repair is ADMIN-authorized by this route's own `requireContext`,
 * which is the whole reason it lives on the re-run rather than on the speaker's
 * edit: per INV-EDIT-001 a speaker edit never silently mutates its linked
 * Session (C18 owns that handoff), so an organizer re-running conversion is how
 * a changed category reaches the public programme.
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
