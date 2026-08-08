/**
 * Client-side conflict detection for agenda display.
 *
 * Mirrors the rules in the backend's `lib/services/schedule.ts` so the builder
 * can highlight collisions immediately. The server remains authoritative:
 * `POST /api/agenda/slots` re-checks in the same transaction and refuses the
 * write (INV-SCHEDULE-001). This is presentation only.
 */
import type { AgendaSession } from "@/lib/data/reads";

export type PlacedSession = AgendaSession & {
  slot: NonNullable<AgendaSession["slot"]>;
};

export type DisplayConflict = {
  type: "ROOM_OVERLAP" | "SPEAKER_OVERLAP";
  sessionId: string;
  otherSessionId: string;
  message: string;
};

export function placedSessions(sessions: AgendaSession[]): PlacedSession[] {
  return sessions.filter((s): s is PlacedSession => s.slot !== null);
}

export function findConflicts(
  sessions: AgendaSession[],
  roomName: (id: string) => string,
): DisplayConflict[] {
  const placed = placedSessions(sessions);
  const conflicts: DisplayConflict[] = [];

  const overlaps = (a: PlacedSession, b: PlacedSession) =>
    new Date(a.slot.startsAt) < new Date(b.slot.endsAt) &&
    new Date(b.slot.startsAt) < new Date(a.slot.endsAt);

  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      if (!overlaps(a, b)) continue;

      if (a.slot.roomId === b.slot.roomId) {
        conflicts.push({
          type: "ROOM_OVERLAP",
          sessionId: a.id,
          otherSessionId: b.id,
          message: `${roomName(a.slot.roomId)} is double-booked`,
        });
      }

      const shared = a.speakers.filter((sp) => b.speakers.some((o) => o.userId === sp.userId));
      for (const sp of shared) {
        conflicts.push({
          type: "SPEAKER_OVERLAP",
          sessionId: a.id,
          otherSessionId: b.id,
          message: `${sp.name} is scheduled in two places at once`,
        });
      }
    }
  }
  return conflicts;
}

export function conflictedSessionIds(conflicts: DisplayConflict[]): Set<string> {
  return new Set(conflicts.flatMap((c) => [c.sessionId, c.otherSessionId]));
}
