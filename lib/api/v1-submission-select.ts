import type { Prisma } from "@prisma/client";

/** The one v1 proposal projection, shared by list and item reads. */
export const v1SubmissionSelect = {
  id: true,
  title: true,
  abstract: true,
  format: true,
  durationMinutes: true,
  status: true,
  submittedAt: true,
  createdAt: true,
  updatedAt: true,
  formConfig: { select: { id: true, name: true, slug: true } },
  category: { select: { id: true, name: true } },
  speakers: {
    select: { isPrimary: true, user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
    orderBy: [{ isPrimary: "desc" }, { userId: "asc" }],
  },
  answers: {
    select: { value: true, formField: { select: { key: true } } },
    orderBy: { id: "asc" },
  },
} satisfies Prisma.AbstractSelect;
