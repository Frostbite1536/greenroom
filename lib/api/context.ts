import type { UserRole } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api/http";

/**
 * Resolved server-side identity for API routes.
 *
 * The signed demo session identifies an email and active event, but it never
 * grants a role by itself. We resolve an existing `User` and `EventMember`
 * server-side so every protected read/write is scoped to persisted membership
 * and role (INV-EVENT-001).
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
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      memberships: {
        where: { eventId: session.event.id },
        select: { role: true },
        take: 1,
      },
    },
  });
  const membership = user?.memberships[0];
  if (!user || !membership) return null;

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: membership.role,
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
