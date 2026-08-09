import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** The only authority for a canonical public CFP read. */
export type PublicFormScope = {
  eventSlug: string;
  formSlug: string;
};

/**
 * Canonical public-form reads need the event-owned categories as well as the
 * form fields. The Event slug is selected so callers can build canonical URLs
 * without another unscoped lookup.
 */
export const publicFormInclude = {
  fields: true,
  event: {
    select: {
      slug: true,
      name: true,
      categories: {
        select: { id: true, name: true },
        // Product sort order first; stable tie-breakers keep public clients
        // from seeing arbitrary category ordering.
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
      },
    },
  },
} satisfies Prisma.FormConfigInclude;

export type PublishedPublicForm = Prisma.FormConfigGetPayload<{
  include: typeof publicFormInclude;
}>;

export type LegacyPublicFormCandidate = PublicFormScope;

type ResolverEvent = { id: string };

type LegacyExactPublicForm = {
  published: boolean;
  slug: string;
  event: { slug: string };
};

type LegacySlugPublicForm = {
  slug: string;
  event: { slug: string };
};

/**
 * Small typed data seam for public-form resolution. Production delegates to
 * Prisma below; tests can execute the resolver against a behavioral fake
 * without opening a database connection.
 */
export type PublicFormResolverClient = {
  findEventBySlug(eventSlug: string): Promise<ResolverEvent | null>;
  findEventOwnedFormBySlug(input: {
    eventId: string;
    formSlug: string;
  }): Promise<PublishedPublicForm | null>;
  findLegacyFormById(formId: string): Promise<LegacyExactPublicForm | null>;
  findPublishedFormsBySlug(formSlug: string, take: 2): Promise<readonly LegacySlugPublicForm[]>;
};

const prismaPublicFormResolverClient: PublicFormResolverClient = {
  async findEventBySlug(eventSlug) {
    return prisma.event.findUnique({
      where: { slug: eventSlug },
      select: { id: true },
    });
  },
  async findEventOwnedFormBySlug({ eventId, formSlug }) {
    return prisma.formConfig.findUnique({
      where: { eventId_slug: { eventId, slug: formSlug } },
      include: publicFormInclude,
    });
  },
  async findLegacyFormById(formId) {
    return prisma.formConfig.findUnique({
      where: { id: formId },
      select: {
        published: true,
        slug: true,
        event: { select: { slug: true } },
      },
    });
  },
  async findPublishedFormsBySlug(formSlug, take) {
    return prisma.formConfig.findMany({
      where: { slug: formSlug, published: true },
      select: {
        slug: true,
        event: { select: { slug: true } },
      },
      take,
    });
  },
};

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

export function canonicalPublicFormPath(scope: PublicFormScope): string {
  return `/cfp/${encodePathSegment(scope.eventSlug)}/${encodePathSegment(scope.formSlug)}`;
}

export function canonicalPublicFormApiPath(scope: PublicFormScope): string {
  return `/api/cfp/public/${encodePathSegment(scope.eventSlug)}/${encodePathSegment(scope.formSlug)}`;
}

/**
 * Resolve a canonical public form through its globally unique Event slug and
 * that Event's composite-unique FormConfig slug. Unknown Event, cross-event
 * form, and unpublished form all return null for callers to map to the single
 * public FORM_NOT_FOUND response.
 */
export async function resolvePublishedPublicForm(
  scope: PublicFormScope,
  client: PublicFormResolverClient = prismaPublicFormResolverClient,
): Promise<PublishedPublicForm | null> {
  const event = await client.findEventBySlug(scope.eventSlug);
  if (!event) return null;

  const form = await client.findEventOwnedFormBySlug({ eventId: event.id, formSlug: scope.formSlug });
  return form?.published ? form : null;
}

/**
 * Decide legacy resolution without selecting an arbitrary slug collision. An
 * exact ID is considered first; only a missing ID may fall through to the
 * capped published-slug candidates. Existing unpublished IDs never redirect.
 */
export function selectLegacyPublicFormScope(args: {
  exactId: LegacyPublicFormCandidate | null;
  slugMatches: readonly LegacyPublicFormCandidate[];
}): LegacyPublicFormCandidate | null {
  if (args.exactId) return args.exactId;
  return args.slugMatches.length === 1 ? args.slugMatches[0] : null;
}

/**
 * Compatibility resolver for the old one-segment public route. Exact
 * published IDs work, while a historical slug works only when its bounded
 * lookup finds exactly one published candidate. It must never choose a first
 * or lowest-id collision.
 */
export async function resolveLegacyPublishedPublicForm(
  legacyFormIdOrSlug: string,
  client: PublicFormResolverClient = prismaPublicFormResolverClient,
): Promise<LegacyPublicFormCandidate | null> {
  const exact = await client.findLegacyFormById(legacyFormIdOrSlug);

  // An ID-shaped existing form has ID precedence even when unpublished: do
  // not reinterpret it as a potentially unrelated legacy slug.
  if (exact) {
    return exact.published
      ? { eventSlug: exact.event.slug, formSlug: exact.slug }
      : null;
  }

  const slugMatches = await client.findPublishedFormsBySlug(legacyFormIdOrSlug, 2);
  return selectLegacyPublicFormScope({
    exactId: null,
    slugMatches: slugMatches.map((form) => ({ eventSlug: form.event.slug, formSlug: form.slug })),
  });
}
