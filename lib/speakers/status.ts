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
export type SpeakerProfileInput = Partial<Record<SpeakerProfileField, string | null>> | null;

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
};

export type SpeakerStatusRow = {
  userId: string;
  name: string;
  email: string;
  company: string | null;
  sessionCount: number;
  scheduledCount: number;
  sessionTitles: string[];
  profilePercent: number;
  profileMissing: string[];
  tasksDone: number;
  tasksTotal: number;
  /** Required tasks still open — the only thing that blocks a speaker. */
  requiredOutstanding: string[];
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

/**
 * Group per-session assignments and per-task rows into one row per speaker.
 *
 * Sorted most-urgent-first: speakers needing attention, then the least complete
 * onboarding, then alphabetically — an operator works the list top-down.
 */
export function buildSpeakerStatusRows(
  assignments: SpeakerAssignment[],
  taskAssignments: SpeakerTaskAssignment[],
): SpeakerStatusRow[] {
  const tasksByUser = new Map<string, SpeakerTaskAssignment[]>();
  for (const task of taskAssignments) {
    const list = tasksByUser.get(task.userId);
    if (list) list.push(task);
    else tasksByUser.set(task.userId, [task]);
  }

  const rows = new Map<string, SpeakerStatusRow>();
  for (const assignment of assignments) {
    let row = rows.get(assignment.userId);
    if (!row) {
      const { percent, missing } = profileCompletion(assignment.profile);
      const tasks = tasksByUser.get(assignment.userId) ?? [];
      const settled = tasks.filter((task) => isTaskSettled(task.status));
      const requiredOutstanding = tasks
        .filter((task) => task.required && !isTaskSettled(task.status))
        .map((task) => task.taskTitle);
      row = {
        userId: assignment.userId,
        name: assignment.name,
        email: assignment.email,
        company: assignment.profile?.company?.trim() || null,
        sessionCount: 0,
        scheduledCount: 0,
        sessionTitles: [],
        profilePercent: percent,
        profileMissing: missing,
        tasksDone: settled.length,
        tasksTotal: tasks.length,
        requiredOutstanding,
        onboardingComplete: requiredOutstanding.length === 0 && missing.length === 0,
        needsAttention: false,
      };
      rows.set(assignment.userId, row);
    }
    row.sessionCount++;
    if (assignment.scheduled) row.scheduledCount++;
    row.sessionTitles.push(assignment.sessionTitle);
  }

  for (const row of rows.values()) {
    row.needsAttention = !row.onboardingComplete || row.scheduledCount < row.sessionCount;
  }

  const completionRatio = (row: SpeakerStatusRow) => (row.tasksTotal === 0 ? 1 : row.tasksDone / row.tasksTotal);
  return [...rows.values()].sort((a, b) =>
    Number(b.needsAttention) - Number(a.needsAttention) ||
    completionRatio(a) - completionRatio(b) ||
    a.profilePercent - b.profilePercent ||
    a.name.localeCompare(b.name),
  );
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
} {
  return {
    speakers: rows.length,
    onboardingComplete: rows.filter((row) => row.onboardingComplete).length,
    requiredOutstanding: rows.reduce((total, row) => total + row.requiredOutstanding.length, 0),
    unscheduledSessions: rows.reduce((total, row) => total + (row.sessionCount - row.scheduledCount), 0),
  };
}
