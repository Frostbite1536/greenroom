/**
 * Proposal supporting-document policy, with no database and no request in it.
 *
 * The bytes half of this feature is not here and deliberately not duplicated:
 * type, size, sniffing, dedupe, throttling, and who may read a file back are
 * `lib/uploads/stored-file.ts` and `POST /api/files`, which the attach flow
 * uses unchanged. What is left over — how many documents one proposal may
 * carry, what a display name is allowed to be, and which rows a given viewer
 * may actually open — is decided here so the route layer does IO and nothing
 * else.
 */
import { canReadStoredFile, type StoredFileViewer } from "@/lib/uploads/stored-file";

/**
 * How many supporting documents one proposal may carry.
 *
 * Three, because the requirement is "supporting documents" beside a proposal —
 * a draft paper, a demo script, a letter of support — not a file share. A cap
 * is what stops the reviewers' drawer from becoming unreadable and what bounds
 * the read behind it; the number is a product call, so it lives in one named
 * constant rather than inline at the two places that enforce it.
 */
export const MAX_ATTACHMENTS_PER_ABSTRACT = 3;

export const ATTACHMENT_LIMIT_CODE = "ATTACHMENT_LIMIT_REACHED";
export const ATTACHMENT_ALREADY_LINKED_CODE = "ATTACHMENT_ALREADY_ATTACHED";

export const attachmentLimitMessage =
  `A proposal can carry up to ${MAX_ATTACHMENTS_PER_ABSTRACT} supporting documents. `
  + "Remove one before adding another.";

export const attachmentAlreadyLinkedMessage =
  "That file is already attached to this proposal.";

export type AttachmentCountVerdict =
  | { ok: true }
  | { ok: false; code: typeof ATTACHMENT_LIMIT_CODE; message: string };

/**
 * May one more document be attached, given how many links already exist?
 *
 * `>=` rather than `>`: the count is taken before the write, so a proposal
 * already holding the maximum is refused rather than allowed to reach one over.
 */
export function attachmentCountVerdict(existingCount: number): AttachmentCountVerdict {
  if (existingCount >= MAX_ATTACHMENTS_PER_ABSTRACT) {
    return { ok: false, code: ATTACHMENT_LIMIT_CODE, message: attachmentLimitMessage };
  }
  return { ok: true };
}

/** Longest display name stored. Well past any real file name, short of abuse. */
export const ATTACHMENT_FILENAME_MAX_LENGTH = 200;

/**
 * A file name is a LABEL here, never a path and never a route input.
 *
 * The stored bytes are addressed by cuid (`/api/files/<id>`), so this string
 * decides nothing — it is rendered to a speaker and to an organizer. It is
 * still normalized rather than trusted: any directory part is dropped so a
 * name cannot read as a path in a list, and control characters are stripped so
 * it cannot rewrite a line in a terminal or a CSV cell.
 *
 * Returns null when nothing usable is left; the caller then falls back to a
 * neutral name rather than storing an empty label.
 */
export function normalizeAttachmentFilename(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  // Both separators, so a Windows client's `C:\docs\paper.pdf` is handled by the
  // same line as a POSIX client's `/tmp/paper.pdf`.
  const base = value.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, ATTACHMENT_FILENAME_MAX_LENGTH);
}

export const ATTACHMENT_FALLBACK_FILENAME = "Supporting document";

/** What is stored: a normalized label, or a neutral one. Never empty. */
export function attachmentFilename(value: string | null | undefined): string {
  return normalizeAttachmentFilename(value) ?? ATTACHMENT_FALLBACK_FILENAME;
}

export type AttachmentSubject = {
  id: string;
  filename: string;
  createdAt: string;
  uploadedByUserId: string;
  uploadedByName: string;
  storedFileId: string;
  size: number;
  mime: string;
  /** The stored file's own event, which is what its read rule is decided against. */
  eventId: string | null;
};

export type AttachmentView = AttachmentSubject & {
  /** True when this viewer may actually fetch `/api/files/<storedFileId>`. */
  canOpen: boolean;
  /** True when this viewer may remove the link (the uploader, while editable). */
  canRemove: boolean;
};

/**
 * Project one proposal's attachments for a viewer.
 *
 * `canOpen` is not a second policy: it calls the same `canReadStoredFile`
 * matrix the serving route decides with, so a row can never be rendered as an
 * openable link that `/api/files/<id>` would then answer 404 to. That case is
 * real rather than theoretical — a co-speaker may list a document they may not
 * read — and the honest rendering is to say so on the row.
 *
 * `canRemove` is narrower still and independent of `canOpen`: only the person
 * who attached it, and only while the proposal is editable. An organizer does
 * not remove a speaker's document from here; that is a conversation, not a
 * button.
 */
export function viewAttachments(
  attachments: readonly AttachmentSubject[],
  viewer: { userId: string; role: string; eventId: string } | null,
  options: { editable: boolean },
): AttachmentView[] {
  const storedViewer: StoredFileViewer = viewer;
  return attachments.map((attachment) => ({
    ...attachment,
    canOpen: canReadStoredFile(
      {
        kind: "SUPPORTING_DOCUMENT",
        uploaderUserId: attachment.uploadedByUserId,
        eventId: attachment.eventId,
      },
      storedViewer,
    ),
    canRemove: options.editable && viewer?.userId === attachment.uploadedByUserId,
  }));
}

/** Human size for a list row. Bytes are never interesting; kB and MB are. */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
