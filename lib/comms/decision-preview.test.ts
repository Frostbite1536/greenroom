import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DECISION_PREVIEW_TTL_SECONDS,
  issueDecisionPreviewToken,
  verifyDecisionPreviewToken,
} from "./decision-preview";

const secret = "scratch-signing-secret-at-least-32-characters";
const identity = {
  adminId: "admin-1",
  eventId: "event-1",
  abstractId: "abstract-1",
  contentDigest: "digest-1",
};

test("decision preview proof binds the admin, event, abstract, and exact content", () => {
  const now = 1_700_000_000_000;
  const token = issueDecisionPreviewToken(identity, secret, now);
  assert.equal(verifyDecisionPreviewToken(token, identity, secret, now), true);
  assert.equal(verifyDecisionPreviewToken(token, { ...identity, adminId: "admin-2" }, secret, now), false);
  assert.equal(verifyDecisionPreviewToken(token, { ...identity, eventId: "event-2" }, secret, now), false);
  assert.equal(verifyDecisionPreviewToken(token, { ...identity, abstractId: "abstract-2" }, secret, now), false);
  assert.equal(verifyDecisionPreviewToken(token, { ...identity, contentDigest: "changed" }, secret, now), false);
});

test("decision preview proof rejects tampering, malformed input, and expiry", () => {
  const now = 1_700_000_000_000;
  const token = issueDecisionPreviewToken(identity, secret, now);
  assert.equal(verifyDecisionPreviewToken(`${token}x`, identity, secret, now), false);
  assert.equal(verifyDecisionPreviewToken("not-a-token", identity, secret, now), false);
  assert.equal(
    verifyDecisionPreviewToken(token, identity, secret, now + DECISION_PREVIEW_TTL_SECONDS * 1_000),
    false,
  );
});
