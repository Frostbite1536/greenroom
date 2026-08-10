import { prisma } from "@/lib/prisma";
import { onboardingTaskAssignSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { handle, ok, parseBody } from "@/lib/api/http";
import { backfillConfirmedSpeakerTasks } from "@/lib/services/onboarding-task-backfill";
import { lockEventTaskFanOut } from "@/lib/services/onboarding-task-lock";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/tasks/assign — give every confirmed speaker the current
 * checklist.
 *
 * The bulk action and the C33 backfill are the same operation, so they are the
 * same code: this reconciles the event's confirmed sessions against its
 * templates through the shared `assignOnboardingTasks` fan-out. It is
 * idempotent by construction, so an organizer can press it as often as they
 * like — `assigned: 0` honestly means everyone already had everything.
 *
 * There are no arguments. The event comes from the session and the cohort is
 * every speaker on a confirmed session, so a caller cannot aim this at another
 * event or at a subset the server did not choose.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  await parseBody(req, onboardingTaskAssignSchema);

  const result = await prisma.$transaction(async (tx) => {
    await lockEventTaskFanOut(tx, ctx.eventId);
    return backfillConfirmedSpeakerTasks(tx, ctx.eventId);
  });

  return ok({ assigned: result.assigned, sessions: result.sessions });
});
