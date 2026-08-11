import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api/http";
import { idSchema } from "@/types/api";
import { speakerEditRefusal } from "@/lib/services/speaker-edit";
import {
  ATTACHMENT_ALREADY_LINKED_CODE,
  ATTACHMENT_FILENAME_MAX_LENGTH,
  attachmentAlreadyLinkedMessage,
  attachmentCountVerdict,
  attachmentFilename,
  type AttachmentSubject,
} from "@/lib/uploads/abstract-attachment";

/**
 * Server-side rules for supporting documents on a proposal.
 *
 * The bytes never pass through here. A speaker uploads through the EXISTING
 * pipeline (`POST /api/files?kind=supporting-document`) — same magic-byte
 * sniffing, same 5 MiB cap, same rate buckets, same event-scoped dedupe — and
 * then LINKS the resulting `StoredFile` to one of their own proposals. Splitting
 * it that way is what let the upload route stay untouched: it has no proposal in
 * scope and gains no new authorization surface.
 *
 * Refusals, in the shapes this repo already uses:
 *   - a proposal in another event, or one the caller does not speak on, is the
 *     same 404 as one that does not exist (`ABSTRACT_NOT_FOUND`)
 *   - a proposal past its edit window is 409, with the SAME refusal the editor
 *     itself renders (`speakerEditRefusal`), never a second rule
 *   - a fourth document is 409 `ATTACHMENT_LIMIT_REACHED`
 *   - a file that is not the caller's own supporting document is 404
 */

export const attachmentCreateSchema = z
  .object({
    /** The id `POST /api/files` returned. Bytes are already stored and verified. */
    storedFileId: idSchema,
    /** Display label only. Normalized on the way in; never a path. */
    filename: z.string().trim().max(ATTACHMENT_FILENAME_MAX_LENGTH).optional(),
  })
  .strict();

export type AttachmentCreateInput = z.infer<typeof attachmentCreateSchema>;

/** One indistinguishable refusal for unknown, cross-event, and foreign proposals. */
export function abstractNotFound(): ApiError {
  return new ApiError(404, "ABSTRACT_NOT_FOUND", "We couldn't find that submission.");
}

/**
 * One indistinguishable refusal for a stored file that does not exist, belongs
 * to somebody else, was uploaded under a different event, or is not a supporting
 * document. Same reasoning as `/api/files/:id`: this must not become an oracle
 * that tells a caller which file ids are real.
 */
export function storedFileNotFound(): ApiError {
  return new ApiError(404, "FILE_NOT_FOUND", "File not found.");
}

/** One indistinguishable refusal for an attachment id that is not the caller's own. */
export function attachmentNotFound(): ApiError {
  return new ApiError(404, "ATTACHMENT_NOT_FOUND", "That attachment is no longer on this proposal.");
}

/**
 * The edit-window refusal, taken from the same function that produces the
 * page's own `canEdit`/`lockReason`. Attaching a document to a proposal is an
 * edit to it, so it is refused in exactly the cases an edit is: a terminal
 * status (`ABSTRACT_LOCKED`) and then a closed call for proposals. Restating
 * the status list here is precisely how the two would drift apart.
 */
export function attachmentEditRefusal(
  status: Parameters<typeof speakerEditRefusal>[0],
  closesAt: Date | null,
  now?: Date,
): ApiError | null {
  const refusal = speakerEditRefusal(status, closesAt, now);
  return refusal ? new ApiError(409, refusal.code, refusal.message) : null;
}

export function attachmentLimitError(existingCount: number): ApiError | null {
  const verdict = attachmentCountVerdict(existingCount);
  return verdict.ok ? null : new ApiError(409, verdict.code, verdict.message);
}

export function attachmentAlreadyLinkedError(): ApiError {
  return new ApiError(409, ATTACHMENT_ALREADY_LINKED_CODE, attachmentAlreadyLinkedMessage);
}

/** The row shape both the portal list and the admin drawer read. */
export const attachmentSelect = {
  id: true,
  filename: true,
  createdAt: true,
  uploadedById: true,
  uploadedBy: { select: { name: true } },
  storedFileId: true,
  storedFile: { select: { size: true, mime: true, eventId: true } },
} satisfies Prisma.AbstractAttachmentSelect;

type AttachmentRow = Prisma.AbstractAttachmentGetPayload<{ select: typeof attachmentSelect }>;

/** Stored row → the pure projection's input. No policy decided here. */
export function toAttachmentSubject(row: AttachmentRow): AttachmentSubject {
  return {
    id: row.id,
    filename: row.filename,
    createdAt: row.createdAt.toISOString(),
    uploadedByUserId: row.uploadedById,
    uploadedByName: row.uploadedBy.name,
    storedFileId: row.storedFileId,
    size: row.storedFile.size,
    mime: row.storedFile.mime,
    eventId: row.storedFile.eventId,
  };
}

/** Oldest first: a list of supporting documents is a record, not a feed. */
export const attachmentOrderBy = [
  { createdAt: "asc" },
  { id: "asc" },
] satisfies Prisma.AbstractAttachmentOrderByWithRelationInput[];

/** Normalization applied to a supplied label before it is stored. */
export function attachmentFilenameFor(input: AttachmentCreateInput): string {
  return attachmentFilename(input.filename);
}
