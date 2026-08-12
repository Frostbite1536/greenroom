import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { handle, ok } from "@/lib/api/http";
import { lockAbstractForWrite } from "@/lib/services/abstract-lock";
import { isAbstractSpeaker } from "@/lib/services/speaker-edit";
import {
  abstractNotFound,
  attachmentEditRefusal,
  attachmentNotFound,
} from "@/lib/services/abstract-attachment";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/cfp/submissions/:abstractId/attachments/:attachmentId
 *
 * Remove YOUR OWN supporting document from YOUR OWN proposal, while that
 * proposal is still editable.
 *
 * What this deletes is the LINK, never the bytes. The same `StoredFile` row may
 * be attached to another of the speaker's proposals — the upload pipeline
 * deduplicates identical bytes within an event, so one row genuinely can serve
 * two links — and it is still the dedupe target for the uploader's next
 * identical upload. That is the same behaviour clearing `slideDeckUrl` has
 * always had: the profile stops pointing at the deck, the deck stays stored.
 *
 * Every miss is one 404: an attachment that does not exist, one on another
 * proposal, and one somebody else attached are indistinguishable, so this route
 * cannot be used to learn that an id is real or who owns it.
 */

type Params = { params: Promise<{ abstractId: string; attachmentId: string }> };

export function DELETE(req: Request, ctx: Params) {
  return handle(async () => {
    const apiCtx = await requireContext();
    const { abstractId, attachmentId } = await ctx.params;

    await prisma.$transaction(async (tx) => {
      await lockAbstractForWrite(tx, abstractId);

      const abstract = await tx.abstract.findUnique({
        where: { id: abstractId },
        select: {
          id: true,
          eventId: true,
          status: true,
          speakers: { select: { userId: true } },
          formConfig: { select: { closesAt: true } },
        },
      });
      if (!abstract || abstract.eventId !== apiCtx.eventId) throw abstractNotFound();
      if (!isAbstractSpeaker(apiCtx.userId, abstract.speakers)) throw abstractNotFound();

      const locked = attachmentEditRefusal(abstract.status, abstract.formConfig?.closesAt ?? null);
      if (locked) throw locked;

      // Ownership is part of the WHERE, not a branch after a read: an organizer
      // does not remove a speaker's document from here, and a co-speaker does
      // not remove another speaker's. All three misses are the same 404.
      const removed = await tx.abstractAttachment.deleteMany({
        where: { id: attachmentId, abstractId, uploadedById: apiCtx.userId },
      });
      if (removed.count === 0) throw attachmentNotFound();
    });

    return ok({ removed: true });
  })(req);
}
