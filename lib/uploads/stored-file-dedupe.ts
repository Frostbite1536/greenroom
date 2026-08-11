import { createHash } from "node:crypto";
import type { StoredFileKindValue } from "@/lib/uploads/stored-file";

/**
 * Database identity for stored bytes.
 *
 * Headshots are public and keep their raw content digest, so the same person's
 * same public image remains one row across events. A slide deck is private to
 * the event authority under which it was uploaded, so its fingerprint includes
 * that event. The versioned, NUL-delimited domain prevents ambiguous string
 * concatenation and leaves room for a deliberate future policy change.
 *
 * This module is server-only by dependency: `node:crypto` must not enter the
 * shared upload-policy module used by the client-side file picker.
 */
const SLIDE_DECK_DEDUPE_DOMAIN = "greenroom:stored-file-dedupe:v1";

export type StoredFileDedupeKey = {
  uploaderUserId: string;
  kind: StoredFileKindValue;
  sha256: string;
};

type DedupeInput = {
  uploaderUserId: string;
  eventId: string;
  kind: StoredFileKindValue;
  contentSha256: string;
};

export function storedFileDedupeKey(input: DedupeInput): StoredFileDedupeKey {
  const contentSha256 = input.contentSha256.toLowerCase();
  const sha256 = input.kind === "HEADSHOT"
    ? contentSha256
    : createHash("sha256")
      .update(`${SLIDE_DECK_DEDUPE_DOMAIN}\0${input.eventId}\0${contentSha256}`)
      .digest("hex");
  return { uploaderUserId: input.uploaderUserId, kind: input.kind, sha256 };
}

/** The pre-v1 identity, accepted only for a row owned by the same event. */
export function legacyStoredFileDedupeKey(input: DedupeInput): StoredFileDedupeKey {
  return {
    uploaderUserId: input.uploaderUserId,
    kind: input.kind,
    sha256: input.contentSha256.toLowerCase(),
  };
}
