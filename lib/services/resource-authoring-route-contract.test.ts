import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source contract for resource/wiki authoring (buyer requirement 8).
 *
 * The properties below are the ones a unit test cannot observe without a
 * database or a browser: which authority each verb demands, where event scope
 * comes from, and — the one that matters most — that sanitizing happens BEFORE
 * the write rather than only on render. Sanitize-at-write is an ordering fact
 * about the route, so it is pinned as one.
 *
 * Regexes are CRLF-safe: nothing matches across a line break without allowing
 * an optional `\r`.
 */
const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/**
 * Read a file with its comments removed, the way `modal-dialogs.source.test.ts`
 * does. This lane's own prose names the very markup it counts (`<dialog>`), so
 * without this a comment about the element would be counted as the element.
 */
const code = (path: string) =>
  source(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");

const route = () => source("app/api/admin/resources/route.ts");

test("every resource verb demands ADMIN, and no other role can reach the writer", () => {
  const resources = route();
  const verbs = [...resources.matchAll(/export const (GET|POST|PATCH|DELETE) = handle\(/g)].map(([, verb]) => verb);
  assert.deepEqual(verbs, ["GET", "POST", "PATCH", "DELETE"]);
  // One `requireContext` per verb, and every one of them ADMIN-only.
  assert.equal([...resources.matchAll(/requireContext\(\["ADMIN"\]\)/g)].length, verbs.length);
  assert.equal([...resources.matchAll(/requireContext\(/g)].length, verbs.length);

  // The page mirrors it, so the sidebar entry never leads somewhere that
  // renders before bouncing.
  const page = source("app/(app)/admin/resources/page.tsx");
  assert.match(page, /if \(ctx\.role !== "ADMIN"\) redirect\("\/portal"\)/);
  assert.match(page, /if \(!ctx\) redirect\("\/login"\)/);
  // Server-rendered like its neighbours: no "use client" on the page itself.
  assert.doesNotMatch(page, /"use client"/);
  assert.match(page, /export const dynamic = "force-dynamic"/);
});

test("INV-HTML-001: every authored body is sanitized BEFORE it is stored", () => {
  const resources = route();

  // One sanitize site, used by both writers, so a third writer cannot be added
  // that quietly skips it.
  assert.match(resources, /function storedHtml\(rawHtml: string\): string \{/);
  assert.match(resources, /const decision = prepareResourceHtml\(rawHtml\)/);
  assert.match(resources, /throw new ApiError\(422, decision\.code, decision\.message/);

  const post = resources.slice(resources.indexOf("export const POST"), resources.indexOf("export const PATCH"));
  assert.match(post, /htmlContent: storedHtml\(input\.htmlContent\)/);
  assert.ok(post.indexOf("storedHtml") < post.indexOf("select: resourceSelect"));
  // The raw body must never be what lands in the column.
  assert.doesNotMatch(post, /htmlContent: input\.htmlContent/);

  const patch = resources.slice(resources.indexOf("export const PATCH"), resources.indexOf("export const DELETE"));
  assert.match(patch, /\{ htmlContent: storedHtml\(input\.htmlContent\) \}/);
  assert.doesNotMatch(patch, /\{ htmlContent: input\.htmlContent \}/);

  // Defence in depth, not replacement: the portal reader still sanitizes what
  // it renders, because rows also arrive from the seed.
  const reader = source("app/(app)/portal/resources/[slug]/page.tsx");
  assert.match(reader, /const safeHtml = sanitizeHtml\(resource\.htmlContent\)/);
  assert.match(reader, /dangerouslySetInnerHTML=\{\{ __html: safeHtml \}\}/);
});

test("S1: event scope is the session's on create and the stored row's on edit and delete", () => {
  const resources = route();

  const post = resources.slice(resources.indexOf("export const POST"), resources.indexOf("export const PATCH"));
  // The contract carries an eventId; it is checked against the session and then
  // discarded — the row is written with the server's own value.
  assert.match(post, /assertEventScope\(ctx, input\.eventId\)/);
  assert.match(post, /eventId: ctx\.eventId/);
  assert.doesNotMatch(post, /eventId: input\.eventId/);

  const patch = resources.slice(resources.indexOf("export const PATCH"), resources.indexOf("export const DELETE"));
  assert.match(patch, /prisma\.\$transaction\(/);
  assert.match(patch, /FROM "ResourceWiki" WHERE "id" = \$\{input\.id\} FOR UPDATE/);
  assert.match(patch, /requireEventOwnedRow\(existing, ctx\.eventId, "RESOURCE_NOT_FOUND", "Resource page"\)/);
  assert.ok(patch.indexOf("FOR UPDATE") < patch.indexOf("tx.resourceWiki.update"));

  const del = resources.slice(resources.indexOf("export const DELETE"));
  assert.match(del, /prisma\.\$transaction\(/);
  assert.match(del, /WHERE "id" = \$\{resourceId\} AND "eventId" = \$\{ctx\.eventId\}/);
  assert.match(del, /FOR UPDATE/);
  assert.ok(del.indexOf("FOR UPDATE") < del.indexOf("tx.resourceWiki.delete"));
});

test("a taken portal address is a named 409 on both writers, never a leaked 500", () => {
  const resources = route();
  assert.match(resources, /new ApiError\(409, "RESOURCE_SLUG_TAKEN"/);
  assert.match(resources, /slug: \["This web address is already in use\."\]/);
  // Both the create and the edit map it; a collision is reachable from either.
  assert.equal(
    [...resources.matchAll(/classifyResourceMutationError\(error\) === "RESOURCE_SLUG_TAKEN"|mutationError === "RESOURCE_SLUG_TAKEN"/g)].length,
    2,
  );
  // The concurrent-delete race stays indistinguishable from an unknown id.
  assert.match(resources, /mutationError === "RESOURCE_NOT_FOUND"/);
  assert.match(resources, /new ApiError\(404, "RESOURCE_NOT_FOUND", "Resource page not found\."\)/);
});

test("the read is bounded cap-plus-one on both the route and the page", () => {
  const resources = route();
  assert.match(resources, /take: OPERATOR_QUERY_LIMITS\.adminResources \+ 1/);
  assert.match(resources, /assertEventQueryBound\(resources, OPERATOR_QUERY_LIMITS\.adminResources, "resource pages"\)/);

  const page = source("app/(app)/admin/resources/page.tsx");
  assert.match(page, /take: OPERATOR_QUERY_LIMITS\.adminResources \+ 1/);
  assert.match(page, /rows\.length > OPERATOR_QUERY_LIMITS\.adminResources/);
});

test("the portal's published-only rule is read from one shared helper by both surfaces", () => {
  for (const path of ["app/(app)/portal/page.tsx", "app/(app)/portal/resources/[slug]/page.tsx"]) {
    const portal = source(path);
    assert.match(portal, /from "@\/lib\/services\/resource-wiki"/, path);
    assert.match(portal, /portalResourceWhere\(/, path);
    // Neither surface may restate the filter and drift from the other.
    assert.doesNotMatch(portal, /published: true/, path);
  }
});

test("the authoring UI is a native <dialog>, and its HTML field says what happens to HTML", () => {
  const manager = code("components/resource-manager.tsx");
  assert.match(manager, /^"use client";/);
  assert.match(manager, /useRef<HTMLDialogElement>\(null\)/);
  assert.match(manager, /dialog\.showModal\(\)/);
  assert.match(manager, /onCancel=\{/);
  assert.match(manager, /if \(event\.target === dialogRef\.current && !submitting\) onClose\(\)/);
  assert.equal([...manager.matchAll(/<dialog\b/g)].length, 1);
  assert.match(manager, /aria-labelledby=\{`\$\{ids\}-title`\}/);

  // The honest label. An organizer pasting an embed has to learn it will not
  // survive BEFORE they publish a page that silently lost half its content.
  assert.match(manager, /HTML is supported and sanitized before it is saved\./);
  assert.match(manager, /scripts, styles, iframes and other embeds are removed/);

  // Delete confirms; publish state is a first-class control, not a hidden field.
  assert.match(manager, /window\.confirm\(/);
  assert.match(manager, /async function togglePublished\(/);
  assert.match(manager, /published: !resource\.published/);

  // Every mutation goes through the API, and a success re-reads the server
  // rather than patching a local list.
  for (const call of [/apiPost<\{ resource: ResourceView \}>\("\/api\/admin\/resources"/, /apiPatch<\{ resource: ResourceView \}>\("\/api\/admin\/resources"/, /apiDelete<\{ resource: ResourceView \}>\(/]) {
    assert.match(manager, call);
  }
  assert.match(manager, /startTransition\(\(\) => router\.refresh\(\)\)/);
});

test("the sidebar advertises the page, ADMIN-only, matching what the page enforces", () => {
  const shell = source("components/app-shell.tsx");
  assert.match(
    shell,
    /\{ href: "\/admin\/resources", label: "Resources & wiki", icon: BookOpen, roles: \["ADMIN"\] \}/,
  );
  assert.match(shell, /^\s*BookOpen,$/m);
});
