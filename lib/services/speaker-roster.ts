import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { idSchema, speakerProfileUpdateSchema } from "@/types/api";

/**
 * Organizer-side speaker administration for `/admin/speakers` (SPK-02).
 *
 * Two hard boundaries define this module, and both are about identity.
 *
 * A `User` is global: one row serves every event on the instance. So adding a
 * speaker **reuses** the account behind an email rather than creating a second
 * one, and it never rewrites that account's `name` — the C17 provisioning
 * behaviour (`user.upsert` with an empty `update`). Changing an existing user's
 * email is not implemented anywhere here: it is an identity mutation whose
 * uniqueness rules (S10) and recipient derivation (C26) live elsewhere, and a
 * silent rewrite would redirect another event's mail.
 *
 * A `SpeakerProfile` is the editable half. Its field rules are NOT restated
 * here: they are the portal's own `speakerProfileUpdateSchema` (C13), reused
 * verbatim, so an organizer editing a bio and a speaker editing the same bio
 * are validated and normalized by exactly one set of rules — trim to a value,
 * blank to an explicit `null`, URLs parsed.
 */

/**
 * The profile fields an organizer may set. `socialLinks` is deliberately
 * excluded: it is the only optional JSON column, it needs Prisma's `DbNull`
 * sentinel to clear, and no organizer surface offers it — leaving it out means
 * an admin edit can never blank a speaker's links as a side effect.
 */
export const ADMIN_SPEAKER_PROFILE_FIELDS = [
  "bio",
  "company",
  "jobTitle",
  "headshotUrl",
  "slideDeckUrl",
] as const;

export type AdminSpeakerProfileField = (typeof ADMIN_SPEAKER_PROFILE_FIELDS)[number];

/**
 * Where a speaker is in accepting their invitation (SPK-04).
 *
 * Deliberately not part of `speakerProfileUpdateSchema`: the portal's schema is
 * the speaker's own editable prose, and whether an organizer considers somebody
 * confirmed is the organizer's record, not a field the speaker sets about
 * themselves. It is still stored on `SpeakerProfile`, so it is global and
 * inherits the shared-speaker refusal below exactly like every other field
 * there — an organizer may not decide a shared speaker's status either.
 */
export const SPEAKER_STATUSES = ["INVITED", "CONFIRMED", "DECLINED"] as const;
export type SpeakerStatusValue = (typeof SPEAKER_STATUSES)[number];

export const speakerStatusSchema = z.enum(SPEAKER_STATUSES);

/** The portal's rules, narrowed to the organizer's fields. Not a copy of them. */
export const adminSpeakerProfileFields = speakerProfileUpdateSchema
  .pick({
    bio: true,
    company: true,
    jobTitle: true,
    headshotUrl: true,
    slideDeckUrl: true,
  })
  .extend({ status: speakerStatusSchema.optional() });

export type AdminSpeakerProfilePatch = z.infer<typeof adminSpeakerProfileFields>;

/**
 * POST body: provision one speaker onto this event. No event or authority id is
 * accepted — the signed ADMIN context is the only event authority (INV-EVENT-001).
 * Email and name match the reviewer-invite contract so the two provisioning
 * surfaces normalize an identity identically.
 */
export const adminSpeakerCreateSchema = adminSpeakerProfileFields
  .extend({
    email: z.string().trim().toLowerCase().max(254).email(),
    name: z.string().trim().min(1).max(120),
  })
  .strict();

export type AdminSpeakerCreate = z.infer<typeof adminSpeakerCreateSchema>;

/**
 * PATCH body: edit one existing speaker's profile. `userId` addresses the row;
 * it is authorized against this event's roster server-side, never trusted.
 *
 * `name` and `email` are absent by design — `.strict()` makes sending either a
 * validation failure rather than a silently ignored field, so a client can
 * never believe it renamed someone.
 */
export const adminSpeakerProfilePatchSchema = adminSpeakerProfileFields
  .extend({ userId: idSchema })
  .strict()
  .refine(
    (patch) =>
      ADMIN_SPEAKER_PROFILE_FIELDS.some((field) => patch[field] !== undefined)
      || patch.status !== undefined,
    { message: "Provide at least one profile field to update." },
  );

export type AdminSpeakerProfilePatchInput = z.infer<typeof adminSpeakerProfilePatchSchema>;

/**
 * C13 semantics, carried through to Prisma: an omitted field stays omitted and
 * is therefore preserved, and an explicit `null` is a real instruction to clear
 * the stored value. Returning `{}` for an all-omitted patch is what lets a
 * caller skip the write entirely instead of touching `updatedAt` for nothing.
 */
export function speakerProfileWriteData(
  patch: Partial<Record<AdminSpeakerProfileField, string | null | undefined>>
    & { status?: SpeakerStatusValue },
): Record<string, string | null> {
  const data: Record<string, string | null> = {};
  for (const field of ADMIN_SPEAKER_PROFILE_FIELDS) {
    const value = patch[field];
    if (value !== undefined) data[field] = value;
  }
  // `status` has a stored default and is never cleared to null: an omitted
  // status leaves the record alone, exactly like an omitted bio.
  if (patch.status !== undefined) data.status = patch.status;
  return data;
}

/**
 * `SpeakerProfile` is keyed by a unique `userId` and nothing else: there is one
 * row per person for the whole instance, and it is what every public speaker
 * surface reads (`lib/public-speakers.ts`, `lib/data/reads.ts`,
 * `app/api/v1/speakers`). So an organizer writing it is not writing their own
 * event's data — for a speaker who also takes part in another event, that write
 * lands in the other event's public gallery and API too.
 *
 * Event authority does not extend that far (S1). An organizer may write the
 * global profile only of a speaker who is theirs alone; for a shared speaker
 * the profile stays the speaker's own, editable by them from the portal. Fixing
 * this properly means per-event profiles, which is a schema change and
 * deliberately not taken here.
 */
export const SPEAKER_SHARED_ACROSS_EVENTS = "SPEAKER_SHARED_ACROSS_EVENTS";

/** Plain language for a non-technical organizer, naming the way forward. */
export const SPEAKER_SHARED_MESSAGE =
  "This speaker also takes part in another event, and speaker profiles are shared across every event a person "
  + "appears in. Editing it here would change how they appear on the other event's public page, so only they can "
  + "change it — ask them to update it from their speaker portal.";

/**
 * How many OTHER events this person belongs to. Deliberately a fresh read taken
 * inside the write's own transaction, after the profile key is held: a
 * pre-flight check outside the transaction could be true when it was read and
 * false when the write landed.
 *
 * What this does not close: a membership created concurrently by a *different*
 * event's writer. Holding that event's authority key is not ours to do. Taking
 * the profile key first does serialize this against every other organizer write
 * to the same person's profile, which is the path that could actually overwrite.
 */
export async function countOtherEventMemberships(
  tx: Prisma.TransactionClient,
  userId: string,
  eventId: string,
): Promise<number> {
  return tx.eventMember.count({ where: { userId, eventId: { not: eventId } } });
}

/**
 * Serializing key for one user's global profile row.
 *
 * `SpeakerProfile` is keyed by a unique `userId`, so two concurrent upserts for
 * the same person race to a unique violation. Every organizer write takes this
 * after the event-membership authority keys and before touching the row, which
 * keeps the acquisition order narrowing and cycle-free.
 */
export function speakerProfileLockKey(userId: string): string {
  return `speaker-profile:${userId}`;
}

export async function lockSpeakerProfile(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${speakerProfileLockKey(userId)}, 0))`;
}
