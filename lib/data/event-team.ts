/**
 * Server-only projection of one event's team for `/admin/team`.
 *
 * Shaped like `lib/data/event-memberships.ts` and `lib/speakers/roster-read.ts`:
 * a typed Prisma seam here, with the ordering rule it applies living in
 * `lib/services/event-team.ts` where tests exercise it directly.
 *
 * Scope rules, all load-bearing:
 * - It is keyed on ONE event id, which every caller takes from the signed
 *   session. It is not a user directory and cannot be pointed at another event.
 * - It exposes only what the members table renders: name, email, the role on
 *   THIS event, and when they joined. No password state, no other event's
 *   membership, no profile. Listing somebody here grants nothing — the write
 *   routes re-read the caller's ADMIN row under their own lock.
 * - Bounded exactly as the operator API reads are: one extra row is fetched and
 *   the page says the list was cut, rather than reporting a partial team as a
 *   whole one. A truncated list is also why the ADMIN count below is read
 *   separately — the last-organizer warning must not be derived from a page
 *   that may be missing rows. (The refusals themselves never trust this read:
 *   they count inside the writing transaction.)
 */
import { prisma } from "@/lib/prisma";
import { OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import { compareTeamMembers, type TeamMember } from "@/lib/team/roles";

/** A team is authored by hand, a handful of people; the same bound the reviewer setup read takes. */
export const EVENT_TEAM_LIST_TAKE = OPERATOR_QUERY_LIMITS.reviewerSetupMembers;

export type EventTeamView = {
  members: TeamMember[];
  /** ADMINs on the event, counted independently of the bounded list above. */
  adminCount: number;
  /** True when the bounded read was cut, so `members` is a floor. */
  truncated: boolean;
};

export async function readEventTeam(eventId: string): Promise<EventTeamView> {
  const [rows, adminCount] = await Promise.all([
    prisma.eventMember.findMany({
      where: { eventId },
      // Cap-plus-one, then ordered by the shared rule below. The database order
      // is only there to make truncation deterministic.
      orderBy: [{ userId: "asc" }],
      take: EVENT_TEAM_LIST_TAKE + 1,
      select: {
        userId: true,
        role: true,
        createdAt: true,
        user: { select: { name: true, email: true } },
      },
    }),
    prisma.eventMember.count({ where: { eventId, role: "ADMIN" } }),
  ]);

  const truncated = rows.length > EVENT_TEAM_LIST_TAKE;
  const members = rows
    .slice(0, EVENT_TEAM_LIST_TAKE)
    .map((row): TeamMember => ({
      userId: row.userId,
      name: row.user.name,
      email: row.user.email,
      role: row.role,
      joinedAt: row.createdAt,
    }))
    .sort(compareTeamMembers);

  return { members, adminCount, truncated };
}
