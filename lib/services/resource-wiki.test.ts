import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { fromZod } from "@/lib/api/http";
import { resourceWikiInputSchema, resourceWikiUpdateSchema } from "@/types/api";
import { classifyResourceMutationError } from "@/lib/services/resource-mutation-errors";
import {
  RESOURCE_HTML_EMPTY_CODE,
  RESOURCE_SLUG_MAX_LENGTH,
  isPortalVisibleResource,
  portalResourceHref,
  portalResourceWhere,
  prepareResourceHtml,
  resourceSlugFromTitle,
  resourceSummaryValue,
  serializeResource,
} from "@/lib/services/resource-wiki";

/**
 * Resource/wiki authoring (buyer requirement 8).
 *
 * The portal could always render a sanitized resource page; until this lane the
 * only writer was the demo seed. These tests cover the four properties the new
 * writer has to hold, at the level where they are decidable without a database:
 * sanitizing at WRITE time, the validation status the contract promises, the
 * named slug-collision refusal, and the published-only rule the portal reads by.
 */

test("authored HTML is sanitized before it is stored, and scripts never reach the column", () => {
  const decision = prepareResourceHtml(
    '<h2>Arrival</h2><script>fetch("/steal")</script><p>Doors open at 8am.</p>' +
      '<a href="javascript:alert(1)">bad link</a><iframe src="https://evil.example"></iframe>',
  );
  assert.equal(decision.allowed, true);
  if (!decision.allowed) return;

  // The dangerous elements are gone, including their contents.
  assert.doesNotMatch(decision.html, /<script/i);
  assert.doesNotMatch(decision.html, /fetch\("\/steal"\)/);
  assert.doesNotMatch(decision.html, /<iframe/i);
  assert.doesNotMatch(decision.html, /javascript:/i);
  // The real content survives, or the sanitizer would be useless to an author.
  assert.match(decision.html, /<h2>Arrival<\/h2>/);
  assert.match(decision.html, /<p>Doors open at 8am\.<\/p>/);
  // A stripped-but-kept link keeps its text, without the unsafe href.
  assert.match(decision.html, /<a>bad link<\/a>/);
});

test("a body that is entirely script is a named refusal, not a silently blank page", () => {
  const decision = prepareResourceHtml('<script>alert("x")</script><style>body{display:none}</style>');
  assert.equal(decision.allowed, false);
  if (decision.allowed) return;
  assert.equal(decision.code, RESOURCE_HTML_EMPTY_CODE);
  // The message has to tell the organizer what to do instead — this refusal is
  // the entire fix from their point of view.
  assert.match(decision.message, /Scripts, styles, embeds and inline event handlers are always removed/);
});

test("whitespace-only survivors are refused too, so a page can never be stored blank", () => {
  assert.equal(prepareResourceHtml("   \n\t  ").allowed, false);
  assert.equal(prepareResourceHtml("<p>Real content.</p>").allowed, true);
});

test("contract violations are 422 with the offending field named, never 400", () => {
  const bad = resourceWikiInputSchema.safeParse({
    eventId: "evt_1",
    slug: "Not A Slug",
    title: "",
    htmlContent: "",
    published: true,
  });
  assert.equal(bad.success, false);
  if (bad.success) return;
  const failure = fromZod(bad.error);
  assert.equal(failure.status, 422);
  assert.equal(failure.code, "VALIDATION_ERROR");
  assert.ok(failure.fieldErrors?.slug, "the slug is named as the reason");
  assert.ok(failure.fieldErrors?.title, "the title is named as the reason");
  assert.ok(failure.fieldErrors?.htmlContent, "the body is named as the reason");
  assert.match(failure.fieldErrors!.slug!.join(" "), /lowercase letters, numbers and single dashes/);
});

test("the create contract bounds the slug and normalizes it the way the portal route reads it", () => {
  const parsed = resourceWikiInputSchema.parse({
    eventId: "evt_1",
    slug: "  Speaker-Handbook  ",
    title: "  Speaker Handbook  ",
    summary: "  Everything you need.  ",
    htmlContent: "<p>Hi</p>",
    published: false,
  });
  assert.equal(parsed.slug, "speaker-handbook");
  assert.equal(parsed.title, "Speaker Handbook");
  assert.equal(parsed.summary, "Everything you need.");

  const tooLong = resourceWikiInputSchema.safeParse({
    eventId: "evt_1",
    slug: "a".repeat(RESOURCE_SLUG_MAX_LENGTH + 1),
    title: "Long",
    htmlContent: "<p>Hi</p>",
    published: false,
  });
  assert.equal(tooLong.success, false);
});

test("the update contract takes no eventId, allows a lone publish toggle, and refuses an empty edit", () => {
  const toggle = resourceWikiUpdateSchema.safeParse({ id: "res_1", published: true });
  assert.equal(toggle.success, true);

  // Scope is the stored row's, so an eventId in the body is a contract error
  // rather than something the route could be tricked into honouring.
  const scoped = resourceWikiUpdateSchema.safeParse({ id: "res_1", published: true, eventId: "evt_other" });
  assert.equal(scoped.success, false);

  const empty = resourceWikiUpdateSchema.safeParse({ id: "res_1" });
  assert.equal(empty.success, false);

  // A summary may be cleared; on create it is simply absent.
  assert.equal(resourceWikiUpdateSchema.safeParse({ id: "res_1", summary: null }).success, true);
});

test("a slug collision is a stable named classification, and unrelated failures still surface", () => {
  const duplicate = new Prisma.PrismaClientKnownRequestError("duplicate slug", {
    code: "P2002",
    clientVersion: "test",
  });
  assert.equal(classifyResourceMutationError(duplicate), "RESOURCE_SLUG_TAKEN");

  const vanished = new Prisma.PrismaClientKnownRequestError("row is gone", {
    code: "P2025",
    clientVersion: "test",
  });
  assert.equal(classifyResourceMutationError(vanished), "RESOURCE_NOT_FOUND");

  assert.equal(classifyResourceMutationError(new Error("database offline")), null);
});

test("slugs derive from titles the way the CFP form dialog derives its own", () => {
  assert.equal(resourceSlugFromTitle("Speaker Handbook"), "speaker-handbook");
  assert.equal(resourceSlugFromTitle("Venue & Travel Guide"), "venue-travel-guide");
  // Accents decompose to the plain letter rather than becoming a dash.
  assert.equal(resourceSlugFromTitle("Café logistics"), "cafe-logistics");
  // A long title still yields a slug the contract accepts: bounded, and never
  // left with the trailing dash the slice can produce.
  const long = resourceSlugFromTitle(`${"venue ".repeat(30)}guide`);
  assert.ok(long.length <= RESOURCE_SLUG_MAX_LENGTH);
  assert.equal(resourceWikiInputSchema.shape.slug.safeParse(long).success, true);
  assert.equal(resourceSlugFromTitle("!!!"), "");
});

test("an authored page round-trips: created as a draft, published, then visible in the portal", () => {
  const eventId = "evt_1";

  // 1. Author it. This is exactly what the route stores: sanitized body, a
  //    normalized summary, and the publish flag the organizer chose.
  const input = resourceWikiInputSchema.parse({
    eventId,
    slug: "speaker-handbook",
    title: "Speaker Handbook",
    summary: "  ",
    htmlContent: '<h2>Welcome</h2><script>alert(1)</script><p>Arrive 30 minutes early.</p>',
    published: false,
  });
  const html = prepareResourceHtml(input.htmlContent);
  assert.equal(html.allowed, true);
  if (!html.allowed) return;

  const stored = {
    id: "res_1",
    eventId,
    slug: input.slug,
    title: input.title,
    summary: resourceSummaryValue(input.summary),
    htmlContent: html.html,
    published: input.published,
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
  };
  // A blank summary is stored as absent, not as an empty line under the link.
  assert.equal(stored.summary, null);
  // The script never reached the column, so the portal renders sanitized bytes
  // even before its own sanitize-on-render runs.
  assert.doesNotMatch(stored.htmlContent, /<script/i);

  // 2. A draft is not in the portal, on either portal surface.
  assert.equal(isPortalVisibleResource(stored, eventId), false);

  // 3. Publish, exactly as the PATCH toggle does.
  const patch = resourceWikiUpdateSchema.parse({ id: stored.id, published: true });
  const published = { ...stored, published: patch.published! };
  assert.equal(isPortalVisibleResource(published, eventId), true);

  // 4. Still scoped: another event's portal never sees this row.
  assert.equal(isPortalVisibleResource(published, "evt_other"), false);

  // 5. And it is reachable at the address the organizer was shown.
  assert.equal(portalResourceHref(published.slug), "/portal/resources/speaker-handbook");

  const view = serializeResource(published);
  assert.equal(view.published, true);
  assert.equal(view.slug, "speaker-handbook");
  assert.equal(view.updatedAt, "2026-05-01T00:00:00.000Z");
});

test("the portal's published-only rule is stated once, and the fold reads that same object", () => {
  const where = portalResourceWhere("evt_1");
  assert.deepEqual(where, { eventId: "evt_1", published: true });
  // The predicate is derived from the query, so dropping `published` from one
  // would drop it from the other rather than letting them disagree.
  assert.equal(isPortalVisibleResource({ eventId: "evt_1", published: where.published }, "evt_1"), true);
  assert.equal(isPortalVisibleResource({ eventId: "evt_1", published: !where.published }, "evt_1"), false);
});
