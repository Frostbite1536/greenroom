import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveSessionUser } from "@/lib/portal/user";
import { lockSpeakerProfile } from "@/lib/services/speaker-roster";
import { portalProfileUpdateSchema } from "@/types/api";
import type { ApiResponse } from "@/types/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(code: string, message: string, status: number, fieldErrors?: Record<string, string[]>) {
  return NextResponse.json<ApiResponse<never>>({ ok: false, error: { code, message, fieldErrors } }, { status });
}

/** Update the signed-in speaker's own profile. A speaker can only ever edit themselves. */
export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) return fail("UNAUTHORIZED", "Sign in to update your speaker profile.", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_JSON", "Request body must be valid JSON.", 400);
  }

  const parsed = portalProfileUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return fail("VALIDATION_ERROR", "Profile details are invalid.", 422, parsed.error.flatten().fieldErrors);
  }

  const user = await resolveSessionUser(session);
  if (!user) return fail("UNAUTHORIZED", "Sign in to update your speaker profile.", 401);
  // `undefined` remains omitted for a true PATCH. A supplied empty value has
  // already been normalized by the schema to `null`; Prisma needs its explicit
  // database-null sentinel for the optional JSON column.
  //
  // `eventSlideDeckUrl` is separated out before anything reaches Prisma: it is
  // not a `SpeakerProfile` column and must never be spread onto that write.
  const { socialLinks, eventSlideDeckUrl, ...textFields } = parsed.data;
  const data = socialLinks === undefined
    ? textFields
    : { ...textFields, socialLinks: socialLinks === null ? Prisma.DbNull : socialLinks };

  // The event this session is on. The association is written for THIS event and
  // no other, from the signed session — never from the request body, which
  // carries no event id and is `.strict()`-adjacent by construction.
  const eventId = session.event.id;

  // GRA-05: the organizer's roster editor (`app/api/admin/speakers/route.ts`)
  // writes this same global row under `speakerProfileLockKey(userId)`. The two
  // writers must serialize on the same key or they race to the unique `userId`
  // and, worse, interleave a read-modify-write on it. Those two routes are the
  // only request-path writers of `SpeakerProfile` (the seed and the smoke
  // fixture write it offline), so locking here closes the pair.
  //
  // The per-event deck association is written inside the SAME transaction and
  // under that same key. It is keyed `(eventId, userId)` rather than `userId`,
  // so it cannot collide with the organizer's write — but a save that stored the
  // global deck and then failed to store this event's would leave the speaker
  // looking at a fallback they thought they had replaced.
  const saved = await prisma.$transaction(async (tx) => {
    await lockSpeakerProfile(tx, user.id);
    const profile = await tx.speakerProfile.upsert({
      where: { userId: user.id },
      update: data,
      create: { userId: user.id, ...data },
      select: { bio: true, company: true, jobTitle: true, headshotUrl: true, slideDeckUrl: true, socialLinks: true },
    });

    if (eventSlideDeckUrl !== undefined) {
      if (eventSlideDeckUrl === null) {
        // A deliberate clear removes THIS event's deck only. The global column
        // is untouched and becomes the fallback again — which the form states
        // in as many words, because silently re-showing the old value would
        // read as a save that did not take.
        await tx.eventSpeakerDeck.deleteMany({ where: { eventId, userId: user.id } });
      } else {
        await tx.eventSpeakerDeck.upsert({
          where: { eventId_userId: { eventId, userId: user.id } },
          update: { deckUrl: eventSlideDeckUrl },
          create: { eventId, userId: user.id, deckUrl: eventSlideDeckUrl },
          select: { id: true },
        });
      }
    }

    // Read back rather than echo the input: an omitted key must return what is
    // stored, so the form's post-save reconciliation compares against truth.
    const deck = await tx.eventSpeakerDeck.findUnique({
      where: { eventId_userId: { eventId, userId: user.id } },
      select: { deckUrl: true },
    });

    return { ...profile, eventSlideDeckUrl: deck?.deckUrl ?? null };
  });

  return NextResponse.json<ApiResponse<typeof saved>>({ ok: true, data: saved });
}
