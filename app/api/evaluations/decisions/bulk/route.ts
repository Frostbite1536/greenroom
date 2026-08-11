import { prisma } from "@/lib/prisma";
import { bulkAbstractDecisionSchema } from "@/types/api";
import { requireContext } from "@/lib/api/context";
import { handle, ok, parseBody } from "@/lib/api/http";
import { writeAbstractDecision } from "@/lib/services/abstract-decision-write";
import { runBulkAbstractDecision } from "@/lib/services/bulk-abstract-decision";

export const dynamic = "force-dynamic";

/**
 * POST /api/evaluations/decisions/bulk — decide a selection of abstracts (admin).
 *
 * The roadmap's "preview-safe bulk decisions". Three properties define it:
 *
 *  1. **It loops the locked single-abstract write; it does not reimplement it.**
 *     Every item runs `writeAbstractDecision` — the same function
 *     `POST /api/evaluations/decisions` runs — inside its own
 *     `prisma.$transaction`. One transaction per abstract, never one spanning
 *     the batch: a fifty-item all-or-nothing lock hold would block every
 *     concurrent speaker edit for the length of the slowest provisioning, and
 *     would throw away forty-nine correct writes to report the fiftieth's
 *     refusal. Acceptance therefore still provisions the confirmed `Session`
 *     and the onboarding checklist atomically, per abstract
 *     (INV-DOMAIN-001, INV-TASK-001, INV-ABSTRACT-001).
 *
 *  2. **It skips with a reason rather than failing the batch.** An already
 *     decided proposal, a withdrawn one, a draft, a `MAYBE` on a confirmed
 *     talk, and an id belonging to another event are each named in the
 *     response beside the rows that were written. Only two things refuse the
 *     whole request, and both do so before any write: a non-admin caller, and a
 *     selection larger than `BULK_ABSTRACT_DECISION_LIMIT` (422 from the
 *     schema's own `.max()`).
 *
 *     Unlike the single-row route, bulk will not reverse an existing decision.
 *     The drawer makes that an explicit "Change decision" click on one named
 *     proposal; a tick box carries no such evidence, so
 *     `requireAwaitingDecision` limits the batch to proposals still awaiting a
 *     decision and reports the rest as skips.
 *
 *  3. **It sends no email.** Deciding is not mailing. `POST /api/comms/decision`
 *     stays the only path to a speaker's inbox, and it is preview-gated: the
 *     send is bound by an HMAC proof to the exact content and recipients an
 *     admin previewed, which a batch cannot and must not satisfy. Nothing here
 *     imports `lib/comms`, touches `EmailDispatch`, or queues anything — the
 *     route contract test asserts that by absence, so an email import added
 *     later fails rather than quietly mailing a hundred speakers.
 */
export const POST = handle(async (req) => {
  const ctx = await requireContext(["ADMIN"]);
  const input = await parseBody(req, bulkAbstractDecisionSchema);

  const report = await runBulkAbstractDecision(input.decision, input.abstractIds, (abstractId) =>
    prisma.$transaction((tx) =>
      writeAbstractDecision(tx, {
        abstractId,
        // Scoped to the caller's own event; an id outside it is reported as
        // not found rather than as a different-event error, so this endpoint
        // is not an existence oracle for another event's proposals.
        eventId: ctx.eventId,
        decision: input.decision,
        requireAwaitingDecision: true,
      }),
    ),
  );

  return ok(report);
});
