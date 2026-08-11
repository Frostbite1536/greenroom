import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveSessionUser } from "@/lib/portal/user";
import { lockSpeakerProfile } from "@/lib/services/speaker-roster";
import { speakerProfileUpdateSchema } from "@/types/api";
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

  const parsed = speakerProfileUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return fail("VALIDATION_ERROR", "Profile details are invalid.", 422, parsed.error.flatten().fieldErrors);
  }

  const user = await resolveSessionUser(session);
  if (!user) return fail("UNAUTHORIZED", "Sign in to update your speaker profile.", 401);
  // `undefined` remains omitted for a true PATCH. A supplied empty value has
  // already been normalized by the schema to `null`; Prisma needs its explicit
  // database-null sentinel for the optional JSON column.
  const { socialLinks, ...textFields } = parsed.data;
  const data = socialLinks === undefined
    ? textFields
    : { ...textFields, socialLinks: socialLinks === null ? Prisma.DbNull : socialLinks };

  // GRA-05: the organizer's roster editor (`app/api/admin/speakers/route.ts`)
  // writes this same global row under `speakerProfileLockKey(userId)`. The two
  // writers must serialize on the same key or they race to the unique `userId`
  // and, worse, interleave a read-modify-write on it. Those two routes are the
  // only request-path writers of `SpeakerProfile` (the seed and the smoke
  // fixture write it offline), so locking here closes the pair.
  const profile = await prisma.$transaction(async (tx) => {
    await lockSpeakerProfile(tx, user.id);
    return tx.speakerProfile.upsert({
      where: { userId: user.id },
      update: data,
      create: { userId: user.id, ...data },
      select: { bio: true, company: true, jobTitle: true, headshotUrl: true, slideDeckUrl: true, socialLinks: true },
    });
  });

  return NextResponse.json<ApiResponse<typeof profile>>({ ok: true, data: profile });
}
