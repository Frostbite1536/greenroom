import type { UserRole } from "@prisma/client";
import { cookies } from "next/headers";
import { cache } from "react";

/**
 * Demo auth: a cookie-backed session with one-click personas.
 *
 * Contract for workers:
 * - `getSession()` returns the current session or null. Public routes
 *   (`/cfp/*`, `/embed/*`, `/login`) must work with a null session.
 * - `requireSession(roles?)` returns the session or throws a redirect to
 *   `/login`. Use it in server components/actions under `(app)` routes.
 * - Session users map to seeded `User` rows by email once the DB is live;
 *   look users up by `session.user.email`, not by id.
 */
export type DemoSession = {
  user: { id: string; name: string; email: string };
  event: { id: string; name: string; slug: string };
  role: UserRole;
};

/** @deprecated legacy alias from the mock-auth scaffold */
export type MockSession = DemoSession;

export const SESSION_COOKIE = "sb_session";

export const DEMO_EVENT = {
  id: "demo-event",
  name: "Forward 2026",
  slug: "forward-2026",
} as const;

export const DEMO_PERSONAS = {
  admin: {
    user: { id: "demo-admin", name: "Maya Chen", email: "maya@greenroom.demo" },
    event: DEMO_EVENT,
    role: "ADMIN",
  },
  evaluator: {
    user: { id: "demo-evaluator", name: "Ravi Patel", email: "ravi@greenroom.demo" },
    event: DEMO_EVENT,
    role: "EVALUATOR",
  },
  speaker: {
    user: { id: "demo-speaker", name: "Sofia Marques", email: "sofia@greenroom.demo" },
    event: DEMO_EVENT,
    role: "SPEAKER",
  },
} satisfies Record<string, DemoSession>;

export type PersonaKey = keyof typeof DEMO_PERSONAS;

const ROLES: UserRole[] = ["ADMIN", "EVALUATOR", "SPEAKER"];

export function encodeSession(session: DemoSession): string {
  return Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
}

export function decodeSession(raw: string): DemoSession | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      typeof parsed?.user?.id === "string" &&
      typeof parsed?.user?.name === "string" &&
      typeof parsed?.user?.email === "string" &&
      typeof parsed?.event?.id === "string" &&
      ROLES.includes(parsed?.role)
    ) {
      return parsed as DemoSession;
    }
    return null;
  } catch {
    return null;
  }
}

export const getSession = cache(async (): Promise<DemoSession | null> => {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  return raw ? decodeSession(raw) : null;
});

export async function requireSession(roles?: UserRole[]): Promise<DemoSession> {
  const session = await getSession();
  if (!session || (roles && !roles.includes(session.role))) {
    const { redirect } = await import("next/navigation");
    redirect("/login");
  }
  return session as DemoSession;
}
