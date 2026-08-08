import type { UserRole } from "@prisma/client";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { cache } from "react";
import { prisma } from "@/lib/prisma";

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
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const SESSION_SECRET_MIN_LENGTH = 32;

// This value is deliberately usable only outside production. It keeps local
// one-click demo and isolated smoke runs runnable without a committed secret.
// Production has no fallback: a missing/short SESSION_SECRET makes every
// signed-cookie decode fail closed.
const DEVELOPMENT_SESSION_SECRET = "greenroom-development-session-secret-not-for-production";

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
const HOME_BY_ROLE: Record<UserRole, string> = {
  ADMIN: "/admin/forms",
  EVALUATOR: "/admin/evaluations",
  SPEAKER: "/portal",
};

export function homeForRole(role: UserRole): string {
  return HOME_BY_ROLE[role];
}

type SignedSession = DemoSession & { iat: number; exp: number };

function getSessionSecret(): string | null {
  const configured = process.env.SESSION_SECRET?.trim();
  if (configured && configured.length >= SESSION_SECRET_MIN_LENGTH) return configured;
  return process.env.NODE_ENV === "production" ? null : DEVELOPMENT_SESSION_SECRET;
}

function isSessionShape(parsed: unknown): parsed is SignedSession {
  if (!parsed || typeof parsed !== "object") return false;
  const value = parsed as Partial<SignedSession>;
  return (
    typeof value.user?.id === "string" &&
    typeof value.user?.name === "string" &&
    typeof value.user?.email === "string" &&
    typeof value.event?.id === "string" &&
    typeof value.event?.name === "string" &&
    typeof value.event?.slug === "string" &&
    ROLES.includes(value.role as UserRole) &&
    Number.isInteger(value.iat) &&
    Number.isInteger(value.exp)
  );
}

function signatureFor(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Create a signed, expiring cookie value. Throws in production without a valid secret. */
export function encodeSession(session: DemoSession, now = Date.now()): string {
  const secret = getSessionSecret();
  if (!secret) throw new Error("SESSION_SECRET must be at least 32 characters in production.");
  const iat = Math.floor(now / 1_000);
  const payload = Buffer.from(JSON.stringify({ ...session, iat, exp: iat + SESSION_TTL_SECONDS }), "utf8").toString("base64url");
  return `${payload}.${signatureFor(payload, secret)}`;
}

/** Validate signature and expiry before returning a session. Invalid configuration fails closed. */
export function decodeSession(raw: string, now = Date.now()): DemoSession | null {
  try {
    const secret = getSessionSecret();
    const [payload, providedSignature, ...extra] = raw.split(".");
    if (!secret || !payload || !providedSignature || extra.length > 0) return null;

    const expectedSignature = signatureFor(payload, secret);
    const provided = Buffer.from(providedSignature, "base64url");
    const expected = Buffer.from(expectedSignature, "base64url");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isSessionShape(parsed)) return null;
    const currentSecond = Math.floor(now / 1_000);
    if (parsed.exp <= currentSecond || parsed.exp <= parsed.iat) return null;

    return {
      user: parsed.user,
      event: parsed.event,
      role: parsed.role,
    };
  } catch {
    return null;
  }
}

export const getSession = cache(async (): Promise<DemoSession | null> => {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  return raw ? decodeSession(raw) : null;
});

/** Resolve a signed identity to its current persisted event membership and role. */
export const getResolvedSession = cache(async (): Promise<DemoSession | null> => {
  const session = await getSession();
  if (!session) return null;

  const email = session.user.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      memberships: { where: { eventId: session.event.id }, select: { role: true }, take: 1 },
    },
  });
  const membership = user?.memberships[0];
  if (!user || !membership) return null;
  return {
    ...session,
    user: { id: user.id, name: user.name, email: user.email },
    role: membership.role,
  };
});

async function redirectToLogin(): Promise<never> {
  const { redirect } = await import("next/navigation");
  redirect("/login");
  throw new Error("redirect() unexpectedly returned");
}

export async function requireSession(roles?: UserRole[]): Promise<DemoSession> {
  const session = await getResolvedSession();
  if (!session || (roles && !roles.includes(session.role))) {
    return redirectToLogin();
  }
  return session;
}
