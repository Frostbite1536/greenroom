type V1SpeakerRelation = {
  isPrimary: boolean;
  user: { id: string; name: string; email: string; avatarUrl?: string | null };
};

export function serializeV1Submission(submission: {
  id: string;
  title: string;
  abstract: string | null;
  format: string | null;
  durationMinutes: number | null;
  status: string;
  submittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  formConfig: { id: string; name: string; slug: string };
  category: { id: string; name: string } | null;
  speakers: V1SpeakerRelation[];
  answers: { value: unknown; formField: { key: string } }[];
}) {
  return {
    id: submission.id,
    title: submission.title,
    description: submission.abstract,
    format: submission.format,
    durationMinutes: submission.durationMinutes,
    status: submission.status,
    submittedAt: toIso(submission.submittedAt),
    createdAt: submission.createdAt.toISOString(),
    updatedAt: submission.updatedAt.toISOString(),
    form: submission.formConfig,
    category: submission.category,
    speakers: submission.speakers.map((speaker) => ({
      id: speaker.user.id,
      name: speaker.user.name,
      email: speaker.user.email,
      avatarUrl: speaker.user.avatarUrl ?? null,
      isPrimary: speaker.isPrimary,
    })),
    answers: Object.fromEntries(submission.answers.map((answer) => [answer.formField.key, answer.value])),
  };
}

export function serializeV1Speaker(speaker: {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  speakerProfile: {
    bio: string | null;
    company: string | null;
    jobTitle: string | null;
    headshotUrl: string | null;
    slideDeckUrl: string | null;
    socialLinks: unknown;
  } | null;
  appearances: { submissions: number; sessions: number };
}) {
  return {
    id: speaker.id,
    name: speaker.name,
    email: speaker.email,
    avatarUrl: speaker.avatarUrl,
    profile: speaker.speakerProfile,
    appearances: speaker.appearances,
  };
}

export function serializeV1ScheduleSlot(slot: {
  id: string;
  startsAt: Date;
  endsAt: Date;
  room: { id: string; name: string; capacity: number | null };
  track: { id: string; name: string; color: string } | null;
  session: {
    id: string;
    title: string;
    description: string | null;
    format: string | null;
    durationMinutes: number;
    speakers: V1SpeakerRelation[];
  };
}) {
  return {
    id: slot.id,
    startsAt: slot.startsAt.toISOString(),
    endsAt: slot.endsAt.toISOString(),
    room: slot.room,
    track: slot.track,
    session: {
      id: slot.session.id,
      title: slot.session.title,
      description: slot.session.description,
      format: slot.session.format,
      durationMinutes: slot.session.durationMinutes,
      speakers: slot.session.speakers.map((speaker) => ({
        id: speaker.user.id,
        name: speaker.user.name,
        email: speaker.user.email,
        avatarUrl: speaker.user.avatarUrl ?? null,
        isPrimary: speaker.isPrimary,
      })),
    },
  };
}

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}
