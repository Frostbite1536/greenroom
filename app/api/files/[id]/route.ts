import { prisma } from "@/lib/prisma";
import { getApiContext } from "@/lib/api/context";
import { ApiError, handle } from "@/lib/api/http";
import {
  canReadStoredFile,
  storedFileCacheControl,
  storedFileDisposition,
} from "@/lib/uploads/stored-file";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/files/:id — hand back the stored bytes.
 *
 * Authorization mirrors where each column is already exposed, and is decided by
 * one pure function (`canReadStoredFile`) so the matrix is testable without a
 * live table: a HEADSHOT is public because it renders on the anonymous speaker
 * gallery and the speakers embed; a SLIDE_DECK is not, because `slideDeckUrl`
 * appears only in the speaker's own portal, the ADMIN roster route, and the
 * operator-held v1 API.
 *
 * A file that does not exist and a file the caller may not read are the **same
 * 404**, so the route cannot be used to discover that an id is real.
 *
 * `Content-Type` comes from the stored, server-derived mime — the value this
 * server sniffed out of the bytes at upload, never a string a client supplied.
 * With the deployment-wide `X-Content-Type-Options: nosniff` that makes the
 * declared type binding, which is the whole point of storing it.
 */

type Params = { params: Promise<{ id: string }> };

export function GET(req: Request, ctx: Params) {
  return handle(async () => {
    const { id } = await ctx.params;

    // `bytes` is selected with the row: the authorization decision needs kind,
    // uploader and event, and a second round trip for the payload would only
    // widen the window between deciding and serving.
    const file = await prisma.storedFile.findUnique({
      where: { id },
      select: { id: true, kind: true, mime: true, size: true, bytes: true, uploaderUserId: true, eventId: true },
    });
    // Missing and forbidden are indistinguishable, so this is checked before
    // anything about the row is used.
    if (!file) throw notFound();

    // Resolved only when the kind actually needs it: a public headshot must not
    // become a session-dependent response, or every embed would go uncacheable.
    const viewer = file.kind === "HEADSHOT" ? null : await getApiContext();
    if (!canReadStoredFile(file, viewer)) throw notFound();

    const body = Uint8Array.from(file.bytes);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": file.mime,
        "Content-Length": String(body.byteLength),
        "Cache-Control": storedFileCacheControl(file.kind),
        "Content-Disposition": storedFileDisposition(file.kind),
        // Belt and braces beside the deployment-wide header: this is the one
        // route that serves bytes a user chose.
        "X-Content-Type-Options": "nosniff",
      },
    });
  })(req);
}

function notFound(): ApiError {
  return new ApiError(404, "FILE_NOT_FOUND", "File not found.");
}
