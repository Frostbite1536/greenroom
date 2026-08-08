import { prisma } from "@/lib/prisma";
import type { DemoSession } from "@/lib/auth";

export type ResolvedUser = { id: string; name: string; email: string };

/**
 * Resolve a demo session to a real DB user.
 *
 * Per the auth contract, sessions carry a synthetic id (`demo-admin`,
 * `email:someone@x.com`) and must be resolved by **lowercased email**, never by
 * `session.user.id`.
 *
 * This is on the read path of every portal render and deliberately performs no
 * writes. A signed cookie cannot create a user or grant an event membership;
 * both must already exist in the database.
 */
export async function resolveSessionUser(session: DemoSession): Promise<ResolvedUser | null> {
  const email = session.user.email.toLowerCase();
  const eventId = session.event.id;

  const existing = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      memberships: { where: { eventId }, select: { eventId: true }, take: 1 },
    },
  });

  if (!existing || existing.memberships.length === 0) return null;
  return { id: existing.id, name: existing.name, email: existing.email };
}
