import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireContext, type ApiContext } from "@/lib/api/context";
import { handle, ok, parseBody } from "@/lib/api/http";
import { lockAbstractForWrite } from "@/lib/services/abstract-lock";
import { isAbstractSpeaker } from "@/lib/services/speaker-edit";
import {
  abstractNotFound,
  attachmentAlreadyLinkedError,
  attachmentCreateSchema,
  attachmentEditRefusal,
  attachmentFilenameFor,
  attachmentLimitError,
  attachmentOrderBy,
  attachmentSelect,
  storedFileNotFound,
  toAttachmentSubject,
} from "@/lib/services/abstract-attachment";
import {
  MAX_ATTACHMENTS_PER_ABSTRACT,
  viewAttachments,
} from "@/lib/uploads/abstract-attachment";

export const dynamic = "force-dynamic";

/**
 * Supporting documents on one of the caller's own proposals (portal-side only).
 *
 * This is NOT reachable from the anonymous public CFP. Both handlers below open
 * with `requireContext()`, so an unauthenticated request is a 401 before a
 * proposal id is even looked at, and the public submit route is untouched.
 *
 * The bytes are not here. A speaker uploads through the existing pipeline
 * (`POST /api/files?kind=supporting-document` — same sniffing, same 5 MiB cap,
 * same rate buckets, same event-scoped dedupe) and then links the stored id to
 * a proposal here. The upload route therefore gained no proposal-authorization
 * surface at all.
 */

type Params = { params: Promise<{ abstractId: string }> };

const abstractSelect = {
  id: true,
  eventId: true,
  status: true,
  speakers: { select: { userId: true } },
  formConfig: { select: { closesAt: true } },
} satisfies Prisma.AbstractSelect;

/**
 * Load a proposal the caller speaks on.
 *
 * Order matters and mirrors `GET|PATCH /api/cfp/submissions/:id` exactly:
 * existence and event scope first (404 — never confirm another event's
 * records), then the `AbstractSpeaker` link. Unlike that route this collapses
 * the roster miss into the SAME 404 rather than a 403: a proposal id is not a
 * secret there because the speaker already holds it, but here an id could be
 * guessed at from a shared link, and "403" would confirm the proposal exists in
 * this event. Nothing downstream distinguishes the two cases.
 */
async function loadOwnAbstract(ctx: ApiContext, abstractId: string) {
  const abstract = await prisma.abstract.findUnique({
    where: { id: abstractId },
    select: abstractSelect,
  });
  if (!abstract || abstract.eventId !== ctx.eventId) throw abstractNotFound();
  if (!isAbstractSpeaker(ctx.userId, abstract.speakers)) throw abstractNotFound();
  return abstract;
}

type LoadedAbstract = Prisma.AbstractGetPayload<{ select: typeof abstractSelect }>;

async function listPayload(ctx: ApiContext, abstract: LoadedAbstract) {
  const rows = await prisma.abstractAttachment.findMany({
    where: { abstractId: abstract.id },
    orderBy: attachmentOrderBy,
    // Bounded by the product cap itself, plus one: a list longer than the cap
    // would mean the write path was bypassed, and the read says so rather than
    // growing without limit.
    take: MAX_ATTACHMENTS_PER_ABSTRACT + 1,
    select: attachmentSelect,
  });
  const editable = attachmentEditRefusal(abstract.status, abstract.formConfig?.closesAt ?? null) === null;
  return {
    attachments: viewAttachments(rows.map(toAttachmentSubject), ctx, { editable }),
    editable,
    maxAttachments: MAX_ATTACHMENTS_PER_ABSTRACT,
  };
}

/** GET — the caller's own proposal's supporting documents. */
export function GET(req: Request, ctx: Params) {
  return handle(async () => {
    const apiCtx = await requireContext();
    const { abstractId } = await ctx.params;
    const abstract = await loadOwnAbstract(apiCtx, abstractId);
    return ok(await listPayload(apiCtx, abstract));
  })(req);
}

/**
 * POST — link one already-stored file to this proposal.
 *
 * Everything decided under the per-abstract advisory lock, because the count and
 * the status are both check-then-write facts (INV-ABSTRACT-001's reasoning):
 * without it, three simultaneous attaches all read "2 existing" and write a
 * fourth, and an admin decision landing mid-request could make a locked proposal
 * accept a document.
 */
export function POST(req: Request, ctx: Params) {
  return handle(async () => {
    const apiCtx = await requireContext();
    const { abstractId } = await ctx.params;
    // Pre-lock load supplies immutable lock locators only; every mutable fact is
    // re-read under the lock below.
    await loadOwnAbstract(apiCtx, abstractId);
    const input = await parseBody(req, attachmentCreateSchema);

    const created = await prisma.$transaction(async (tx) => {
      await lockAbstractForWrite(tx, abstractId);

      const fresh = await tx.abstract.findUnique({ where: { id: abstractId }, select: abstractSelect });
      if (!fresh || fresh.eventId !== apiCtx.eventId) throw abstractNotFound();
      // Re-verified after the lock: a serialized earlier roster edit may have
      // removed this caller from the proposal.
      if (!isAbstractSpeaker(apiCtx.userId, fresh.speakers)) throw abstractNotFound();

      const locked = attachmentEditRefusal(fresh.status, fresh.formConfig?.closesAt ?? null);
      if (locked) throw locked;

      // The file must be the caller's OWN supporting document, stored under the
      // caller's active event — which is this proposal's event. That is what
      // makes `canReadStoredFile`'s ADMIN test (against the FILE's event) and
      // the proposal's own event the same question forever after.
      const file = await tx.storedFile.findUnique({
        where: { id: input.storedFileId },
        select: { id: true, kind: true, uploaderUserId: true, eventId: true },
      });
      if (
        !file
        || file.kind !== "SUPPORTING_DOCUMENT"
        || file.uploaderUserId !== apiCtx.userId
        || file.eventId !== fresh.eventId
      ) {
        throw storedFileNotFound();
      }

      const existingCount = await tx.abstractAttachment.count({ where: { abstractId } });
      const overLimit = attachmentLimitError(existingCount);
      if (overLimit) throw overLimit;

      try {
        return await tx.abstractAttachment.create({
          data: {
            abstractId,
            storedFileId: file.id,
            uploadedById: apiCtx.userId,
            filename: attachmentFilenameFor(input),
          },
          select: attachmentSelect,
        });
      } catch (error) {
        // The same deduped `StoredFile` linked twice to one proposal. The unique
        // key is the arbiter and the refusal is named, not a 500.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw attachmentAlreadyLinkedError();
        }
        throw error;
      }
    });

    return ok(
      {
        attachment: viewAttachments([toAttachmentSubject(created)], apiCtx, { editable: true })[0],
        maxAttachments: MAX_ATTACHMENTS_PER_ABSTRACT,
      },
      201,
    );
  })(req);
}
