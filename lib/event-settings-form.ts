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
