/**
 * Fields the speaker can edit from their portal profile form.
 *
 * Four of these are `SpeakerProfile` columns — one global row per person for
 * the whole instance. `eventSlideDeckUrl` is NOT: it addresses this speaker's
 * `EventSpeakerDeck` association for the event the session is currently on, and
 * `PATCH /api/portal/profile` routes it there rather than onto the profile row.
 * It lives in this list anyway because the list is the FORM's, not the table's:
 * the dirty-tracking, the patch diff, and the post-save reconciliation are the
 * same for it as for every other field, and giving it a parallel copy of all
 * three is how the two would drift.
 *
 * `slideDeckUrl` — the global column — is deliberately still here and still
 * writable. It is the documented fallback for every event with no association,
 * so removing the speaker's ability to set it would have replaced one gap with
 * another.
 */
export const PORTAL_PROFILE_FIELDS = [
  "bio",
  "company",
  "jobTitle",
  "headshotUrl",
  "slideDeckUrl",
  "eventSlideDeckUrl",
] as const;

export type PortalProfileField = (typeof PORTAL_PROFILE_FIELDS)[number];
export type PortalProfile = Record<PortalProfileField, string>;
export type PortalProfilePatch = Partial<Record<PortalProfileField, string | null>>;

function normalizeProfileValue(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

/** Convert nullable persisted values into controlled form values. */
export function profileFormValues(profile: Partial<Record<PortalProfileField, string | null>> | null): PortalProfile {
  return Object.fromEntries(
    PORTAL_PROFILE_FIELDS.map((field) => [field, normalizeProfileValue(profile?.[field]) ?? ""]),
  ) as PortalProfile;
}

/**
 * Produce a PATCH payload, not a replacement. Blank changes are deliberate
 * clears (`null`); values unchanged after trim are omitted and therefore
 * preserved by the server.
 */
export function profilePatch(initial: PortalProfile, current: PortalProfile): PortalProfilePatch {
  const patch: PortalProfilePatch = {};
  for (const field of PORTAL_PROFILE_FIELDS) {
    const before = normalizeProfileValue(initial[field]);
    const after = normalizeProfileValue(current[field]);
    if (before !== after) patch[field] = after;
  }
  return patch;
}

/**
 * Apply a successful PATCH response without discarding typing that happened
 * after its request snapshot. Those newer values stay dirty against `saved`.
 */
export function reconcileSavedProfile(
  submitted: PortalProfile,
  current: PortalProfile,
  saved: PortalProfile,
): PortalProfile {
  return Object.fromEntries(
    PORTAL_PROFILE_FIELDS.map((field) => [field, current[field] === submitted[field] ? saved[field] : current[field]]),
  ) as PortalProfile;
}
