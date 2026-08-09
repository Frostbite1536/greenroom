import { prisma } from "@/lib/prisma";
import { publicDraftResumeSchema } from "@/types/api";
import { ApiError, fromZod, handle, ok } from "@/lib/api/http";
import { parseBoundedJson } from "@/lib/api/bounded-json";
import { matchesDraftCapability } from "@/lib/services/draft-capability";
import { getServerSigningSecret } from "@/lib/server-signing";

export const dynamic = "force-dynamic";

function draftNotFound(): ApiError {
  return new ApiError(404, "DRAFT_NOT_FOUND", "Draft not found.");
}

function noStore<T>(data: T): Response {
  const response = ok(data);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/**
 * Recover only the editable state for an anonymous DRAFT. Capabilities are
 * body-only and are never reflected in the response, URL, or cache key.
 */
export const POST = handle(async (req) => {
  const parsed = publicDraftResumeSchema.safeParse(await parseBoundedJson(req));
  if (!parsed.success) throw fromZod(parsed.error);
  const input = parsed.data;
  const secret = getServerSigningSecret();
  if (!secret) {
    throw new ApiError(503, "DRAFT_CAPABILITY_UNAVAILABLE", "Draft recovery is temporarily unavailable.");
  }

  const draft = await prisma.abstract.findUnique({
    where: { id: input.abstractId },
    include: {
      speakers: { include: { user: { select: { email: true, name: true } } } },
      answers: { include: { formField: { select: { key: true } } } },
    },
  });
  if (
    !draft ||
    draft.formConfigId !== input.formConfigId ||
    draft.status !== "DRAFT" ||
    !input.draftCapability ||
    !matchesDraftCapability(draft.draftCapabilityHash, input.draftCapability, secret)
  ) {
    throw draftNotFound();
  }

  return noStore({
    id: draft.id,
    title: draft.title,
    abstract: draft.abstract,
    format: draft.format,
    durationMinutes: draft.durationMinutes,
    categoryId: draft.categoryId,
    speakers: draft.speakers.map((speaker) => ({
      email: speaker.user.email,
      name: speaker.user.name,
      isPrimary: speaker.isPrimary,
    })),
    answersByKey: Object.fromEntries(draft.answers.map((answer) => [answer.formField.key, answer.value])),
    draftRevision: draft.draftRevision,
  });
});
