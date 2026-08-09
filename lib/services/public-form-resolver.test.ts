import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  canonicalPublicFormApiPath,
  canonicalPublicFormPath,
  selectLegacyPublicFormScope,
} from "@/lib/services/public-form-resolver";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

test("canonical public form paths preserve event and form scope as path segments", () => {
  const scope = { eventSlug: "green room", formSlug: "call/for talks" };
  assert.equal(canonicalPublicFormPath(scope), "/cfp/green%20room/call%2Ffor%20talks");
  assert.equal(canonicalPublicFormApiPath(scope), "/api/cfp/public/green%20room/call%2Ffor%20talks");
});

test("legacy public resolution accepts a published exact id before considering slugs", () => {
  assert.deepEqual(
    selectLegacyPublicFormScope({
      exactId: { eventSlug: "event-a", formSlug: "cfp-a" },
      slugMatches: [
        { eventSlug: "event-b", formSlug: "legacy" },
        { eventSlug: "event-c", formSlug: "legacy" },
      ],
    }),
    { eventSlug: "event-a", formSlug: "cfp-a" },
  );
});

test("legacy public slugs resolve only one published candidate and fail closed for zero or collisions", () => {
  const unique = { eventSlug: "event-a", formSlug: "legacy" };
  assert.deepEqual(selectLegacyPublicFormScope({ exactId: null, slugMatches: [unique] }), unique);
  assert.equal(selectLegacyPublicFormScope({ exactId: null, slugMatches: [] }), null);
  assert.equal(
    selectLegacyPublicFormScope({
      exactId: null,
      slugMatches: [unique, { eventSlug: "event-b", formSlug: "legacy" }],
    }),
    null,
  );
});

test("canonical resolver proves event ownership and published visibility before serialization", () => {
  const resolver = source("lib/services/public-form-resolver.ts");
  assert.match(resolver, /prisma\.event\.findUnique\(\{[\s\S]*where: \{ slug: scope\.eventSlug \}/);
  assert.match(
    resolver,
    /prisma\.formConfig\.findUnique\(\{[\s\S]*where: \{ eventId_slug: \{ eventId: event\.id, slug: scope\.formSlug \} \}/,
  );
  assert.match(resolver, /return form\?\.published \? form : null/);
});

test("legacy resolver is capped and API routes either redirect safely or use the shared canonical resolver", () => {
  const resolver = source("lib/services/public-form-resolver.ts");
  assert.match(resolver, /where: \{ slug: legacyFormIdOrSlug, published: true \}/);
  assert.match(resolver, /take: 2/);
  const legacyLookup = resolver.slice(resolver.indexOf("const slugMatches"));
  assert.doesNotMatch(legacyLookup, /orderBy:/);

  const legacyRoute = source("app/api/cfp/public/[formId]/route.ts");
  assert.match(legacyRoute, /resolveLegacyPublishedPublicForm\(formId\)/);
  assert.match(legacyRoute, /Response\.redirect\(/);
  assert.match(legacyRoute, /"FORM_NOT_FOUND"/);

  const canonicalRoute = source("app/api/cfp/public/[eventSlug]/[formSlug]/route.ts");
  assert.match(canonicalRoute, /resolvePublishedPublicForm\(\{ eventSlug, formSlug \}\)/);
  assert.match(canonicalRoute, /"FORM_NOT_FOUND"/);
});
