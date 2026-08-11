import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { eventCreateSchema } from "@/types/api";
import { encodeSession, getPendingIdentity } from "@/lib/auth";
import { getApiContext } from "@/lib/api/context";
import { ApiError, handle, ok, parseBody } from "@/lib/api/http";
import { noStore, setSessionCookie } from "@/lib/api/auth-request";
import { classifyEventCreateError, planEventCreate } from "@/lib/services/event-create";
import { serializeSettingsEvent } from "@/lib/services/event-settings";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/events — create one empty event (D-C5-9, extended by D-C5-16
 * item 2).
 *
 * The creator is made an ADMIN member of the new event in the SAME transaction:
 * an event nobody can administer would be unreachable, and a half-applied create
 * would leave exactly that. There is no delete counterpart in this slice, so a
 * partial write could not be cleaned up through the product.
 *
 * The new event starts genuinely empty — no rooms, tracks, categories or forms
 * are copied from the current one — so every surface shows its existing empty
 * state. Nothing here touches the current event or the public default event.
 */

type EventCreator =
  | { kind: "member"; userId: string }
  | { kind: "bootstrap"; user: { id: string; name: string; email: string } };

/**
 * Who may create an event.
 *
 * Two callers, and the second one is the whole reason this function replaced a
 * bare `requireContext(["ADMIN"])`:
 *
 * 1. **An ADMIN of their current event** — unchanged from D-C5-9, including the
 *    exact 401/403 codes and messages `requireContext` produced, so nothing that
 *    already depends on those refusals moves.
 * 2. **A signed identity with ZERO memberships** — someone who just used
 *    self-service signup. They cannot hold a `DemoSession` (it structurally
 *    requires an event and a role), so `getApiContext()` is null for them by
 *    design; the pending cookie is the only thing that identifies them.
 *
 * The zero-membership assertion is what bounds branch 2, and it is load-bearing
 * rather than defensive: it means this path can only ever produce someone's
 * FIRST event. It grants no authority over any existing event, cannot be used to
 * escalate inside one, and closes the moment the caller belongs to anything. A
 * pending identity that has since been added to an event falls through to the
 * same generic 401 an anonymous caller gets — they have a real way in now, and
 * `/welcome` offers it to them.
 */
async function resolveEventCreator(): Promise<EventCreator> {
  const ctx = await getApiContext();
  if (ctx) {
    if (ctx.role !== "ADMIN") throw new ApiError(403, "FORBIDDEN", "You do not have access to this resource.");
    return { kind: "member", userId: ctx.userId };
  }
  const pending = await getPendingIdentity();
  if (!pending || pending.memberships.length > 0) {
    throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
  }
  return { kind: "bootstrap", user: pending.user };
}

export const POST = handle(async (req) => {
  const creator = await resolveEventCreator();
  const input = await parseBody(req, eventCreateSchema);
  const data = planEventCreate(input);
  const userId = creator.kind === "member" ? creator.userId : creator.user.id;

  try {
    const created = await prisma.$transaction(async (tx) => {
      const event = await tx.event.create({
        data,
        select: { id: true, name: true, slug: true, timezone: true, startsAt: true, endsAt: true },
      });
      // Same transaction, not a follow-up write: the creator's ADMIN membership
      // is what makes the event administrable at all.
      await tx.eventMember.create({
        data: { eventId: event.id, userId, role: "ADMIN" },
      });
      return event;
    });

    const body = { event: serializeSettingsEvent(created) };
    if (creator.kind === "bootstrap") {
      // They now have exactly one membership, so the pending cookie has done its
      // job and is replaced — in this same response — by a real session for the
      // event that was just committed. The role is the one the transaction
      // wrote, never anything the request asked for, and the cookie is issued
      // through the one shared helper so its attributes cannot drift from the
      // login route's.
      const response = NextResponse.json({ ok: true, data: body }, { status: 201 });
      return noStore(setSessionCookie(response, encodeSession({
        user: creator.user,
        event: { id: created.id, name: created.name, slug: created.slug },
        role: "ADMIN",
      })));
    }
    return ok(body, 201);
  } catch (error) {
    if (classifyEventCreateError(error) === "EVENT_SLUG_TAKEN") {
      throw new ApiError(409, "EVENT_SLUG_TAKEN", "Another event already uses that web address.", {
        slug: ["This web address is already in use."],
      });
    }
    throw error;
  }
});
