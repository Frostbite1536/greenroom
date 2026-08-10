/**
 * Copy for the "Fill open slots" review panel (AIA-08, addendum §4.1).
 *
 * Pure on purpose, like `agenda-publication`: what the panel claims before an
 * operator presses Apply is the whole of this feature's honesty. A panel that
 * says "3 talks will be placed" when one of them cannot be is worse than no
 * panel, so the counts and the empty states are asserted here rather than
 * inferred from a rendered page.
 */
export type PlanSummary = {
  /** Heading for the panel. Never claims more than the plan contains. */
  title: string;
  /** One sentence under the heading, or null when the title says it all. */
  detail: string | null;
  /** Whether an Apply button should exist at all. */
  canApply: boolean;
};

const talks = (count: number) => (count === 1 ? "1 talk" : `${count} talks`);

export function fillOpenSlotsSummary(plan: {
  consideredSessions: number;
  placements: readonly unknown[];
  unplaceable: readonly unknown[];
}): PlanSummary {
  const placed = plan.placements.length;
  const blocked = plan.unplaceable.length;

  // Nothing was even a candidate. Say that, rather than reporting an empty plan
  // as if the scheduler had tried and failed.
  if (plan.consideredSessions === 0) {
    return {
      title: "Every talk is already scheduled",
      detail: "There is nothing in the unscheduled backlog to place.",
      canApply: false,
    };
  }

  if (placed === 0) {
    return {
      title: `No open slot fits ${blocked === 1 ? "the talk" : "any of the talks"} still unscheduled`,
      detail: "Each one is listed below with the reason. Nothing will be changed.",
      canApply: false,
    };
  }

  if (blocked === 0) {
    return {
      title: `${talks(placed)} will be placed`,
      detail: "Nothing already on the schedule moves. Review the placements, then apply them.",
      canApply: true,
    };
  }

  return {
    title: `${talks(placed)} will be placed, ${blocked} cannot be`,
    detail: `Applying places ${placed === 1 ? "that one" : "those"} and leaves the rest in the backlog. `
      + "Nothing already on the schedule moves.",
    canApply: true,
  };
}

/**
 * The refusal an operator sees when apply is rejected. The server's message is
 * already plain language and is the addendum's exact stale wording, so it is
 * shown verbatim; this only adds what to do about it when the code says the
 * preview is stale.
 */
export function applyRefusalCopy(code: string, message: string): string {
  return code === "STALE_PREVIEW" ? `${message} Nothing was changed.` : message;
}
