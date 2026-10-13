import type { UserRole } from "@prisma/client";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { getServerSigningSecret } from "@/lib/server-signing";

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

/**
 * A signed identity that has no `EventMember` row yet (D-C5-16 item 2).
 *
 * Self-service signup creates a real `User` with a real credential, and that
 * person is genuinely authenticated — but `DemoSession` cannot describe them:
 * it structurally requires an event and a role, and every authorization decision
 * in the product reads those two fields. Widening `DemoSession` to make them
 * nullable would push a null check into every consumer of `requireSession`, and
 * anywhere it was missed would be an authorization bug.
 *
 * So this is a **second payload variant in the same signed cookie**, not a
 * second session type. It rides the identical HMAC, TTL and cookie attributes,
 * and it is deliberately DISJOINT from `DemoSession`: `isSessionShape` requires
 * `event` and `role`, `isPendingShape` requires `pending: true`, and no payload
 * can satisfy both. The consequence is the property that matters — a pending
 * cookie is invisible to `getSession`, `getResolvedSession`, `requireSession`
 * and `getApiContext`, so it grants exactly zero authority anywhere. Only
 * surfaces that explicitly ask for it (`/welcome`, the first-event bootstrap)
 * can see it at all.
 */
export type PendingSession = {
  user: { id: string; name: string; email: string };
  pending: true;
};

/** @deprecated legacy alias from the mock-auth scaffold */
export type MockSession = DemoSession;

export const SESSION_COOKIE = "sb_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export const DEMO_EVENT = {
  id: "demo-event",
  name: "Forward 2026",
  slug: "forward-2026",
} as const;

/**
 * The three one-click personas. Their addresses are on the DELIVERABLE
 * `greenroom-hq.com` domain so a live email proof reaches a real inbox; they
 * must stay byte-identical to `lib/demo/seed.ts` `DEMO_SEED_PERSONAS`, because
 * `getResolvedSession()` resolves a signed cookie to a `User` row by email.
 * `lib/demo/seed-credentials.test.ts` guards that agreement in both directions.
 */
export const DEMO_PERSONAS = {
  admin: {
    user: { id: "demo-admin", name: "Maya Chen", email: "maya@greenroom-hq.com" },
    event: DEMO_EVENT,
    role: "ADMIN",
  },
  evaluator: {
    user: { id: "demo-evaluator", name: "Ravi Patel", email: "ravi@greenroom-hq.com" },
    event: DEMO_EVENT,
    role: "EVALUATOR",
  },
  speaker: {
    user: { id: "demo-speaker", name: "Sofia Marques", email: "sofia@greenroom-hq.com" },
    event: DEMO_EVENT,
    role: "SPEAKER",
  },
} satisfies Record<string, DemoSession>;

export type PersonaKey = keyof typeof DEMO_PERSONAS;

const ROLES: UserRole[] = ["ADMIN", "EVALUATOR", "SPEAKER"];
const HOME_BY_ROLE: Record<UserRole, string> = {
  // Organizers land on the dashboard (B7), the at-a-glance state of their event.
  ADMIN: "/admin",
  EVALUATOR: "/admin/evaluations",
  SPEAKER: "/portal",
};

export function homeForRole(role: UserRole): string {
  return HOME_BY_ROLE[role];
}

/**
 * `cf` is the credential fingerprint (SEC-03): an HMAC of the user's stored
 * password hash when the cookie was issued. Every resolve recomputes it from the
 * current row, so changing or resetting a password invalidates every cookie
 * issued before the change. A cookie without one (issued before SEC-03) matches
 * neither shape and is simply signed out.
 */
type SignedEnvelope = { iat: number; exp: number; cf: string };
type SignedSession = DemoSession & SignedEnvelope;
type SignedPending = PendingSession & SignedEnvelope;

function isIdentityShape(value: { user?: { id?: unknown; name?: unknown; email?: unknown } }): boolean {
  return (
    typeof value.user?.id === "string" &&
    typeof value.user?.name === "string" &&
    typeof value.user?.email === "string"
  );
}

function isSessionShape(parsed: unknown): parsed is SignedSession {
  if (!parsed || typeof parsed !== "object") return false;
  const value = parsed as Partial<SignedSession>;
  return (
    isIdentityShape(value) &&
    typeof value.event?.id === "string" &&
    typeof value.event?.name === "string" &&
    typeof value.event?.slug === "string" &&
    ROLES.includes(value.role as UserRole) &&
    Number.isInteger(value.iat) &&
    Number.isInteger(value.exp) &&
    typeof value.cf === "string"
  );
}

/**
 * The pending variant, and the reason the two can never be confused: this
 * requires the literal `pending: true` marker, `isSessionShape` requires an
 * event and a role, and neither tolerates the other's payload.
 */
function isPendingShape(parsed: unknown): parsed is SignedPending {
  if (!parsed || typeof parsed !== "object") return false;
  const value = parsed as Partial<SignedPending> & { event?: unknown; role?: unknown };
  return (
    value.pending === true &&
    isIdentityShape(value) &&
    value.event === undefined &&
    value.role === undefined &&
    Number.isInteger(value.iat) &&
    Number.isInteger(value.exp) &&
    typeof value.cf === "string"
  );
}

function signatureFor(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** One signer for both payload variants: identical HMAC, identical lifetime. */
function signCookiePayload(body: object, cf: string, now: number): string {
  const secret = getServerSigningSecret();
  if (!secret) throw new Error("SESSION_SECRET must be at least 32 characters in production.");
  const iat = Math.floor(now / 1_000);
  const payload = Buffer.from(JSON.stringify({ ...body, cf, iat, exp: iat + SESSION_TTL_SECONDS }), "utf8").toString("base64url");
  return `${payload}.${signatureFor(payload, secret)}`;
}

/**
 * The credential fingerprint a session for this stored password hash carries
 * (SEC-03). Keyed to the server secret and domain-separated from every other
 * HMAC in the app, so the cookie reveals nothing about the hash. A user with no
 * password (an invited reviewer, say) gets the fingerprint of the empty
 * credential, which changes the moment they set one.
 */
export function sessionCredentialFingerprint(passwordHash: string | null | undefined): string {
  const secret = getServerSigningSecret();
  if (!secret) throw new Error("SESSION_SECRET must be at least 32 characters in production.");
  return createHmac("sha256", secret)
    .update(`greenroom:session:credential:v1\0${passwordHash ?? ""}`)
    .digest("base64url");
}

/** Constant-time: does the cookie's fingerprint match the user's current credential? */
export function isSessionCredentialCurrent(cf: string, passwordHash: string | null | undefined): boolean {
  try {
    const provided = Buffer.from(cf, "base64url");
    const expected = Buffer.from(sessionCredentialFingerprint(passwordHash), "base64url");
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

/** The stored credential an issued cookie is bound to, read at issue time. */
async function currentPasswordHash(email: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: { passwordHash: true },
  });
  return user?.passwordHash ?? null;
}

/**
 * One verifier: signature, then envelope expiry. Returns the raw parsed payload
 * with no opinion about which variant it is — the callers below decide that, and
 * a payload that satisfies neither shape check is simply rejected.
 */
function verifyCookiePayload(raw: string, now: number): unknown {
  try {
    const secret = getServerSigningSecret();
    const [payload, providedSignature, ...extra] = raw.split(".");
    if (!secret || !payload || !providedSignature || extra.length > 0) return null;

    const expectedSignature = signatureFor(payload, secret);
    const provided = Buffer.from(providedSignature, "base64url");
    const expected = Buffer.from(expectedSignature, "base64url");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const envelope = parsed as Partial<SignedEnvelope>;
    if (!Number.isInteger(envelope.iat) || !Number.isInteger(envelope.exp)) return null;
    const currentSecond = Math.floor(now / 1_000);
    if (envelope.exp! <= currentSecond || envelope.exp! <= envelope.iat!) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Sign a session bound to an explicit credential fingerprint. Pure: tests and
 * callers that already hold the fingerprint use this; everything that issues a
 * real cookie uses `encodeSession`, which reads the credential itself.
 */
export function signSession(session: DemoSession, cf: string, now = Date.now()): string {
  return signCookiePayload(session, cf, now);
}

/** The pending counterpart of `signSession`. */
export function signPendingSession(identity: PendingSession["user"], cf: string, now = Date.now()): string {
  return signCookiePayload({ user: identity, pending: true }, cf, now);
}

/**
 * Create a signed, expiring cookie value bound to the user's current credential
 * (SEC-03). Async because it reads that credential: every issuer gets the
 * binding without having to remember it. Throws in production without a valid
 * secret.
 */
export async function encodeSession(session: DemoSession, now = Date.now()): Promise<string> {
  const cf = sessionCredentialFingerprint(await currentPasswordHash(session.user.email));
  return signSession(session, cf, now);
}

/**
 * Create the pending variant for an identity with no membership yet. Same
 * cookie, same signature, same lifetime, same credential binding — it simply
 * carries no authority.
 */
export async function encodePendingSession(identity: PendingSession["user"], now = Date.now()): Promise<string> {
  const cf = sessionCredentialFingerprint(await currentPasswordHash(identity.email));
  return signPendingSession(identity, cf, now);
}

/** Signature, expiry and shape, plus the fingerprint the resolvers check. */
function decodeSignedSession(raw: string, now: number): { session: DemoSession; cf: string } | null {
  const parsed = verifyCookiePayload(raw, now);
  if (!isSessionShape(parsed)) return null;
  return { session: { user: parsed.user, event: parsed.event, role: parsed.role }, cf: parsed.cf };
}

function decodeSignedPending(raw: string, now: number): { pending: PendingSession; cf: string } | null {
  const parsed = verifyCookiePayload(raw, now);
  if (!isPendingShape(parsed)) return null;
  return { pending: { user: parsed.user, pending: true }, cf: parsed.cf };
}

/**
 * Validate signature and expiry before returning a session. Invalid configuration
 * fails closed. This does NOT check the credential binding — only the resolvers
 * below can, because only they read the user row.
 */
export function decodeSession(raw: string, now = Date.now()): DemoSession | null {
  return decodeSignedSession(raw, now)?.session ?? null;
}

/** The pending counterpart. Returns null for a real session, and vice versa. */
export function decodePendingSession(raw: string, now = Date.now()): PendingSession | null {
  return decodeSignedPending(raw, now)?.pending ?? null;
}

/**
 * The cookie's claim, unresolved and NOT credential-checked. Authorization must
 * use `getResolvedSession` (or `requireSession` / `getApiContext`), which is the
 * only reader that enforces revocation.
 */
export const getSession = cache(async (): Promise<DemoSession | null> => {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  return raw ? decodeSession(raw) : null;
});

/**
 * Resolve a signed identity to its current persisted event membership and role,
 * and refuse it when the user's credential has changed since it was issued.
 */
export const getResolvedSession = cache(async (): Promise<DemoSession | null> => {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  const signed = raw ? decodeSignedSession(raw, Date.now()) : null;
  if (!signed) return null;
  const { session, cf } = signed;

  const email = session.user.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      passwordHash: true,
      memberships: { where: { eventId: session.event.id }, select: { role: true }, take: 1 },
    },
  });
  const membership = user?.memberships[0];
  if (!user || !membership) return null;
  if (!isSessionCredentialCurrent(cf, user.passwordHash)) return null;
  return {
    ...session,
    user: { id: user.id, name: user.name, email: user.email },
    role: membership.role,
  };
});

/**
 * A pending identity, re-resolved against the database on every read.
 *
 * `memberships` is what the cookie deliberately does NOT carry: an organizer may
 * have added this person to an event since they signed up, and the welcome page
 * has to be able to see that and offer them the way in. It is read here rather
 * than trusted from the cookie for the same reason `getResolvedSession` re-reads
 * the role — a signed claim identifies someone, it never grants them anything.
 *
 * Returns null when the cookie is absent, is a real session, is unsigned or
 * expired, or names a `User` row that no longer exists.
 */
export type PendingIdentity = {
  user: { id: string; name: string; email: string };
  memberships: { role: UserRole; event: { id: string; name: string; slug: string } }[];
};

export const getPendingIdentity = cache(async (): Promise<PendingIdentity | null> => {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  const signed = raw ? decodeSignedPending(raw, Date.now()) : null;
  if (!signed) return null;
  const { pending, cf } = signed;

  const email = pending.user.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      passwordHash: true,
      memberships: { select: { role: true, event: { select: { id: true, name: true, slug: true } } } },
    },
  });
  if (!user) return null;
  if (!isSessionCredentialCurrent(cf, user.passwordHash)) return null;
  return {
    user: { id: user.id, name: user.name, email: user.email },
    memberships: user.memberships,
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
