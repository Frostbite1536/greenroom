import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ABSTRACT_PERMALINK_LEGACY_PARAM,
  ABSTRACT_PERMALINK_PARAM,
  abstractPermalink,
  readAbstractPermalinkId,
} from "./abstract-permalink";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the canonical permalink is ?abstract=<id>", () => {
  assert.equal(ABSTRACT_PERMALINK_PARAM, "abstract");
  assert.equal(abstractPermalink("abs-1"), "/admin/abstracts?abstract=abs-1");
  assert.equal(readAbstractPermalinkId({ abstract: "abs-1" }), "abs-1");
});

test("the original ?abstractId= keeps working, and the canonical form wins a conflict", () => {
  // Every existing link and smoke assertion carries `abstractId`; dropping it
  // would break working links to fix nothing.
  assert.equal(ABSTRACT_PERMALINK_LEGACY_PARAM, "abstractId");
  assert.equal(readAbstractPermalinkId({ abstractId: "abs-legacy" }), "abs-legacy");
  // A reader pasting a new-style link must not have it silently overridden by
  // a stale parameter left in the query string.
  assert.equal(readAbstractPermalinkId({ abstract: "abs-new", abstractId: "abs-old" }), "abs-new");
  // An unusable canonical value still falls through to the legacy one.
  assert.equal(readAbstractPermalinkId({ abstract: "  ", abstractId: "abs-old" }), "abs-old");
});

test("an unusable parameter yields no drawer rather than a guess or a throw", () => {
  assert.equal(readAbstractPermalinkId({}), null);
  assert.equal(readAbstractPermalinkId({ abstract: undefined }), null);
  assert.equal(readAbstractPermalinkId({ abstract: "" }), null);
  assert.equal(readAbstractPermalinkId({ abstract: "   " }), null);
  // A repeated parameter is ambiguous: picking one would be a guess about
  // which proposal the reader meant.
  assert.equal(readAbstractPermalinkId({ abstract: ["a", "b"] }), null);
  assert.equal(readAbstractPermalinkId({ abstractId: ["a"] }), null);
  // Surrounding whitespace from a wrapped paste is trimmed, not refused.
  assert.equal(readAbstractPermalinkId({ abstract: " abs-1 " }), "abs-1");
});

test("an id cannot break out of its own query parameter", () => {
  assert.equal(
    abstractPermalink("a&planId=other-event-plan"),
    "/admin/abstracts?abstract=a%26planId%3Dother-event-plan",
  );
  assert.equal(abstractPermalink("a b#c"), "/admin/abstracts?abstract=a%20b%23c");
});

test("the drawer resolves server-side, event-scoped, and degrades to a plain render", () => {
  const page = source("app/(app)/admin/abstracts/page.tsx");
  // Read through the shared module, so the two accepted parameters cannot
  // drift from the ones the coverage table links with.
  assert.match(page, /readAbstractPermalinkId\(params\)/);
  assert.match(page, /from "@\/lib\/abstract-permalink"/);
  // Server component: no "use client", and the drawer target is resolved in the
  // same await that builds the page, so it is present in the first response.
  assert.equal(/^\s*"use client"/m.test(page), false);
  assert.match(page, /getAdminAbstracts\(requestedId, requestedPlanId\)/);
  // The id is handed to the event-scoped read, never used to build a where
  // clause in the page itself.
  assert.equal(/prisma\./.test(page), false);
  // An id that did not resolve produces no drawer — and no notFound(): a stale
  // or foreign link renders the page normally. `notFound()` in this file is
  // reachable only from PLAN_NOT_FOUND, which is the planId's contract.
  assert.match(
    page,
    /const initialSelectedId = requestedId && \(selectedAbstract\?\.id === requestedId \|\| abstracts\.some\(\(abstract\) => abstract\.id === requestedId\)\)[^\r\n]*\r?\n\s*\? requestedId\r?\n\s*: null;/,
  );
  const notFoundUses = page.match(/notFound\(\)/g) ?? [];
  assert.equal(notFoundUses.length, 1, "only the plan-id branch may 404");
  assert.match(page, /PLAN_NOT_FOUND"\) notFound\(\)/);
});

test("the event scoping the permalink depends on lives in the read, not the URL", () => {
  // S1/INV-EVENT-001: an id from another event must be indistinguishable from
  // one that does not exist. Both are resolved against the caller's own event.
  const reads = source("lib/data/reads.ts");
  const deepLinkQuery = reads.slice(
    reads.indexOf("requestedAbstractId"),
    reads.indexOf("return { parentRows, statusGroups, requestedAbstract };"),
  );
  assert.match(deepLinkQuery, /findFirst\(\{\s*\r?\n?\s*where: \{ \.\.\.parentWhere, id: requestedAbstractId \}/);
  assert.match(reads, /const parentWhere = adminAbstractListWhere\(\{ eventId: ctx\.eventId \}\)/);
});
