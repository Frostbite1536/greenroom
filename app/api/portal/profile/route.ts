import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveSessionUser } from "@/lib/portal/user";
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
  const data = parsed.data;

  const profile = await prisma.speakerProfile.upsert({
    where: { userId: user.id },
    update: data,
    create: { userId: user.id, ...data },
    select: { bio: true, company: true, jobTitle: true, headshotUrl: true, slideDeckUrl: true, socialLinks: true },
  });

  return NextResponse.json<ApiResponse<typeof profile>>({ ok: true, data: profile });
}
