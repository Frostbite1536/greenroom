import { Prisma } from "@prisma/client";
import { zonedToUtcIso } from "@/lib/tz";

/**
 * Creating one empty event (Architect decision D-C5-9).
 *
 * Deliberately small: name, slug, event-local dates and timezone. No cloning,
 * no cross-event copying, no deletion. The pure parts live here so they are
 * unit-testable without a database, matching the `event-settings` /
 * `category-mutation-errors` precedent.
 *
 * Date handling is NOT forked from the settings page: the day boundaries are
 * derived with the same `zonedToUtcIso` helper and the same "00:00 / 23:59"
 * convention `planEventSettingsUpdate` uses, so a May 12-14 event means the
 * same instants however it was created.
 */

export type EventCreateInput = {
  name: string;
  slug: string;
  timezone: string;
  startsOn?: string | null;
  endsOn?: string | null;
};

export type EventCreateData = {
  name: string;
  slug: string;
  timezone: string;
  startsAt: Date | null;
  endsAt: Date | null;
};

/**
 * The stored form of a submitted web address. Zod already bounds and pattern-
 * checks the slug; this is the single place the normalisation itself is
 * defined, so the client hint and the stored value cannot disagree.
 */
export function normalizeEventSlug(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Plan the row for a new event. Refuses an inverted pair with the same message
 * `planEventSettingsUpdate` uses, so the two writers give one answer.
 */
export function planEventCreate(input: EventCreateInput): EventCreateData {
  const startsOn = input.startsOn ?? null;
  const endsOn = input.endsOn ?? null;
  if (startsOn && endsOn && startsOn > endsOn) {
    throw new RangeError("The event must end on or after its start date.");
  }
  return {
    name: input.name,
    slug: normalizeEventSlug(input.slug),
    timezone: input.timezone,
    startsAt: startsOn ? new Date(zonedToUtcIso(startsOn, "00:00", input.timezone)) : null,
    endsAt: endsOn ? new Date(zonedToUtcIso(endsOn, "23:59", input.timezone)) : null,
  };
}

/** Expected uniqueness failure for Event's `slug @unique`. */
export function classifyEventCreateError(error: unknown): "EVENT_SLUG_TAKEN" | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return "EVENT_SLUG_TAKEN";
  }
  return null;
}
