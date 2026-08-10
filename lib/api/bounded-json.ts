import { ApiError } from "@/lib/api/http";
import { diagnosticLabel } from "@/lib/diagnostic-label";

/** Application-level limit, intentionally far below Vercel's 4.5 MB ceiling. */
export const PUBLIC_JSON_MAX_BYTES = 128 * 1024;

function declaredLengthExceeds(req: Request, maxBytes: number): boolean {
  const declared = req.headers.get("content-length")?.trim();
  if (!declared || !/^\d+$/.test(declared)) return false;
  const bytes = Number(declared);
  return Number.isSafeInteger(bytes) && bytes > maxBytes;
}

/**
 * Read a Web Request body as text with a hard byte cap. Route Handlers use Web
 * Request streams, so this avoids allocating an attacker-sized string. `code`
 * and `message` name the caller's own malformed-body contract — JSON routes
 * keep `INVALID_JSON`, form-encoded routes supply their own.
 */
export async function parseBoundedText(
  req: Request,
  maxBytes = PUBLIC_JSON_MAX_BYTES,
  code = "INVALID_JSON",
  message = "Request body must be valid JSON.",
): Promise<string> {
  if (declaredLengthExceeds(req, maxBytes)) {
    throw new ApiError(413, "REQUEST_TOO_LARGE", `Request bodies are limited to ${maxBytes} bytes.`);
  }
  if (!req.body) {
    throw new ApiError(400, code, message);
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
    // A stream abort and a truncated body are otherwise indistinguishable in
    // the logs from a client that simply sent nothing. Label only — the body
    // being read here is untrusted and may be a credential.
    console.warn("[bounded-body] stream read failed", diagnosticLabel(error));
    throw new ApiError(400, code, message);
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
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    console.warn("[bounded-body] body was not valid UTF-8", diagnosticLabel(error));
    throw new ApiError(400, code, message);
  }
}

/**
 * Read a bounded body and parse it as JSON, preserving the original
 * `INVALID_JSON` / `REQUEST_TOO_LARGE` contract exactly.
 */
export async function parseBoundedJson(req: Request, maxBytes = PUBLIC_JSON_MAX_BYTES): Promise<unknown> {
  const text = await parseBoundedText(req, maxBytes);
  try {
    return JSON.parse(text);
  } catch (error) {
    console.warn("[bounded-body] body was not valid JSON", diagnosticLabel(error));
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}
