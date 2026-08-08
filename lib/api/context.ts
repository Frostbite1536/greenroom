import type { UserRole } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api/http";

/**
 * Resolved server-side identity for API routes.
 *
 * The demo session (cookie personas) carries an email; per the locked contract
 * we resolve/ensure the backing `User` row by lowercased email — never by the
 * persona id — and ensure an `EventMember` for the active event so every
 * protected read/write is scoped to a membership + role (INV-EVENT-001).
 */
export type ApiContext = {
  userId: string;
  email: string;
  name: string;
  role: UserRole;
  eventId: string;
};

/** Resolve the current API context, or null when unauthenticated. */
export async function getApiContext(): Promise<ApiContext | null> {
  const session = await getSession();
  if (!session) return null;

  const email = session.user.email.trim().toLowerCase();
  const user = await prisma.user.upsert({
    where: { email },
    update: { name: session.user.name },
    create: { email, name: session.user.name },
    select: { id: true, email: true, name: true },
  });

  await prisma.eventMember.upsert({
    where: { eventId_userId: { eventId: session.event.id, userId: user.id } },
    update: { role: session.role },
    create: { eventId: session.event.id, userId: user.id, role: session.role },
  });

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: session.role,
    eventId: session.event.id,
  };
}

/** Require an authenticated user, optionally restricted to specific roles. */
export async function requireContext(roles?: UserRole[]): Promise<ApiContext> {
  const ctx = await getApiContext();
  if (!ctx) throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
  if (roles && !roles.includes(ctx.role)) {
    throw new ApiError(403, "FORBIDDEN", "You do not have access to this resource.");
  }
  return ctx;
}

/**
 * Assert the given event is the caller's active event. Guards against a valid
 * session acting on another event's records (INV-EVENT-001).
 */
export function assertEventScope(ctx: ApiContext, eventId: string): void {
  if (ctx.eventId !== eventId) {
    throw new ApiError(403, "EVENT_SCOPE", "Resource belongs to a different event.");
  }
}
