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

/** The portal's rules, narrowed to the organizer's fields. Not a copy of them. */
export const adminSpeakerProfileFields = speakerProfileUpdateSchema.pick({
  bio: true,
  company: true,
  jobTitle: true,
  headshotUrl: true,
  slideDeckUrl: true,
});

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
    (patch) => ADMIN_SPEAKER_PROFILE_FIELDS.some((field) => patch[field] !== undefined),
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
  patch: Partial<Record<AdminSpeakerProfileField, string | null | undefined>>,
): Record<string, string | null> {
  const data: Record<string, string | null> = {};
  for (const field of ADMIN_SPEAKER_PROFILE_FIELDS) {
    const value = patch[field];
    if (value !== undefined) data[field] = value;
  }
  return data;
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
