/**
 * Speaker onboarding status: the admin-side mirror of `/portal`.
 *
 * Pure projection so the page stays a thin server component and the rules that
 * decide "this speaker needs chasing" are unit-tested without a database.
 */
export const SPEAKER_PROFILE_FIELDS = [
  { key: "bio", label: "Bio" },
  { key: "company", label: "Company" },
  { key: "jobTitle", label: "Job title" },
  { key: "headshotUrl", label: "Headshot" },
] as const;

export type SpeakerProfileField = (typeof SPEAKER_PROFILE_FIELDS)[number]["key"];

/** Where a speaker is in accepting their invitation (SPK-04). */
export type SpeakerConfirmation = "INVITED" | "CONFIRMED" | "DECLINED";

/**
 * `status` is carried alongside the four prose fields but is deliberately not
 * one of them: it always has a stored value, so counting it toward profile
 * completeness would make every profile look 20% fuller than it is.
 */
export type SpeakerProfileInput =
  | (Partial<Record<SpeakerProfileField, string | null>> & { status?: SpeakerConfirmation })
  | null;

export const SPEAKER_CONFIRMATION_LABELS: Record<SpeakerConfirmation, string> = {
  INVITED: "Invited",
  CONFIRMED: "Confirmed",
  DECLINED: "Declined",
};

/**
 * A speaker with no stored profile row has never been through any invitation
 * flow, and the column's default says every existing speaker is confirmed —
 * so an absent row reads as CONFIRMED rather than inventing a pending invite.
 */
export function speakerConfirmation(profile: SpeakerProfileInput): SpeakerConfirmation {
  return profile?.status ?? "CONFIRMED";
}

export type SpeakerTaskStatus = "TODO" | "IN_PROGRESS" | "COMPLETED" | "WAIVED";

/** A speaker's row on one session of this event. */
export type SpeakerAssignment = {
  userId: string;
  name: string;
  email: string;
  profile: SpeakerProfileInput;
  sessionId: string;
  sessionTitle: string;
  scheduled: boolean;
};

export type SpeakerTaskAssignment = {
  userId: string;
  taskId: string;
  taskTitle: string;
  status: SpeakerTaskStatus;
  required: boolean;
  /**
   * The template's deadline as a stored instant, or null when it has none.
   * Optional so a caller that does not care about deadlines still type-checks;
   * a missing deadline is never treated as an overdue one.
   */
  dueAt?: string | null;
};

/**
 * A speaker the event knows about independently of the programme: an
 * `EventMember(role=SPEAKER)` who may not be on a session yet. Structurally a
 * subset of `SpeakerAssignment`, so one row constructor serves both.
 */
export type SpeakerRosterMember = {
  userId: string;
  name: string;
  email: string;
  profile: SpeakerProfileInput;
};

export type SpeakerStatusRow = {
  userId: string;
  name: string;
  email: string;
  company: string | null;
  /** Stored profile prose, surfaced verbatim. Null when nothing is stored. */
  jobTitle: string | null;
  bio: string | null;
  headshotUrl: string | null;
  /** Where this speaker is in accepting their invitation. */
  status: SpeakerConfirmation;
  sessionCount: number;
  scheduledCount: number;
  sessionTitles: string[];
  profilePercent: number;
  profileMissing: string[];
  tasksDone: number;
  tasksTotal: number;
  /** Required tasks still open — the only thing that blocks a speaker. */
  requiredOutstanding: string[];
  /**
   * Earliest deadline among the required tasks still open, as a stored instant.
   * Null when nothing is outstanding or nothing outstanding carries a date —
   * the operator column renders those two cases the same way, as no deadline
   * to chase, which is honest in both.
   */
  nextRequiredDueAt: string | null;
  /** How many of those open required tasks are already past their deadline. */
  overdueRequired: number;
  onboardingComplete: boolean;
  needsAttention: boolean;
};

export type SpeakerStatusFilter = "all" | "incomplete-onboarding" | "incomplete-profile" | "unscheduled";

export const SPEAKER_STATUS_FILTERS: { value: SpeakerStatusFilter; label: string }[] = [
  { value: "all", label: "All speakers" },
  { value: "incomplete-onboarding", label: "Incomplete onboarding" },
  { value: "incomplete-profile", label: "Incomplete profile" },
  { value: "unscheduled", label: "Unscheduled sessions" },
];

export function parseSpeakerStatusFilter(value: string | undefined): SpeakerStatusFilter {
  return SPEAKER_STATUS_FILTERS.some((filter) => filter.value === value) ? (value as SpeakerStatusFilter) : "all";
}

/** A task counts as done when it is finished or explicitly waived by an admin. */
export function isTaskSettled(status: SpeakerTaskStatus): boolean {
  return status === "COMPLETED" || status === "WAIVED";
}

/**
 * Completeness over the four fields the public program actually renders, so the
 * percentage here matches what a speaker sees on `/portal`.
 */
export function profileCompletion(profile: SpeakerProfileInput): { percent: number; missing: string[] } {
  const missing = SPEAKER_PROFILE_FIELDS.filter(({ key }) => (profile?.[key] ?? "").trim().length === 0);
  const filled = SPEAKER_PROFILE_FIELDS.length - missing.length;
  return {
    percent: Math.round((filled / SPEAKER_PROFILE_FIELDS.length) * 100),
    missing: missing.map(({ label }) => label),
  };
}

/** Trim a stored profile string down to a value or an honest absence. */
function storedText(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

/**
 * One speaker's row before any session is folded into it. Shared by the
 * membership seed and the assignment fold so a member-only speaker and a
 * session speaker are described by exactly the same rules.
 */
function newSpeakerRow(
  member: SpeakerRosterMember,
  tasksByUser: ReadonlyMap<string, SpeakerTaskAssignment[]>,
  now: Date,
): SpeakerStatusRow {
  const { percent, missing } = profileCompletion(member.profile);
  const tasks = tasksByUser.get(member.userId) ?? [];
  const settled = tasks.filter((task) => isTaskSettled(task.status));
  const requiredOpen = tasks.filter((task) => task.required && !isTaskSettled(task.status));
  const requiredOutstanding = requiredOpen.map((task) => task.taskTitle);
  const openDeadlines = requiredOpen
    .map((task) => task.dueAt)
    .filter((dueAt): dueAt is string => typeof dueAt === "string" && dueAt !== "")
    .filter((dueAt) => !Number.isNaN(new Date(dueAt).getTime()))
    .sort();
  return {
    userId: member.userId,
    name: member.name,
    email: member.email,
    company: storedText(member.profile?.company),
    jobTitle: storedText(member.profile?.jobTitle),
    bio: storedText(member.profile?.bio),
    headshotUrl: storedText(member.profile?.headshotUrl),
    status: speakerConfirmation(member.profile),
    sessionCount: 0,
    scheduledCount: 0,
    sessionTitles: [],
    profilePercent: percent,
    profileMissing: missing,
    tasksDone: settled.length,
    tasksTotal: tasks.length,
    requiredOutstanding,
    nextRequiredDueAt: openDeadlines[0] ?? null,
    overdueRequired: openDeadlines.filter((dueAt) => new Date(dueAt).getTime() < now.getTime()).length,
    onboardingComplete: requiredOutstanding.length === 0 && missing.length === 0,
    needsAttention: false,
  };
}

/**
 * The full event roster: everyone the event has named a speaker, unioned with
 * everyone actually on one of its sessions, deduplicated by user id.
 *
 * A speaker exists for this event the moment an organizer adds them, which is
 * before any abstract is accepted — listing only session speakers hid exactly
 * the people an operator still has to chase (SPK-01). A member with no session
 * yet keeps `sessionCount: 0`, which is not the same thing as an unscheduled
 * session and is never counted as one.
 *
 * Sorted most-urgent-first: speakers needing attention, then the least complete
 * onboarding, then alphabetically — an operator works the list top-down.
 *
 * `now` is injected rather than read from the clock so the overdue count is a
 * pure function of its inputs and stays testable.
 */
export function buildSpeakerRosterRows(
  members: readonly SpeakerRosterMember[],
  assignments: readonly SpeakerAssignment[],
  taskAssignments: readonly SpeakerTaskAssignment[],
  now: Date = new Date(),
): SpeakerStatusRow[] {
  const tasksByUser = new Map<string, SpeakerTaskAssignment[]>();
  for (const task of taskAssignments) {
    const list = tasksByUser.get(task.userId);
    if (list) list.push(task);
    else tasksByUser.set(task.userId, [task]);
  }

  const rows = new Map<string, SpeakerStatusRow>();
  // Membership seeds the roster first so a speaker with no session still has a
  // row; the assignment fold below then finds it rather than creating a second.
  for (const member of members) {
    if (!rows.has(member.userId)) rows.set(member.userId, newSpeakerRow(member, tasksByUser, now));
  }
  for (const assignment of assignments) {
    let row = rows.get(assignment.userId);
    if (!row) {
      row = newSpeakerRow(assignment, tasksByUser, now);
      rows.set(assignment.userId, row);
    }
    row.sessionCount++;
    if (assignment.scheduled) row.scheduledCount++;
    row.sessionTitles.push(assignment.sessionTitle);
  }

  for (const row of rows.values()) {
    // A speaker who has not said yes — or has said no — is the most urgent
    // conversation on this list, ahead of any half-finished checklist.
    row.needsAttention = !row.onboardingComplete
      || row.scheduledCount < row.sessionCount
      || row.status !== "CONFIRMED";
  }

  const completionRatio = (row: SpeakerStatusRow) => (row.tasksTotal === 0 ? 1 : row.tasksDone / row.tasksTotal);
  return [...rows.values()].sort((a, b) =>
    Number(b.needsAttention) - Number(a.needsAttention) ||
    completionRatio(a) - completionRatio(b) ||
    a.profilePercent - b.profilePercent ||
    a.name.localeCompare(b.name),
  );
}

/**
 * The confirmed-session cohort only — the original onboarding view. Kept as the
 * roster builder with an empty membership seed so the two can never disagree
 * about how a row is derived.
 */
export function buildSpeakerStatusRows(
  assignments: SpeakerAssignment[],
  taskAssignments: SpeakerTaskAssignment[],
  now: Date = new Date(),
): SpeakerStatusRow[] {
  return buildSpeakerRosterRows([], assignments, taskAssignments, now);
}

export function filterSpeakerStatusRows(rows: SpeakerStatusRow[], filter: SpeakerStatusFilter): SpeakerStatusRow[] {
  switch (filter) {
    case "incomplete-onboarding":
      return rows.filter((row) => row.requiredOutstanding.length > 0);
    case "incomplete-profile":
      return rows.filter((row) => row.profileMissing.length > 0);
    case "unscheduled":
      return rows.filter((row) => row.scheduledCount < row.sessionCount);
    default:
      return rows;
  }
}

export function summarizeSpeakerStatus(rows: SpeakerStatusRow[]): {
  speakers: number;
  onboardingComplete: number;
  requiredOutstanding: number;
  unscheduledSessions: number;
  /** Speakers with at least one required task past its deadline. */
  speakersOverdue: number;
} {
  return {
    speakers: rows.length,
    onboardingComplete: rows.filter((row) => row.onboardingComplete).length,
    requiredOutstanding: rows.reduce((total, row) => total + row.requiredOutstanding.length, 0),
    unscheduledSessions: rows.reduce((total, row) => total + (row.sessionCount - row.scheduledCount), 0),
    // Counted per speaker, not per task: this is a chase list, and one speaker
    // sitting on three late tasks is one conversation, not three.
    speakersOverdue: rows.filter((row) => row.overdueRequired > 0).length,
  };
}

/**
 * Upper bound (exclusive) on userIds whose rows are guaranteed complete after
 * bounded, userId-ordered reads. A truncated list may have lost rows for its
 * last included user and for every user sorting after it, so statuses derived
 * from a mix of truncated lists are only sound strictly below the smallest
 * such boundary. `null` means every loaded user is complete.
 */
export function completeUserBoundary(
  lists: { truncated: boolean; lastUserId: string | null }[],
): string | null {
  let boundary: string | null = null;
  for (const list of lists) {
    if (!list.truncated || list.lastUserId === null) continue;
    if (boundary === null || list.lastUserId < boundary) boundary = list.lastUserId;
  }
  return boundary;
}
