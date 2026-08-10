/**
 * Suggested IANA zones offered as a datalist. Shared by the settings editor and
 * the new-event dialog so the two suggest the same zones; both are free-text
 * inputs and the server remains the authority on what is a valid zone.
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
