import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalPublicFormApiPath,
  canonicalPublicFormPath,
  resolveLegacyPublishedPublicForm,
  resolvePublishedPublicForm,
  type PublicFormResolverClient,
  type PublishedPublicForm,
} from "@/lib/services/public-form-resolver";

type Calls = {
  eventSlugs: string[];
  ownedFormLookups: Array<{ eventId: string; formSlug: string }>;
  exactIds: string[];
  legacySlugLookups: Array<{ formSlug: string; take: number }>;
};

type ResolverFakeOptions = {
  event?: { id: string } | null;
  canonicalForm?: PublishedPublicForm | null;
  exactForm?: { published: boolean; slug: string; event: { slug: string } } | null;
  slugMatches?: readonly { slug: string; event: { slug: string } }[];
};

function form(published: boolean): PublishedPublicForm {
  return { published } as PublishedPublicForm;
}

function resolverFake(options: ResolverFakeOptions = {}) {
  const calls: Calls = {
    eventSlugs: [],
    ownedFormLookups: [],
    exactIds: [],
    legacySlugLookups: [],
  };
  const client: PublicFormResolverClient = {
    async findEventBySlug(eventSlug) {
      calls.eventSlugs.push(eventSlug);
      return options.event ?? null;
    },
    async findEventOwnedFormBySlug(input) {
      calls.ownedFormLookups.push(input);
      return options.canonicalForm ?? null;
    },
    async findLegacyFormById(formId) {
      calls.exactIds.push(formId);
      return options.exactForm ?? null;
    },
    async findPublishedFormsBySlug(formSlug, take) {
      calls.legacySlugLookups.push({ formSlug, take });
      return options.slugMatches ?? [];
    },
  };
  return { client, calls };
}

test("canonical public form paths preserve event and form scope as path segments", () => {
  const scope = { eventSlug: "green room", formSlug: "call/for talks" };
  assert.equal(canonicalPublicFormPath(scope), "/cfp/green%20room/call%2Ffor%20talks");
  assert.equal(canonicalPublicFormApiPath(scope), "/api/cfp/public/green%20room/call%2Ffor%20talks");
});

test("canonical resolver stops at an unknown event without an event-owned form lookup", async () => {
  const { client, calls } = resolverFake();
  assert.equal(await resolvePublishedPublicForm({ eventSlug: "unknown", formSlug: "cfp" }, client), null);
  assert.deepEqual(calls.eventSlugs, ["unknown"]);
  assert.deepEqual(calls.ownedFormLookups, []);
});

test("canonical resolver uses the resolved Event id and composite form slug", async () => {
  const expected = form(true);
  const { client, calls } = resolverFake({ event: { id: "event-a" }, canonicalForm: expected });
  assert.equal(await resolvePublishedPublicForm({ eventSlug: "event-a-slug", formSlug: "cfp" }, client), expected);
  assert.deepEqual(calls.eventSlugs, ["event-a-slug"]);
  assert.deepEqual(calls.ownedFormLookups, [{ eventId: "event-a", formSlug: "cfp" }]);
});

test("canonical resolver hides an unpublished event-owned form", async () => {
  const { client, calls } = resolverFake({ event: { id: "event-a" }, canonicalForm: form(false) });
  assert.equal(await resolvePublishedPublicForm({ eventSlug: "event-a", formSlug: "private" }, client), null);
  assert.deepEqual(calls.ownedFormLookups, [{ eventId: "event-a", formSlug: "private" }]);
});

test("legacy resolver returns a stable scope for an exact published id without a slug read", async () => {
  const { client, calls } = resolverFake({
    exactForm: { published: true, slug: "cfp", event: { slug: "event-a" } },
    slugMatches: [{ slug: "other", event: { slug: "event-b" } }],
  });
  assert.deepEqual(await resolveLegacyPublishedPublicForm("form-id", client), {
    eventSlug: "event-a",
    formSlug: "cfp",
  });
  assert.deepEqual(calls.exactIds, ["form-id"]);
  assert.deepEqual(calls.legacySlugLookups, []);
});

test("legacy resolver gives an existing unpublished id precedence and does not fall through to a slug", async () => {
  const { client, calls } = resolverFake({
    exactForm: { published: false, slug: "private", event: { slug: "event-a" } },
    slugMatches: [{ slug: "form-id", event: { slug: "event-b" } }],
  });
  assert.equal(await resolveLegacyPublishedPublicForm("form-id", client), null);
  assert.deepEqual(calls.exactIds, ["form-id"]);
  assert.deepEqual(calls.legacySlugLookups, []);
});

test("legacy resolver accepts one published slug and records the hard candidate cap", async () => {
  const { client, calls } = resolverFake({
    slugMatches: [{ slug: "legacy", event: { slug: "event-a" } }],
  });
  assert.deepEqual(await resolveLegacyPublishedPublicForm("legacy", client), {
    eventSlug: "event-a",
    formSlug: "legacy",
  });
  assert.deepEqual(calls.legacySlugLookups, [{ formSlug: "legacy", take: 2 }]);
});

test("legacy resolver fails closed for zero or colliding capped published slug candidates", async () => {
  for (const slugMatches of [
    [],
    [
      { slug: "legacy", event: { slug: "event-a" } },
      { slug: "legacy", event: { slug: "event-b" } },
    ],
  ] as const) {
    const { client, calls } = resolverFake({ slugMatches });
    assert.equal(await resolveLegacyPublishedPublicForm("legacy", client), null);
    assert.deepEqual(calls.legacySlugLookups, [{ formSlug: "legacy", take: 2 }]);
  }
});
