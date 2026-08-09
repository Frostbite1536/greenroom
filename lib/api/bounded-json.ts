import { ApiError } from "@/lib/api/http";

/** Application-level limit, intentionally far below Vercel's 4.5 MB ceiling. */
export const PUBLIC_JSON_MAX_BYTES = 128 * 1024;

function declaredLengthExceeds(req: Request, maxBytes: number): boolean {
  const declared = req.headers.get("content-length")?.trim();
  if (!declared || !/^\d+$/.test(declared)) return false;
  const bytes = Number(declared);
  return Number.isSafeInteger(bytes) && bytes > maxBytes;
}

/**
 * Read a Web Request body with a hard byte cap before JSON parsing. Route
 * Handlers use Web Request streams, so this avoids allocating an attacker-sized
 * string while preserving the normal JSON error contract.
 */
export async function parseBoundedJson(req: Request, maxBytes = PUBLIC_JSON_MAX_BYTES): Promise<unknown> {
  if (declaredLengthExceeds(req, maxBytes)) {
    throw new ApiError(413, "REQUEST_TOO_LARGE", `Request bodies are limited to ${maxBytes} bytes.`);
  }
  if (!req.body) {
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ApiError(413, "REQUEST_TOO_LARGE", `Request bodies are limited to ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON.");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}
