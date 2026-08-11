import type { UserRole } from "@prisma/client";
import type { DemoSession } from "@/lib/auth";

/**
 * Switching the session's active event (D-C5-16 item 1).
 *
 * Pure and dependency-injected in the same shape as
 * `lib/services/credential-login.ts`: the route supplies `findMembership`, this
 * module owns the decision. Nothing here reads a cookie, a request, or Prisma,
 * so the policy is testable without a database.
 *
 * The S1 property this exists to hold: **the only authority is an `EventMember`
 * row for the caller's own user id.** The lookup is keyed on
 * `(userId, eventId)`, so an event that does not exist and an event the caller
 * is not a member of take the identical path and produce the identical `null` —
 * there is no Event-existence probe that could distinguish them, and no branch
 * that could grow one later without deleting this comment.
 *
 * The role is read from that membership, never from the session being replaced
 * and never from anything the client sent. A user may be ADMIN on one event and
 * SPEAKER on another; the cookie's event is what decides which role resolves
 * (`getResolvedSession` in `lib/auth.ts` re-derives it on every later request).
 */

/** `Event.id` is a cuid or a seeded literal; nothing legitimate is longer. */
export const EVENT_ID_MAX_LENGTH = 128;

export type SwitchMembership = {
  role: UserRole;
  event: { id: string; name: string; slug: string };
};

/**
 * Bound the submitted id at the boundary. Anything unusable becomes `""`, which
 * is refused before a query is issued rather than being sent to the database as
 * a truncated value that might match a different row.
 */
export function normalizeSwitchEventId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > EVENT_ID_MAX_LENGTH) return "";
  return trimmed;
}

/**
 * Resolve a switch request to the session that should replace the current one,
 * or `null` for the one indistinguishable refusal.
 *
 * The identity carried over is the caller's already-resolved one — this path
 * never re-authenticates and never widens who the session is for. Only the
 * event and the role change.
 */
export async function resolveEventSwitch(input: {
  user: { id: string; name: string; email: string };
  eventId: unknown;
  findMembership: (query: { userId: string; eventId: string }) => Promise<SwitchMembership | null>;
}): Promise<DemoSession | null> {
  const eventId = normalizeSwitchEventId(input.eventId);
  if (!eventId) return null;

  const membership = await input.findMembership({ userId: input.user.id, eventId });
  if (!membership) return null;

  return {
    user: { id: input.user.id, name: input.user.name, email: input.user.email },
    event: membership.event,
    role: membership.role,
  };
}
