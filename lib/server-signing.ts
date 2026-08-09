import { SESSION_SECRET_MIN_LENGTH } from "@/lib/env";

// Deliberately usable only outside production. Keeping this in one module means
// session cookies and other short-lived server proofs fail closed under the
// same production configuration rule.
const DEVELOPMENT_SIGNING_SECRET = "greenroom-development-session-secret-not-for-production";

export function getServerSigningSecret(): string | null {
  const configured = process.env.SESSION_SECRET?.trim();
  if (configured && configured.length >= SESSION_SECRET_MIN_LENGTH) return configured;
  return process.env.NODE_ENV === "production" ? null : DEVELOPMENT_SIGNING_SECRET;
}
