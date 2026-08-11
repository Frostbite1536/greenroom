/**
 * The one event-scoped read behind every organizer speaker number.
 *
 * `/admin/speakers` and the `/admin` dashboard card must not disagree about how
 * many speakers this event has or how many are fully onboarded. The rules that
 * decide that live in `lib/speakers/status` (pure), but the *inputs* matter
 * just as much: which two tables the roster unions, which bounds each read
 * takes, and which partially-loaded speakers are excluded. Extracting the read
 * itself means the two screens cannot drift apart in any of those.
 *
 * Everything here is event-scoped (INV-EVENT-001) and bounded exactly as the
 * operator API routes are: one extra row is fetched and the caller is told the
 * list was cut, rather than a partial roster being reported as a whole one.
 */
import { prisma } from "@/lib/prisma";
import { OPERATOR_QUERY_LIMITS } from "@/lib/api/query-limits";
import {
  buildSpeakerRosterRows,
  completeUserBoundary,
  summarizeSpeakerStatus,
  type SpeakerAssignment,
  type SpeakerRosterMember,
  type SpeakerStatusRow,
  type SpeakerTaskAssignment,
} from "@/lib/speakers/status";

/** Same bounded-read discipline as the operator API routes (INV-EVENT-001). */
export const SPEAKER_ROSTER_LIMITS = {
  assignments: OPERATOR_QUERY_LIMITS.reminderSessionSpeakers,
  // Named speakers are people, not sessions, so the same per-event speaker cap
  // is the right bound; it is read and truncated exactly like the session list.
  members: OPERATOR_QUERY_LIMITS.reminderSessionSpeakers,
  taskAssignments: OPERATOR_QUERY_LIMITS.reminderSessionSpeakers * 10,
} as const;

const profileSelect = {
  bio: true, company: true, jobTitle: true, headshotUrl: true, status: true,
} as const;

export type SpeakerRosterView = {
  /** Null when the event id names no event; callers redirect rather than guess. */
  timezone: string | null;
  rows: SpeakerStatusRow[];
  /** The confirmed-session cohort: everyone on at least one talk. */
  confirmed: SpeakerStatusRow[];
  /** `summarizeSpeakerStatus(confirmed)` — the five headline organizer metrics. */
  summary: ReturnType<typeof summarizeSpeakerStatus>;
  /** Roster members who are not on a session yet. */
  awaitingSession: number;
  /** True when a bounded read was cut, so the numbers above are floors. */
  truncated: boolean;
};

/**
 * The roster is a union of two independent truths, because neither alone is
 * the event's speaker list. `SessionSpeaker` is the confirmed programme — a
 * Session exists exactly when an abstract was accepted or a talk was
 * guaranteed. `EventMember(role=SPEAKER)` is everyone the organizer has named
 * a speaker, including those still waiting on a session. All reads are
 * event-scoped, bounded, and userId-ordered so truncation stays describable.
 */
export async function readSpeakerRoster(eventId: string): Promise<SpeakerRosterView> {
  const [event, sessionSpeakers, memberSpeakers, speakerTasks] = await Promise.all([
    prisma.event.findUnique({ where: { id: eventId }, select: { timezone: true } }),
    prisma.sessionSpeaker.findMany({
      where: { session: { eventId } },
      select: {
        userId: true,
        user: {
          select: { name: true, email: true, speakerProfile: { select: profileSelect } },
        },
        session: { select: { id: true, title: true, scheduleSlot: { select: { id: true } } } },
      },
      orderBy: [{ userId: "asc" }, { sessionId: "asc" }],
      take: SPEAKER_ROSTER_LIMITS.assignments + 1,
    }),
    prisma.eventMember.findMany({
      where: { eventId, role: "SPEAKER" },
      select: {
        userId: true,
        user: {
          select: { name: true, email: true, speakerProfile: { select: profileSelect } },
        },
      },
      orderBy: { userId: "asc" },
      take: SPEAKER_ROSTER_LIMITS.members + 1,
    }),
    prisma.speakerTask.findMany({
      where: { task: { eventId } },
      select: {
        userId: true,
        status: true,
        task: { select: { id: true, title: true, required: true, sortOrder: true, dueAt: true } },
      },
      orderBy: [{ userId: "asc" }, { task: { sortOrder: "asc" } }],
      take: SPEAKER_ROSTER_LIMITS.taskAssignments + 1,
    }),
  ]);

  const truncated = sessionSpeakers.length > SPEAKER_ROSTER_LIMITS.assignments
    || memberSpeakers.length > SPEAKER_ROSTER_LIMITS.members
    || speakerTasks.length > SPEAKER_ROSTER_LIMITS.taskAssignments;

  // Every read is userId-ordered, so a truncated list is only guaranteed
  // complete for userIds strictly below the last one it contains. Deriving a
  // status from partially loaded rows would show "Ready" for a speaker whose
  // open tasks were cut off — exclude those speakers instead of guessing.
  const sessionSlice = sessionSpeakers.slice(0, SPEAKER_ROSTER_LIMITS.assignments);
  const memberSlice = memberSpeakers.slice(0, SPEAKER_ROSTER_LIMITS.members);
  const taskSlice = speakerTasks.slice(0, SPEAKER_ROSTER_LIMITS.taskAssignments);
  const boundary = completeUserBoundary([
    { truncated: sessionSpeakers.length > SPEAKER_ROSTER_LIMITS.assignments, lastUserId: sessionSlice.at(-1)?.userId ?? null },
    { truncated: memberSpeakers.length > SPEAKER_ROSTER_LIMITS.members, lastUserId: memberSlice.at(-1)?.userId ?? null },
    { truncated: speakerTasks.length > SPEAKER_ROSTER_LIMITS.taskAssignments, lastUserId: taskSlice.at(-1)?.userId ?? null },
  ]);
  const isComplete = (userId: string) => boundary === null || userId < boundary;

  const members: SpeakerRosterMember[] = memberSlice.filter((row) => isComplete(row.userId)).map((row) => ({
    userId: row.userId,
    name: row.user.name,
    email: row.user.email,
    profile: row.user.speakerProfile,
  }));
  const assignments: SpeakerAssignment[] = sessionSlice.filter((row) => isComplete(row.userId)).map((row) => ({
    userId: row.userId,
    name: row.user.name,
    email: row.user.email,
    profile: row.user.speakerProfile,
    sessionId: row.session.id,
    sessionTitle: row.session.title,
    scheduled: row.session.scheduleSlot !== null,
  }));
  const taskAssignments: SpeakerTaskAssignment[] = taskSlice.filter((row) => isComplete(row.userId)).map((row) => ({
    userId: row.userId,
    taskId: row.task.id,
    taskTitle: row.task.title,
    status: row.status,
    required: row.task.required,
    dueAt: row.task.dueAt ? row.task.dueAt.toISOString() : null,
  }));

  const rows = buildSpeakerRosterRows(members, assignments, taskAssignments);
  // The five headline metrics stay the confirmed-session cohort they have always
  // described, and `confirmedSpeakers` is what the onboarding checklist actually
  // fans out to (C33) — widening the roster must not silently restate either
  // number. Speakers not yet on a session are reported separately.
  const confirmed = rows.filter((row) => row.sessionCount > 0);

  return {
    timezone: event?.timezone ?? null,
    rows,
    confirmed,
    summary: summarizeSpeakerStatus(confirmed),
    awaitingSession: rows.length - confirmed.length,
    truncated,
  };
}
