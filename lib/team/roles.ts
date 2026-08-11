import type { UserRole } from "@prisma/client";

/**
 * The event team's roles, ordering and copy — the half both the server and the
 * browser need.
 *
 * Split from `lib/services/event-team.ts` for the same reason
 * `lib/speakers/status.ts` is split from `lib/services/speaker-roster.ts`: the
 * service module carries the Zod contracts and the advisory-lock helpers, and
 * pulling those into a client component would ship the validator to the browser
 * to render a label. Everything here is pure, dependency-free and safe on
 * either side.
 *
 * None of it is authorization. What a role may do is enforced server-side per
 * request (INV-EVENT-001); these are the words the UI puts on it.
 */

/**
 * Which roles the add-by-email form may grant.
 *
 * SPEAKER is deliberately absent: `/admin/speakers` already provisions speakers
 * and it also writes the `SpeakerProfile` half a speaker needs to appear
 * anywhere. A second, profile-less door to the same role would create roster
 * rows that screen could not explain. Moving an EXISTING member to speaker is
 * still allowed — that is a role change, not a provisioning path.
 */
export const TEAM_ADDABLE_ROLES = ["ADMIN", "EVALUATOR"] as const satisfies readonly UserRole[];
export type TeamAddableRole = (typeof TEAM_ADDABLE_ROLES)[number];

/** Every role a member may be moved to. */
export const TEAM_ASSIGNABLE_ROLES = ["ADMIN", "EVALUATOR", "SPEAKER"] as const satisfies readonly UserRole[];

/**
 * Organizer-facing names. `UserRole.ADMIN` is "Organizer" and `EVALUATOR` is
 * "Reviewer" because that is what the rest of the product already calls them —
 * the sidebar's `ROLE_LABELS` says "Event admin"/"Evaluator" for the signed-in
 * badge, but every organizer-facing screen (Evaluations, the reviewer invite)
 * says reviewer. The stored enum is unchanged; only the word is.
 */
export const TEAM_ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: "Organizer",
  EVALUATOR: "Reviewer",
  SPEAKER: "Speaker",
};

/** What each role may actually do, stated where an organizer picks one. */
export const TEAM_ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  ADMIN: "Full access to this event, including adding and removing other team members.",
  EVALUATOR: "Reviews the proposals they are assigned. No access to settings, decisions or this screen.",
  SPEAKER: "Their own portal only — profile, sessions and onboarding tasks.",
};

export type TeamMember = {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  joinedAt: Date;
};

/** ADMIN first, then EVALUATOR, then SPEAKER — most authority at the top. */
const ROLE_ORDER: Record<UserRole, number> = { ADMIN: 0, EVALUATOR: 1, SPEAKER: 2 };

/**
 * Stable order: role authority, then name, then user id as the final tie-break.
 * Codepoint-ordered rather than locale-collated, so two servers in different
 * locales render the same list — the rule `compareWorkspaces` and
 * `compareOpenCfpCandidates` already follow.
 */
export function compareTeamMembers(a: TeamMember, b: TeamMember): number {
  if (a.role !== b.role) return ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.userId !== b.userId) return a.userId < b.userId ? -1 : 1;
  return 0;
}

/**
 * Why this form only accepts an address that already has an account — stated
 * before the organizer types, because the obvious expectation is the opposite.
 *
 * "Forgot password" cannot help an account that has never had a password.
 * `lib/services/password-reset-token.ts` signs a reset token over a digest of
 * the credential a `User` currently stores, so an account holding none has
 * nothing to sign against; `app/api/auth/forgot/route.ts` returns early for
 * exactly that case and sends no mail, while still answering neutrally either
 * way. Nor could that person sign themselves up afterwards: `/api/auth/signup`
 * answers an address that already has a `User` row with a 409.
 *
 * So provisioning a shell account from here would create one nobody can sign in
 * to AND take away that person's own way in — permanently, since nothing in
 * this codebase deletes a `User`. The add refuses instead, and names the order
 * that works: they sign up first, the organizer adds the same address second.
 * That is exactly the flow `/welcome` and `/api/auth/continue` were built for.
 */
export const TEAM_EXISTING_ACCOUNT_NOTE =
  "This address must already have a Greenroom account. Creating one from here would leave them unable to "
  + "sign in — a new account has no password, and “Forgot password” only mails accounts that already have "
  + "one. Ask them to sign up at /signup first, then add the same address; they will land in this event the "
  + "next time they sign in.";

/**
 * "an organizer", "a reviewer". The role labels are fixed and known, so this is
 * a lookup rather than a vowel heuristic that would be wrong the first time
 * somebody adds a role starting with a silent letter.
 */
export function teamRolePhrase(role: UserRole): string {
  const label = TEAM_ROLE_LABELS[role].toLowerCase();
  return `${role === "ADMIN" ? "an" : "a"} ${label}`;
}

/**
 * The result of an add, in the organizer's words.
 *
 * `name` is the one the resolved account already stores, never anything the
 * organizer typed — the form does not ask for a name and the route writes no
 * `User` — so printing it back is also how the organizer confirms they matched
 * the person they meant.
 */
export function teamAddNotice(result: {
  name: string;
  email: string;
  role: UserRole;
  membershipCreated: boolean;
}): string {
  const role = teamRolePhrase(result.role);
  if (!result.membershipCreated) {
    return `${result.name} (${result.email}) is already ${role} on this event. Nothing changed.`;
  }
  return `${result.name} (${result.email}) is now ${role} on this event. They will see it the next time they sign in.`;
}

/** Shown when a dialog throws before it could report anything at all. */
export function teamDialogRecovery(action: "add" | "save" | "remove"): string {
  return `Could not ${action} this team member. Nothing was changed — check your connection and try again.`;
}
