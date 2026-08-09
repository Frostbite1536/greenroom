/** Fields the speaker can edit from their portal profile form. */
export const PORTAL_PROFILE_FIELDS = [
  "bio",
  "company",
  "jobTitle",
  "headshotUrl",
  "slideDeckUrl",
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
