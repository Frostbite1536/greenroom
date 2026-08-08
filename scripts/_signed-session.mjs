import { createHmac } from "node:crypto";

// Local smoke-only signing material. It is passed explicitly to the spawned
// server and must never be used by a deployed environment.
export const SMOKE_SESSION_SECRET = "greenroom-smoke-session-secret-not-for-production-2026";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export function cookieForSession(session, now = Date.now()) {
  const iat = Math.floor(now / 1_000);
  const payload = Buffer.from(JSON.stringify({ ...session, iat, exp: iat + SESSION_TTL_SECONDS }), "utf8").toString("base64url");
  const signature = createHmac("sha256", SMOKE_SESSION_SECRET).update(payload).digest("base64url");
  return `sb_session=${payload}.${signature}`;
}
