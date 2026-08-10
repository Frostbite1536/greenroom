/**
 * Bounded diagnostic labels.
 *
 * The C17 acceptance route established the convention: when a failure category
 * is discarded, record **what class of thing went wrong** and nothing else. An
 * exception's `message` routinely carries the input that caused it — a body, a
 * URL, a key, a decoded buffer — so it is never logged. Only a stable code or
 * the constructor name survives, and both are charset- and length-bounded so a
 * crafted error cannot smuggle text into a log line.
 */

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function diagnosticLabel(error: unknown): string {
  if (error && typeof error === "object") {
    // `ApiError.code` and node's `err.code` are both stable, enumerable
    // categories rather than free text.
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && CODE_PATTERN.test(code)) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && NAME_PATTERN.test(name)) return name;
  }
  return "unknown";
}
