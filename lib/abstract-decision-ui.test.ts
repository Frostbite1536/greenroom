import assert from "node:assert/strict";
import { test } from "node:test";
import { canOfferMaybeDecision } from "./abstract-decision-ui";

test("Maybe is only offered before a proposal has a confirmed session", () => {
  assert.equal(canOfferMaybeDecision(false), true);
  assert.equal(canOfferMaybeDecision(true), false);
});
