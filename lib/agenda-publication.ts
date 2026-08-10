/**
 * Publication copy for the agenda builder (CNT-12, AIA-07).
 *
 * Pure on purpose: what the button says, what it will do, and how a talk's
 * current state reads are the whole of this feature's honesty, and they are
 * asserted here rather than inferred from a rendered page.
 */
export type SessionContentStatus = "DRAFT" | "PUBLISHED";

export type PublicationControl = {
  /** What the button does when pressed. */
  next: SessionContentStatus;
  label: string;
  /** Announced to a screen reader, naming the talk the action applies to. */
  actionLabel: (title: string) => string;
  /** Confirmation copy, or null when the action needs no warning. */
  confirm: ((title: string) => string) | null;
};

/**
 * The one control. Unpublishing is the destructive-sounding direction and is
 * the only one that asks first — it removes a talk the public may already have
 * linked to. Publishing is not confirmed: it is the state everything already
 * defaults to, and undoing it is one click away.
 */
export function publicationControl(status: SessionContentStatus): PublicationControl {
  if (status === "PUBLISHED") {
    return {
      next: "DRAFT",
      label: "Unpublish",
      actionLabel: (title) => `Unpublish ${title} from the public programme`,
      confirm: (title) =>
        `Unpublish “${title}”? It stays on the schedule here and keeps its speakers and tasks, `
        + "but it stops appearing on the public agenda and speaker pages.",
    };
  }
  return {
    next: "PUBLISHED",
    label: "Publish",
    actionLabel: (title) => `Publish ${title} to the public programme`,
    confirm: null,
  };
}

/**
 * How many talks are held back, phrased for the operator, or null when the
 * whole programme is published. Never says "0 unpublished": a banner that
 * reports nothing is a banner that should not be there.
 *
 * It names the List view because that is where the per-talk control lives — a
 * notice that reports a problem an organizer cannot find the switch for is half
 * a feature.
 */
export function unpublishedNotice(
  statuses: readonly SessionContentStatus[],
  truncated = false,
): string | null {
  const held = statuses.filter((status) => status === "DRAFT").length;
  // Past the cap, "none held back" is a claim about rows this page never read.
  // It stays silent rather than asserting a clean bill of health it cannot give
  // — the builder's truncation banner is already telling the operator why.
  if (held === 0) return null;
  if (truncated) {
    return `At least ${held} ${held === 1 ? "talk is" : "talks are"} unpublished and ${held === 1 ? "does" : "do"} `
      + "not appear on the public agenda; this page does not hold the whole programme. "
      + `Open the List view to publish ${held === 1 ? "it" : "them"}.`;
  }
  return held === 1
    ? "1 talk is unpublished and does not appear on the public agenda. Open the List view to publish it."
    : `${held} talks are unpublished and do not appear on the public agenda. Open the List view to publish them.`;
}
