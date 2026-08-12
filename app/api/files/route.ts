import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireContext } from "@/lib/api/context";
import { ApiError, handle, ok } from "@/lib/api/http";
import { diagnosticLabel } from "@/lib/diagnostic-label";
import { enforceUploadRateLimit } from "@/lib/services/upload-rate";
import {
  normalizeMime,
  parseStoredFileKind,
  storedFileMaxBytes,
  storedFilePath,
  verifyStoredFile,
  type StoredFileKindValue,
} from "@/lib/uploads/stored-file";
import {
  legacyStoredFileDedupeKey,
  storedFileDedupeKey,
} from "@/lib/uploads/stored-file-dedupe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/files?kind=headshot|slide-deck|supporting-document — store one file.
 *
 * The body is the raw bytes and `Content-Type` is the claim about them. That is
 * deliberately not multipart: a headshot or a deck is a single file with no
 * accompanying fields, so multipart would add a parser, a boundary, and a
 * second place for the declared size and the real size to disagree — for
 * nothing. Raw bytes let the cap be enforced against the stream itself.
 *
 * Order of refusals, and each one is load-bearing:
 *   1. session (401)      — no anonymous writes to storage, ever
 *   2. kind (422)         — decides the cap and the accepted formats
 *   3. declared size (413)— refuse before a byte is read where we can
 *   4. throttle (429)     — charged before the bytes are read, not after
 *   5. real size (413)    — the stream is capped, a lying header buys nothing
 *   6. bytes vs claim (422)
 */

/** Stream the body with a hard cap, aborting the moment the cap is passed. */
async function readCappedBody(req: Request, maxBytes: number): Promise<Uint8Array> {
  if (!req.body) throw tooLarge(maxBytes, "EMPTY");

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      // Cancel rather than drain: an oversize upload must not be paid for in
      // full before it is refused.
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge(maxBytes);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // Label only. The body being read here is a user's own file.
    console.warn("[files] upload stream read failed", diagnosticLabel(error));
    throw new ApiError(400, "UPLOAD_UNREADABLE", "The upload could not be read. Try again.");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function tooLarge(maxBytes: number, reason?: "EMPTY"): ApiError {
  if (reason === "EMPTY") return new ApiError(422, "UPLOAD_EMPTY", "The upload was empty.");
  return new ApiError(
    413,
    "REQUEST_TOO_LARGE",
    `This file is too large. The limit is ${Math.floor(maxBytes / 1024)} KiB.`,
  );
}

function declaredLengthExceeds(req: Request, maxBytes: number): boolean {
  const declared = req.headers.get("content-length")?.trim();
  if (!declared || !/^\d+$/.test(declared)) return false;
  const bytes = Number(declared);
  return Number.isSafeInteger(bytes) && bytes > maxBytes;
}

/** The refusals `verifyStoredFile` can produce, as the contract's own codes. */
function refuse(reason: "UNSUPPORTED_KIND" | "UNSUPPORTED_TYPE" | "TYPE_MISMATCH" | "TOO_LARGE", kind: StoredFileKindValue): ApiError {
  if (reason === "TOO_LARGE") return tooLarge(storedFileMaxBytes(kind));
  if (reason === "TYPE_MISMATCH") {
    return new ApiError(422, "FILE_TYPE_MISMATCH", "This file is not the type its content type claims.", {
      file: ["The file's contents do not match the type it was sent as."],
    });
  }
  const expected = kind === "HEADSHOT" ? "a PNG, JPEG or WebP image" : "a PDF";
  return new ApiError(422, "FILE_TYPE_UNSUPPORTED", `This upload must be ${expected}.`, {
    file: [`Choose ${expected}.`],
  });
}

export const POST = handle(async (req) => {
  const ctx = await requireContext();

  const kind = parseStoredFileKind(new URL(req.url).searchParams.get("kind"));
  if (!kind) {
    throw new ApiError(422, "FILE_KIND_UNSUPPORTED", "Say what this upload is for.", {
      kind: ["Expected `headshot`, `slide-deck`, or `supporting-document`."],
    });
  }
  const maxBytes = storedFileMaxBytes(kind);
  // A truthful oversize header is refused without reading anything at all.
  if (declaredLengthExceeds(req, maxBytes)) throw tooLarge(maxBytes);

  // Charged before the bytes are read: a throttle that runs afterwards has
  // already paid for the work it exists to refuse.
  await enforceUploadRateLimit({ userId: ctx.userId, eventId: ctx.eventId });

  const bytes = await readCappedBody(req, maxBytes);
  if (bytes.byteLength === 0) throw tooLarge(maxBytes, "EMPTY");

  const verdict = verifyStoredFile({ kind, claimedMime: normalizeMime(req.headers.get("content-type")), bytes });
  if (!verdict.ok) throw refuse(verdict.reason, kind);

  const contentSha256 = createHash("sha256").update(bytes).digest("hex");
  const dedupeInput = {
    uploaderUserId: ctx.userId,
    eventId: ctx.eventId,
    kind,
    contentSha256,
  };
  const dedupe = storedFileDedupeKey(dedupeInput);

  // Re-uploading under the same authorization scope returns the existing id.
  // Headshots are public and dedupe across events; a private deck or supporting
  // document includes the active event in its fingerprint, so another event
  // can never inherit this row's organizer access merely because bytes match.
  let existing = await prisma.storedFile.findUnique({
    where: { uploaderUserId_kind_sha256: dedupe },
    select: { id: true, mime: true, size: true, eventId: true },
  });
  if (!existing && kind === "SLIDE_DECK") {
    // Rows written before the event-scoped fingerprint used the raw content
    // digest. Reuse one only inside the event that already owns its private
    // authorization; a cross-event legacy hit must fall through to a new row.
    const legacy = await prisma.storedFile.findUnique({
      where: { uploaderUserId_kind_sha256: legacyStoredFileDedupeKey(dedupeInput) },
      select: { id: true, mime: true, size: true, eventId: true },
    });
    if (legacy?.eventId === ctx.eventId) existing = legacy;
  }
  if (existing) {
    return ok({ id: existing.id, url: storedFilePath(existing.id), kind, mime: existing.mime, size: existing.size, deduped: true });
  }

  let stored: { id: string; mime: string; size: number };
  try {
    stored = await prisma.storedFile.create({
      data: {
        uploaderUserId: ctx.userId,
        eventId: ctx.eventId,
        kind,
        // The server's own verdict, never the header. The serving route sets
        // `Content-Type` from this column.
        mime: verdict.mime,
        size: bytes.byteLength,
        sha256: dedupe.sha256,
        bytes: Buffer.from(bytes),
      },
      select: { id: true, mime: true, size: true },
    });
  } catch (error) {
    // Two same-scope uploads racing past the read above: the scoped unique key
    // is the arbiter, and the loser returns the winner's id rather than a 500.
    // Recovery deliberately never consults a legacy raw digest, because a row
    // another event owns must not become this upload's race winner.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await prisma.storedFile.findUnique({
        where: { uploaderUserId_kind_sha256: dedupe },
        select: { id: true, mime: true, size: true },
      });
      if (!raced) throw error;
      return ok({ id: raced.id, url: storedFilePath(raced.id), kind, mime: raced.mime, size: raced.size, deduped: true });
    }
    throw error;
  }

  return ok(
    { id: stored.id, url: storedFilePath(stored.id), kind, mime: stored.mime, size: stored.size, deduped: false },
    201,
  );
});
