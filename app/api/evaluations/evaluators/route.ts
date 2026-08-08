import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { handle, ok } from "@/lib/api/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/evaluations/evaluators — event members who can review (admin).
 *
 * The assignment UI needs real `User` ids to POST
 * `/api/evaluations/assignments`, but persona cookies only carry emails and
 * ids are server-generated. This is the only supported way to resolve them.
 * Includes ADMINs since admins commonly review alongside the evaluator team.
 * Scoped to the caller's active event (INV-EVENT-001).
 */
export const GET = handle(async () => {
  const ctx = await requireContext(["ADMIN"]);

  const members = await prisma.eventMember.findMany({
    where: { eventId: ctx.eventId, role: { in: ["EVALUATOR", "ADMIN"] } },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { user: { name: "asc" } },
  });

  return ok(
    members.map((m) => ({
      userId: m.user.id,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
    })),
  );
});
