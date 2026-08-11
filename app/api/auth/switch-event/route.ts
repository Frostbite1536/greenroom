import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  encodeSession,
  getResolvedSession,
  homeForRole,
  type DemoSession,
} from "@/lib/auth";
import { diagnosticLabel } from "@/lib/diagnostic-label";
import { parseBoundedText } from "@/lib/api/bounded-json";
import {
  classifyRequestOrigin,
  expectedRequestOrigins,
  isSameOriginRequest,
} from "@/lib/services/request-origin";
import { resolveEventSwitch, type SwitchMembership } from "@/lib/services/event-switch";

/**
 * Switch the session's active event (D-C5-16 item 1).
 *
 * The counterpart to `/api/auth/login`, and deliberately built from the same
 * parts: one POST path serves the shell's plain HTML form (which needs 303s)
 * and an API client (which needs status codes), chosen by the request's own
 * content type. Session mechanics are **imported, not reimplemented** —
 * `encodeSession`, `SESSION_COOKIE` and `SESSION_TTL_SECONDS` come from
 * `lib/auth.ts`, so the re-issued cookie is signed and expires exactly as the
 * one login issues.
 *
 * Invariants:
 * - **The membership is the only authority.** The target event is checked
 *   against an `EventMember` row for the caller's own user id, resolved
 *   server-side. An event id the caller does not belong to and an event id that
 *   does not exist are one indistinguishable refusal (`404 EVENT_NOT_FOUND`),
 *   so this endpoint cannot enumerate other people's events.
 * - **The role comes from the target membership**, not from the session being
 *   replaced. The same person may be ADMIN on one event and SPEAKER on another;
 *   the cookie's event is what decides which role resolves, and the redirect
 *   lands on `homeForRole()` of the role held *there*.
 * - **Same-origin only.** Like login, this writes the session cookie, so a
 *   cross-origin form post could otherwise move a victim's workspace under
 *   them. Both modes are gated, before the body is read.
 * - **A refusal changes nothing.** No cookie is set on any path but success, so
 *   a refused switch leaves the caller on their current event with their
 *   current role.
 *
 * Not rate-limited, unlike login: this route requires an already-authenticated
 * session, only ever reads the caller's own memberships, and answers every
 * miss identically — there is no oracle here to throttle.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A switch post is one id; anything larger is not one. */
export const SWITCH_BODY_MAX_BYTES = 4 * 1024;

const NOT_FOUND_CODE = "EVENT_NOT_FOUND";
const NOT_FOUND_MESSAGE = "Event not found.";
const UNAUTHENTICATED_CODE = "UNAUTHENTICATED";
const UNAUTHENTICATED_MESSAGE = "Sign in to continue.";
const CROSS_ORIGIN_CODE = "CROSS_ORIGIN_REFUSED";
const CROSS_ORIGIN_MESSAGE =
  "Switching events must be submitted from this site. Send an Origin header matching this deployment.";
const UNAVAILABLE_CODE = "SWITCH_UNAVAILABLE";
const UNAVAILABLE_MESSAGE = "Switching events is temporarily unavailable.";

function noStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

function isFormEncoded(req: Request): boolean {
  const contentType = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  return contentType === "application/x-www-form-urlencoded";
}

function redirectTo(req: Request, path: string): NextResponse {
  // Same-origin form navigation, so the request's own origin is the correct base.
  return NextResponse.redirect(new URL(path, req.url), 303);
}

/**
 * Never throws. A malformed, oversized or absent body yields an empty id, which
 * the resolver refuses exactly as it refuses a wrong one — a parse failure must
 * not be a different observable outcome from a miss.
 */
async function readRequestedEventId(req: Request, formEncoded: boolean): Promise<string> {
  try {
    const text = await parseBoundedText(req, SWITCH_BODY_MAX_BYTES, NOT_FOUND_CODE, NOT_FOUND_MESSAGE);
    if (formEncoded) return new URLSearchParams(text).get("eventId") ?? "";
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    const value = (parsed as Record<string, unknown>).eventId;
    return typeof value === "string" ? value : "";
  } catch (error) {
    console.warn("[switch-event] request body rejected", diagnosticLabel(error));
    return "";
  }
}

/**
 * Refusals send the caller back where they already were, with the session
 * untouched. An unauthenticated caller has no "where", so they get `/login`.
 */
function refuse(
  req: Request,
  formEncoded: boolean,
  status: number,
  code: string,
  message: string,
  current: DemoSession | null,
): Response {
  if (formEncoded) return noStore(redirectTo(req, current ? homeForRole(current.role) : "/login"));
  return noStore(NextResponse.json({ ok: false, error: { code, message } }, { status }));
}

function establish(req: Request, formEncoded: boolean, session: DemoSession): Response {
  const home = homeForRole(session.role);
  const response = formEncoded
    ? redirectTo(req, home)
    : NextResponse.json(
        { ok: true, data: { redirectTo: home, role: session.role, eventId: session.event.id } },
        { status: 200 },
      );
  response.cookies.set(SESSION_COOKIE, encodeSession(session), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
    secure: process.env.NODE_ENV === "production",
  });
  return noStore(response);
}

/**
 * The single membership probe. Keyed on the composite primary key
 * `@@id([eventId, userId])`, so it is one index hit that either is the caller's
 * membership or is nothing at all — never a question about the event itself.
 */
async function findMembership(query: { userId: string; eventId: string }): Promise<SwitchMembership | null> {
  return prisma.eventMember.findUnique({
    where: { eventId_userId: { eventId: query.eventId, userId: query.userId } },
    select: { role: true, event: { select: { id: true, name: true, slug: true } } },
  });
}

function originVerdict(req: Request) {
  return classifyRequestOrigin({
    origin: req.headers.get("origin"),
    referer: req.headers.get("referer"),
    expected: expectedRequestOrigins({
      requestUrl: req.url,
      host: req.headers.get("host"),
      forwardedHost: req.headers.get("x-forwarded-host"),
      forwardedProto: req.headers.get("x-forwarded-proto"),
      appUrl: process.env.APP_URL,
    }),
  });
}

export async function POST(req: Request): Promise<Response> {
  const formEncoded = isFormEncoded(req);
  // Before the body is read and before any identity is resolved: a request that
  // cannot prove it came from this site never reaches either.
  if (!isSameOriginRequest(originVerdict(req))) {
    return refuse(req, formEncoded, 403, CROSS_ORIGIN_CODE, CROSS_ORIGIN_MESSAGE, null);
  }

  const current = await getResolvedSession();
  if (!current) {
    return refuse(req, formEncoded, 401, UNAUTHENTICATED_CODE, UNAUTHENTICATED_MESSAGE, null);
  }

  const requested = await readRequestedEventId(req, formEncoded);

  try {
    const next = await resolveEventSwitch({ user: current.user, eventId: requested, findMembership });
    if (!next) return refuse(req, formEncoded, 404, NOT_FOUND_CODE, NOT_FOUND_MESSAGE, current);
    return establish(req, formEncoded, next);
  } catch (error) {
    // Deliberately NOT folded into the 404: a database outage is not "you are
    // not a member of that event", and reporting it as one would send an
    // organizer hunting a permissions problem that does not exist.
    console.error("[switch-event] switch could not be completed", diagnosticLabel(error));
    return refuse(req, formEncoded, 503, UNAVAILABLE_CODE, UNAVAILABLE_MESSAGE, current);
  }
}
