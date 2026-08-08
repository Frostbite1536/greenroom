export type EventMemberUpserter = {
  eventMember: {
    upsert(input: {
      where: { eventId_userId: { eventId: string; userId: string } };
      update: Record<string, never>;
      create: { eventId: string; userId: string; role: "SPEAKER" };
    }): Promise<unknown>;
  };
};

/**
 * Public CFP data is a server-validated enrollment boundary. Create a speaker
 * membership only when absent; the deliberately empty update never downgrades
 * an existing ADMIN or EVALUATOR role.
 */
export async function ensureSpeakerMemberships(
  client: EventMemberUpserter,
  eventId: string,
  userIds: readonly string[],
): Promise<void> {
  for (const userId of new Set(userIds)) {
    await client.eventMember.upsert({
      where: { eventId_userId: { eventId, userId } },
      update: {},
      create: { eventId, userId, role: "SPEAKER" },
    });
  }
}
