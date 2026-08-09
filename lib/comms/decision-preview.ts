import { createHmac, timingSafeEqual } from "node:crypto";

export const DECISION_PREVIEW_TTL_SECONDS = 15 * 60;

type DecisionPreviewProof = {
  v: 1;
  adminId: string;
  eventId: string;
  abstractId: string;
  contentDigest: string;
  exp: number;
};

export type DecisionPreviewIdentity = Omit<DecisionPreviewProof, "v" | "exp">;

function signatureFor(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function isProof(value: unknown): value is DecisionPreviewProof {
  if (!value || typeof value !== "object") return false;
  const proof = value as Partial<DecisionPreviewProof>;
  return proof.v === 1 &&
    typeof proof.adminId === "string" &&
    typeof proof.eventId === "string" &&
    typeof proof.abstractId === "string" &&
    typeof proof.contentDigest === "string" &&
    Number.isInteger(proof.exp);
}

/** Issue a short-lived proof that this admin previewed this exact message set. */
export function issueDecisionPreviewToken(
  identity: DecisionPreviewIdentity,
  secret: string,
  now = Date.now(),
): string {
  const proof: DecisionPreviewProof = {
    v: 1,
    ...identity,
    exp: Math.floor(now / 1_000) + DECISION_PREVIEW_TTL_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(proof), "utf8").toString("base64url");
  return `${payload}.${signatureFor(payload, secret)}`;
}

/** Verify signature, expiry, admin/event scope, and exact rendered content. */
export function verifyDecisionPreviewToken(
  token: string,
  expected: DecisionPreviewIdentity,
  secret: string,
  now = Date.now(),
): boolean {
  try {
    const [payload, providedSignature, ...extra] = token.split(".");
    if (!payload || !providedSignature || extra.length > 0) return false;

    const expectedSignature = signatureFor(payload, secret);
    const provided = Buffer.from(providedSignature, "base64url");
    const signature = Buffer.from(expectedSignature, "base64url");
    if (provided.length !== signature.length || !timingSafeEqual(provided, signature)) return false;

    const proof = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isProof(proof) || proof.exp <= Math.floor(now / 1_000)) return false;
    return proof.adminId === expected.adminId &&
      proof.eventId === expected.eventId &&
      proof.abstractId === expected.abstractId &&
      proof.contentDigest === expected.contentDigest;
  } catch {
    return false;
  }
}
