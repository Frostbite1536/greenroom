import type { Event } from "@prisma/client";
import { zonedParts, zonedToUtcIso } from "@/lib/tz";

export type SettingsEvent = Pick<Event, "id" | "name" | "slug" | "timezone" | "startsAt" | "endsAt">;
export type EventSettingsPatch = {
  name?: string;
  timezone?: string;
  startsOn?: string | null;
  endsOn?: string | null;
};

function localDate(date: Date | null, timezone: string): string | null {
  return date ? zonedParts(date.toISOString(), timezone).dateKey : null;
}

/** The settings page receives event-calendar dates, never browser-local UTC instants. */
export function serializeSettingsEvent(event: SettingsEvent) {
  return {
    id: event.id,
    name: event.name,
    slug: event.slug,
    timezone: event.timezone,
    startsOn: localDate(event.startsAt, event.timezone),
    endsOn: localDate(event.endsAt, event.timezone),
  };
}

/**
 * Plan the minimal event update. Timezone-only changes preserve local calendar
 * dates, so a May 12–14 event remains May 12–14 for its organisers.
 */
export function planEventSettingsUpdate(event: SettingsEvent, patch: EventSettingsPatch) {
  const timezone = patch.timezone ?? event.timezone;
  const datesProvided = patch.startsOn !== undefined || patch.endsOn !== undefined;
  const startsOn = datesProvided ? patch.startsOn ?? null : localDate(event.startsAt, event.timezone);
  const endsOn = datesProvided ? patch.endsOn ?? null : localDate(event.endsAt, event.timezone);

  if (startsOn && endsOn && startsOn > endsOn) {
    throw new RangeError("The event must end on or after its start date.");
  }

  return {
    name: patch.name ?? event.name,
    timezone,
    startsAt: startsOn ? new Date(zonedToUtcIso(startsOn, "00:00", timezone)) : null,
    endsAt: endsOn ? new Date(zonedToUtcIso(endsOn, "23:59", timezone)) : null,
  };
}
