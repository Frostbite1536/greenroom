import { normalizeHex } from "@/lib/color-contrast";

/** Never a value `normalizeHex` can return from readable input. */
const UNREADABLE = "unreadable";

/**
 * Suggested IANA zones offered first in the datalist. Shared by the settings
 * editor and the new-event dialog so the two suggest the same zones; both are
 * free-text inputs and the server remains the authority on what is a valid zone.
 *
 * These are a curated HEAD of the list, not the whole of it — see
 * `timeZoneOptions`. On its own this list caused GRA-TZ: a datalist filters its
 * options by substring against the input's current value, so a field holding a
 * complete zone name matched exactly one option and the organizer saw a
 * one-entry dropdown ("only UTC is available").
 */
export const COMMON_TIME_ZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Toronto",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
];

/**
 * The zone a server render starts from, and the fallback whenever the runtime
 * cannot name its own. The server has no visitor to ask and runs in UTC, so
 * this is also the only honest value for a first paint.
 */
export const FALLBACK_TIME_ZONE = "UTC";

/**
 * Every zone this runtime knows, or `null` when it cannot say.
 *
 * ENVIRONMENT-DEPENDENT — read this from a mount effect, never while rendering.
 * Node on the server and the organizer's browser ship different ICU data, so a
 * value read during render would put a different `<datalist>` in the hydrated
 * DOM than the server sent, which is a hydration mismatch.
 */
export function supportedTimeZones(): readonly string[] | null {
  if (typeof Intl.supportedValuesOf !== "function") return null;
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    // A runtime that advertises the API but ships no zone data is still a
    // runtime the organizer has to create an event from.
    return null;
  }
}

/**
 * The zone the visitor's own machine is set to, or `FALLBACK_TIME_ZONE`.
 *
 * ENVIRONMENT-DEPENDENT for the same reason as `supportedTimeZones`, and more
 * sharply: the server resolves to UTC and the organizer almost never does, so
 * reading this during render would mismatch on nearly every hydration.
 */
export function detectTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TIME_ZONE;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

/**
 * The suggestion list both time-zone fields render: the common zones first, in
 * their curated order, then every other zone the runtime knows.
 *
 * Pure, so the ordering and de-duplication are testable without an environment.
 * Passing `null` (an old runtime, or a render that must stay hydration-safe)
 * degrades to exactly the old twelve rather than to nothing.
 */
export function timeZoneOptions(supported?: readonly string[] | null): string[] {
  const options: string[] = [];
  const seen = new Set<string>();
  for (const zone of [...COMMON_TIME_ZONES, ...(supported ?? [])]) {
    if (seen.has(zone)) continue;
    seen.add(zone);
    options.push(zone);
  }
  return options;
}

export type EventSettingsDraft = {
  name: string;
  timezone: string;
  startsOn: string;
  endsOn: string;
};

export type EventSettingsAuthority = {
  name: string;
  timezone: string;
  startsOn: string | null;
  endsOn: string | null;
};

export type EventSettingsPatch = {
  name?: string;
  timezone?: string;
  startsOn?: string | null;
  endsOn?: string | null;
};

export type EventSettingsReconciliation = {
  baseline: EventSettingsDraft;
  draft: EventSettingsDraft;
};

export function eventSettingsDraft(authoritative: EventSettingsAuthority): EventSettingsDraft {
  return {
    name: authoritative.name,
    timezone: authoritative.timezone,
    startsOn: authoritative.startsOn ?? "",
    endsOn: authoritative.endsOn ?? "",
  };
}

/**
 * Reconcile a newly rendered server event with this editor's draft. A field
 * that still equals the old server baseline was never changed locally, so it
 * should adopt the newer truth. A differing field is an unsaved local edit and
 * must survive unrelated RSC refreshes and keystrokes made after a save began.
 */
export function reconcileEventSettingsDraft(
  baseline: EventSettingsDraft,
  draft: EventSettingsDraft,
  authoritative: EventSettingsAuthority,
  submittedDraft?: EventSettingsDraft,
): EventSettingsReconciliation {
  const nextBaseline = eventSettingsDraft(authoritative);
  const reconcileField = (field: keyof EventSettingsDraft) => {
    if (submittedDraft) {
      return draft[field] === submittedDraft[field] ? nextBaseline[field] : draft[field];
    }
    return draft[field] === baseline[field] ? nextBaseline[field] : draft[field];
  };
  return {
    baseline: nextBaseline,
    draft: {
      name: reconcileField("name"),
      timezone: reconcileField("timezone"),
      startsOn: reconcileField("startsOn"),
      endsOn: reconcileField("endsOn"),
    },
  };
}

/** Client-side guidance for the paired event-date contract. The server remains authoritative. */
export function validateEventDatePair(startsOn: string, endsOn: string): string | null {
  if ((startsOn === "") !== (endsOn === "")) {
    return "Enter both event dates, or clear both dates together.";
  }
  if (startsOn !== "" && startsOn > endsOn) {
    return "The event must end on or after its start date.";
  }
  return null;
}

/**
 * Preserve concurrent changes made by another event admin: omit every field
 * the current editor did not change from its latest server-rendered value.
 * Dates are one backend contract, so either date changing sends the complete
 * pair. Returning null prevents an empty PATCH from disguising a no-op.
 */
export function planEventSettingsPatch(
  draft: EventSettingsDraft,
  authoritative: EventSettingsAuthority,
): EventSettingsPatch | null {
  const patch: EventSettingsPatch = {};
  if (draft.name !== authoritative.name) patch.name = draft.name;
  if (draft.timezone !== authoritative.timezone) patch.timezone = draft.timezone;

  const startsOn = authoritative.startsOn ?? "";
  const endsOn = authoritative.endsOn ?? "";
  if (draft.startsOn !== startsOn || draft.endsOn !== endsOn) {
    patch.startsOn = draft.startsOn || null;
    patch.endsOn = draft.endsOn || null;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

// ---- Settings row editors -------------------------------------------------
//
// The room, track and category row editors need the same guarantee the event
// form above already makes, for the same reason: two admins share one settings
// page. A row editor loads a snapshot, so resending every field on save would
// carry that snapshot's now-stale values over a colleague's newer edit — a
// rename would quietly undo a routing-key change made thirty seconds earlier.
// The server contracts (`roomUpdateSchema`, `trackUpdateSchema`,
// `categoryUpdateSchema`) are partial and require at least one field precisely
// so the client can send sparsely; these planners make the client actually do
// it. Each diffs against the row as loaded, never against current server truth:
// a field this operator never touched must be omitted exactly when a colleague
// has already changed it, which is the case a diff against current truth would
// get wrong.

/** `null` clears an optional text column; a value sets it; `""` means cleared. */
export function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export type RoomRowDraft = { name: string; capacity: number | null };
export type RoomRowAuthority = { name: string; capacity: number | null };
export type RoomRowPatch = { name?: string; capacity?: number | null };

/**
 * Omit every room field the editor did not change from the row as loaded.
 *
 * Capacity arrives already parsed rather than as the raw input string: the
 * field is genuinely tri-state (a number, empty meaning cleared, or invalid),
 * and only the caller can tell "cleared" from "typed nonsense" and refuse the
 * latter before anything is planned. `null` here therefore always means the
 * operator cleared it, which `roomCapacitySchema` accepts as an explicit clear.
 *
 * `sortOrder` is patchable on the wire but this editor does not expose it, so
 * it is never planned and a save cannot disturb the stored room order.
 */
export function planRoomPatch(
  draft: RoomRowDraft,
  authoritative: RoomRowAuthority,
): RoomRowPatch | null {
  const patch: RoomRowPatch = {};
  const name = draft.name.trim();
  if (name !== authoritative.name) patch.name = name;
  if (draft.capacity !== (authoritative.capacity ?? null)) patch.capacity = draft.capacity;
  return Object.keys(patch).length > 0 ? patch : null;
}

export type TrackRowDraft = { name: string; color: string };
export type TrackRowAuthority = { name: string; color: string };
export type TrackRowPatch = { name?: string; color?: string };

/**
 * Omit every track field the editor did not change from the server-rendered
 * row. Colours are compared in their normalized `#rrggbb` form: the column also
 * accepts `#rgb` and the bare forms, and the editor's colour input always shows
 * the expanded one, so a raw string compare would report a spurious change and
 * write a colour the operator never touched.
 */
export function planTrackPatch(
  draft: TrackRowDraft,
  authoritative: TrackRowAuthority,
): TrackRowPatch | null {
  const patch: TrackRowPatch = {};
  const name = draft.name.trim();
  if (name !== authoritative.name) patch.name = name;
  // A sentinel, not a real colour: two unreadable stored values compare equal
  // to each other and never to a colour the editor could actually be showing.
  if (normalizeHex(draft.color, UNREADABLE) !== normalizeHex(authoritative.color, UNREADABLE)) {
    patch.color = draft.color;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

export type CategoryRowDraft = { name: string; description: string; defaultTeamKey: string };
export type CategoryRowAuthority = { name: string; description: string | null; defaultTeamKey: string | null };
export type CategoryRowPatch = { name?: string; description?: string | null; defaultTeamKey?: string | null };

/**
 * Omit every category field the editor did not change from the server-rendered
 * row. This is the one that matters most: `defaultTeamKey` routes a category's
 * proposals to a review team, and a rename that resent a stale copy of it would
 * silently unroute the category or revert a colleague's routing change.
 */
export function planCategoryPatch(
  draft: CategoryRowDraft,
  authoritative: CategoryRowAuthority,
): CategoryRowPatch | null {
  const patch: CategoryRowPatch = {};
  const name = draft.name.trim();
  const description = optionalText(draft.description);
  const defaultTeamKey = optionalText(draft.defaultTeamKey);
  if (name !== authoritative.name) patch.name = name;
  if (description !== (authoritative.description ?? null)) patch.description = description;
  if (defaultTeamKey !== (authoritative.defaultTeamKey ?? null)) patch.defaultTeamKey = defaultTeamKey;
  return Object.keys(patch).length > 0 ? patch : null;
}
