import type { AbstractDecision } from "@/lib/services/abstract-decision";
import type {
  AbstractDecisionRefusalCode,
  AbstractDecisionWriteResult,
} from "@/lib/services/abstract-decision-write";

/**
 * Deciding a selection: honest per-item results, never all-or-nothing.
 *
 * The roadmap item is "preview-safe bulk decisions", and both halves of that
 * phrase are load-bearing here.
 *
 * **Bulk.** Each abstract is written by its own call to
 * `writeAbstractDecision`, in its own transaction. This module owns only the
 * loop and the tally, and it takes the writer as a parameter — so what happens
 * when one item fails is provable without a database, which is the property
 * that matters most. A refused or thrown item is recorded and the loop
 * continues; the forty-nine rows that succeeded stay written. The alternative —
 * one transaction spanning the selection — would discard every correct write to
 * report one refusal, and would hold the whole selection's advisory locks
 * against speaker edits for the length of the slowest provisioning.
 *
 * **Preview-safe.** Nothing in this path sends mail. A decision is not a
 * decision email: `POST /api/comms/decision` renders a preview and binds the
 * send to an HMAC proof of the exact content and recipients an admin looked at.
 * A batch cannot satisfy that proof and must not try — bulk decides, Operations
 * sends. There is deliberately no email import anywhere in this module or in
 * the route that calls it, and a source contract test pins that.
 *
 * The report is ordered as the request was, and every requested id appears in it
 * exactly once. An operator who selected fifty rows gets fifty answers.
 */

/** Why a selected proposal was not written. Codes match the writer's refusals. */
export type BulkDecisionSkipReason = AbstractDecisionRefusalCode | "DECISION_FAILED";

/**
 * Operator-facing copy for a skip. One sentence, naming the row's own reason —
 * an unnamed skip is indistinguishable from a silent failure, which is the
 * defect a batch report exists to prevent.
 */
export const BULK_DECISION_SKIP_REASONS: Record<BulkDecisionSkipReason, string> = {
  ABSTRACT_NOT_FOUND: "Not found in this event.",
  ABSTRACT_WITHDRAWN: "The speaker withdrew this proposal.",
  ABSTRACT_ALREADY_DECIDED:
    "Already decided — open it and use “Change decision” to change one deliberately.",
  ABSTRACT_NOT_SUBMITTED: "Still a draft; it has not been submitted for a decision.",
  MAYBE_NOT_AVAILABLE: "Maybe is unavailable once a proposal has a confirmed session.",
  DECISION_FAILED: "This proposal could not be written; the others in this batch were unaffected.",
};

export type BulkDecisionItem =
  | {
      abstractId: string;
      outcome: "DECIDED";
      decision: AbstractDecision;
      sessionCreated: boolean;
      tasksAssigned: number;
    }
  | {
      abstractId: string;
      outcome: "SKIPPED";
      reasonCode: BulkDecisionSkipReason;
      reason: string;
    };

export type BulkDecisionReport = {
  decision: AbstractDecision;
  requested: number;
  decided: number;
  skipped: number;
  /** Confirmed talks this batch built. Never counts one that already existed. */
  sessionsCreated: number;
  /** Checklist rows this batch inserted. Never a total. */
  tasksAssigned: number;
  /** One entry per requested id, in request order. */
  results: BulkDecisionItem[];
};

/**
 * Write one abstract's decision. The route supplies
 * `(id) => prisma.$transaction((tx) => writeAbstractDecision(tx, …))`; tests
 * supply a fake, which is how per-item independence is proved.
 */
export type DecideOneAbstract = (abstractId: string) => Promise<AbstractDecisionWriteResult>;

export async function runBulkAbstractDecision(
  decision: AbstractDecision,
  abstractIds: readonly string[],
  decideOne: DecideOneAbstract,
): Promise<BulkDecisionReport> {
  const results: BulkDecisionItem[] = [];
  let decided = 0;
  let sessionsCreated = 0;
  let tasksAssigned = 0;

  for (const abstractId of abstractIds) {
    // Sequential on purpose. Each iteration takes this abstract's advisory lock;
    // running the selection concurrently would multiply the connections held
    // and give two items in one batch a chance to deadlock against the same
    // speaker edit. A bounded batch run in order is the predictable shape.
    let result: AbstractDecisionWriteResult;
    try {
      result = await decideOne(abstractId);
    } catch (error) {
      // The whole point of one transaction per abstract: this item's rollback
      // is this item's alone. Log it and keep going — reporting a failed row as
      // a skip is honest, silently dropping the remaining rows is not.
      console.error("[bulk-decision] item failed", { abstractId, error });
      results.push({
        abstractId,
        outcome: "SKIPPED",
        reasonCode: "DECISION_FAILED",
        reason: BULK_DECISION_SKIP_REASONS.DECISION_FAILED,
      });
      continue;
    }

    if (!result.decided) {
      results.push({
        abstractId,
        outcome: "SKIPPED",
        reasonCode: result.refusal,
        reason: BULK_DECISION_SKIP_REASONS[result.refusal],
      });
      continue;
    }

    decided += 1;
    if (result.sessionCreated) sessionsCreated += 1;
    tasksAssigned += result.tasksAssigned;
    results.push({
      abstractId,
      outcome: "DECIDED",
      decision: result.decision,
      sessionCreated: result.sessionCreated,
      tasksAssigned: result.tasksAssigned,
    });
  }

  return {
    decision,
    requested: abstractIds.length,
    decided,
    skipped: results.length - decided,
    sessionsCreated,
    tasksAssigned,
    results,
  };
}
