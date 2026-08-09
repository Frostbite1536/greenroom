import type { Prisma } from "@prisma/client";

/** Sorted identity keys are acquired only after FormConfig and FormFields. */
export function publicSubmissionIdentityLockKeys(emails: readonly string[]): string[] {
  return [...new Set(emails.map((email) => email.trim().toLowerCase()))]
    .sort()
    .map((email) => `public-submission-identity:${email}`);
}

export async function lockPublicSubmissionIdentities(
  tx: Prisma.TransactionClient,
  emails: readonly string[],
): Promise<void> {
  for (const key of publicSubmissionIdentityLockKeys(emails)) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
}
