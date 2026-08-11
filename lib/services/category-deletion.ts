/**
 * The category removal policy, kept separate from persistence like the room and
 * onboarding-template policies. The route supplies this decision only after it
 * has locked and re-read the scoped category and both of its references in the
 * same transaction.
 *
 * A Category is referenced twice, and both references are `onDelete: SetNull`,
 * so deletion is quiet rather than destructive — which is exactly why it needs
 * a policy:
 *
 * - `Abstract.categoryId` is the topic a proposal was submitted under, and it
 *   is what routes that proposal to a review team: assignment reads
 *   `abstract.category?.defaultTeamKey` at assign time
 *   (`app/api/evaluations/assignments/route.ts`). Nulling it does not move a
 *   review that already exists, but every later assignment for that proposal
 *   silently loses its routing default and lands unrouted.
 * - `Session.categoryId` is the topic label carried onto a confirmed talk, and
 *   it renders on the public programme and the schedule embed. `SetNull` is
 *   there so removing a category can never delete a confirmed talk; it is not a
 *   licence to strip a live programme's topics without saying so.
 *
 * Both are therefore obstructions, and the refusal names which one is in the
 * way so the organizer knows where to look. A category nothing references may
 * be removed. Renaming is always allowed: both references are relational, so a
 * new name is read through the foreign key everywhere and no stored copy of the
 * old string exists to go stale.
 */
export type CategoryUsage = {
  hasAbstract: boolean;
  hasSession: boolean;
};

export type CategoryDeletionDecision =
  | { allowed: true }
  | { allowed: false; code: "CATEGORY_IN_USE"; message: string };

export function decideCategoryDeletion(usage: CategoryUsage): CategoryDeletionDecision {
  const obstruction = categoryObstruction(usage);
  if (!obstruction) return { allowed: true };
  return {
    allowed: false,
    code: "CATEGORY_IN_USE",
    message: `${obstruction} Move them to another category, or rename this one instead of removing it.`,
  };
}

function categoryObstruction(usage: CategoryUsage): string | null {
  if (usage.hasAbstract && usage.hasSession) {
    return "Proposals and scheduled sessions still use this category, and removing it would drop their review routing and their program topic.";
  }
  if (usage.hasAbstract) {
    return "Proposals still use this category, and removing it would drop the review routing it gives them.";
  }
  if (usage.hasSession) {
    return "Sessions on the program still use this category as their topic.";
  }
  return null;
}
