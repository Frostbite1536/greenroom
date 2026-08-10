/**
 * Server-only projection of the *open* public CFP forms for one event.
 *
 * This lives beside `lib/data/reads.ts` rather than inside it because it is the
 * single authority for the C16 entry-point contract (Architect decision
 * D-C5-3). Every "Submit a talk" entry point — workspace navigation, speaker
 * portal, portal resources, and the public landing page — renders from this one
 * projection so the zero/one/many behaviour cannot drift between surfaces.
 *
 * D-C5-3 definition: a form is an open public CFP iff `published = true` AND
 * (`opensAt` is null or <= now) AND (`closesAt` is null or > now).
 *
 * This is a PUBLIC read. It exposes only published, currently-open forms and
 * only the fields an anonymous visitor may see: display name, canonical public
 * path, and the close date. No unpublished form, no submission/draft counts, no
 * form configuration, no ids of anything but the form itself (needed as a React
 * key). Callers must never widen it with an admin-only field.
 */
import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { DEFAULT_PUBLIC_EVENT } from "@/lib/default-event";
import { canonicalPublicFormPath } from "@/lib/services/public-form-resolver";

/**
 * The public event the anonymous surfaces default to, matching
 * `getPublicAgenda()` / `getPublicSpeakers()` in `lib/data/reads.ts`.
 *
 * Re-exported from `lib/default-event.ts` so the pinned slug has one home that
 * pure modules can import without pulling Prisma in. Existing importers of
 * `DEFAULT_PUBLIC_EVENT` from this module are unaffected.
 */
export { DEFAULT_PUBLIC_EVENT };

/**
 * Safety bound on a single entry-point read, in the spirit of
 * `lib/api/query-limits.ts`. A public entry point must never throw the way an
 * operator export does, so an event past this bound reports `truncated` and the
 * chooser says so instead of silently dropping calls.
 */
export const OPEN_CFP_LIST_TAKE = 50;

/** Copy shared by every C16 surface so the entry reads identically. */
export const OPEN_CFP_LABELS = {
  heading: "Submit a talk",
  none: "No open call for proposals",
  chooserLead: "Choose which call for proposals you want to submit to.",
} as const;

export type OpenCfpEvent = { name: string; slug: string; timezone: string };

/** The raw row shape the window predicate and ordering are defined over. */
export type OpenCfpCandidate = {
  id: string;
  name: string;
  slug: string;
  published: boolean;
  opensAt: Date | null;
  closesAt: Date | null;
};

/** One open call, already reduced to what a public surface may render. */
export type OpenCfpForm = {
  id: string;
  name: string;
  /** Canonical public path — the only URL any C16 surface may link. */
  href: string;
  closesAt: string | null;
  /** Close date pinned to en-US in the event timezone, or null when open-ended. */
  closesAtLabel: string | null;
};

export type OpenCfpEntryState = "none" | "one" | "many";

/**
 * `state` is the D-C5-3 entry state and is always consistent with `forms`:
 * `none` → zero forms, `one` → exactly one, `many` → two or more. A surface
 * switches on `state`; it must never pick a form out of a `many` entry.
 */
export type OpenCfpEntry = {
  state: OpenCfpEntryState;
  event: OpenCfpEvent | null;
  forms: OpenCfpForm[];
  truncated: boolean;
};

export function emptyOpenCfpEntry(event: OpenCfpEvent | null = null): OpenCfpEntry {
  return { state: "none", event, forms: [], truncated: false };
}

/** D-C5-3 window predicate. `opensAt === now` is open; `closesAt === now` is closed. */
export function isOpenPublicCfp(
  form: Pick<OpenCfpCandidate, "published" | "opensAt" | "closesAt">,
  now: Date,
): boolean {
  if (!form.published) return false;
  const at = now.getTime();
  if (form.opensAt && form.opensAt.getTime() > at) return false;
  if (form.closesAt && form.closesAt.getTime() <= at) return false;
  return true;
}

/**
 * D-C5-3 chooser order: `closesAt` ascending with nulls last, then `name`
 * ascending, then `id` ascending. Comparison is codepoint-ordered rather than
 * locale-collated so two servers in different locales produce the same list.
 */
export function compareOpenCfpCandidates(
  a: Pick<OpenCfpCandidate, "id" | "name" | "closesAt">,
  b: Pick<OpenCfpCandidate, "id" | "name" | "closesAt">,
): number {
  const aCloses = a.closesAt ? a.closesAt.getTime() : null;
  const bCloses = b.closesAt ? b.closesAt.getTime() : null;
  if (aCloses !== bCloses) {
    if (aCloses === null) return 1;
    if (bCloses === null) return -1;
    return aCloses - bCloses;
  }
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * Render the deadline in the event's timezone, not the render machine's: the
 * date a speaker reads must be the date the server enforces.
 */
function formatClosesAt(closesAt: Date | null, timezone: string): string | null {
  if (!closesAt) return null;
  return closesAt.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: timezone,
  });
}

/** Pure D-C5-3 selection: filter to the open window, order, bound, classify. */
export function selectOpenCfpEntry(input: {
  event: OpenCfpEvent | null;
  forms: readonly OpenCfpCandidate[];
  now: Date;
  take?: number;
}): OpenCfpEntry {
  const { event, now } = input;
  if (!event) return emptyOpenCfpEntry(null);

  const take = input.take ?? OPEN_CFP_LIST_TAKE;
  const open = input.forms
    .filter((form) => isOpenPublicCfp(form, now))
    .sort(compareOpenCfpCandidates);
  const visible = open.slice(0, Math.max(take, 0));

  return {
    state: visible.length === 0 ? "none" : visible.length === 1 ? "one" : "many",
    event,
    forms: visible.map((form) => ({
      id: form.id,
      name: form.name,
      href: canonicalPublicFormPath({ eventSlug: event.slug, formSlug: form.slug }),
      closesAt: form.closesAt ? form.closesAt.toISOString() : null,
      closesAtLabel: formatClosesAt(form.closesAt, event.timezone),
    })),
    truncated: open.length > visible.length,
  };
}

/**
 * Navigation entries for the workspace shell. Zero open forms still produces a
 * visible, honest entry with no destination (`href: null`) rather than a dead
 * link; two or more produce one entry per call so the shell never chooses.
 */
export function openCfpNavItems(entry: OpenCfpEntry): { href: string | null; label: string }[] {
  if (entry.state === "none") {
    return [{ href: null, label: `${OPEN_CFP_LABELS.heading} — ${OPEN_CFP_LABELS.none}` }];
  }
  if (entry.state === "one") {
    const [only] = entry.forms;
    return only ? [{ href: only.href, label: OPEN_CFP_LABELS.heading }] : [];
  }
  return entry.forms.map((form) => ({
    href: form.href,
    label: `${OPEN_CFP_LABELS.heading}: ${form.name}`,
  }));
}

/**
 * Typed data seam. Production delegates to Prisma; tests exercise the selection
 * policy directly without opening a database connection.
 */
export type OpenCfpReaderClient = {
  findEvent(eventParam: string): Promise<(OpenCfpEvent & { id: string }) | null>;
  listOpenPublishedForms(input: {
    eventId: string;
    now: Date;
    take: number;
  }): Promise<readonly OpenCfpCandidate[]>;
};

const prismaOpenCfpReaderClient: OpenCfpReaderClient = {
  async findEvent(eventParam) {
    return prisma.event.findFirst({
      where: { OR: [{ id: eventParam }, { slug: eventParam }] },
      select: { id: true, name: true, slug: true, timezone: true },
    });
  },
  async listOpenPublishedForms({ eventId, now, take }) {
    // The window is filtered in SQL so the bound applies to already-open forms,
    // and ordered by the same keys as `compareOpenCfpCandidates` (Postgres sorts
    // NULLs last for ASC) so a bounded page is the correct prefix. The pure
    // comparator still re-sorts and remains the authority.
    return prisma.formConfig.findMany({
      where: {
        eventId,
        published: true,
        AND: [
          { OR: [{ opensAt: null }, { opensAt: { lte: now } }] },
          { OR: [{ closesAt: null }, { closesAt: { gt: now } }] },
        ],
      },
      orderBy: [{ closesAt: "asc" }, { name: "asc" }, { id: "asc" }],
      take,
      select: { id: true, name: true, slug: true, published: true, opensAt: true, closesAt: true },
    });
  },
};

export async function readOpenCfpEntry(
  eventParam: string = DEFAULT_PUBLIC_EVENT,
  client: OpenCfpReaderClient = prismaOpenCfpReaderClient,
  now: Date = new Date(),
): Promise<OpenCfpEntry> {
  const event = await client.findEvent(eventParam);
  if (!event) return emptyOpenCfpEntry(null);

  const forms = await client.listOpenPublishedForms({
    eventId: event.id,
    now,
    // One past the bound so `truncated` is observed rather than inferred.
    take: OPEN_CFP_LIST_TAKE + 1,
  });
  return selectOpenCfpEntry({
    event: { name: event.name, slug: event.slug, timezone: event.timezone },
    forms,
    now,
  });
}

/**
 * Request-deduplicated entry read: the workspace layout and the page inside it
 * both need the entry, and `cache()` collapses that into one query.
 */
export const getOpenCfpEntry = cache(async function getOpenCfpEntry(
  eventParam: string = DEFAULT_PUBLIC_EVENT,
): Promise<OpenCfpEntry> {
  return readOpenCfpEntry(eventParam);
});
