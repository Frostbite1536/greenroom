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
 * This is on the read path of every portal render, so it is deliberately
 * **read-first**: the steady state is a single indexed `SELECT` with no writes.
 * We only write on genuine first touch, which happens for login-as-any-email
 * personas that have never been seen before (seeded users always take the read
 * path). Keeping reads write-free avoids needless load and lock contention on
 * the shared demo database.
 */
export async function resolveSessionUser(session: DemoSession): Promise<ResolvedUser> {
  const email = session.user.email.toLowerCase();
  const eventId = session.event.id;

  // Fast path: user already exists. Fetch membership in the same round trip.
  const existing = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      memberships: { where: { eventId }, select: { eventId: true }, take: 1 },
    },
  });

  if (existing) {
    // Backfill membership only if it is actually missing (INV-EVENT-001).
    if (existing.memberships.length === 0) {
      await prisma.eventMember.create({
        data: { eventId, userId: existing.id, role: session.role },
      });
    }
    return { id: existing.id, name: existing.name, email: existing.email };
  }

  // Slow path: first touch for this email. Create the shell user and membership
  // together — same shape the CFP submission API creates for co-speakers.
  const created = await prisma.user.create({
    data: {
      email,
      name: session.user.name,
      memberships: { create: { eventId, role: session.role } },
    },
    select: { id: true, name: true, email: true },
  });

  return created;
}
