import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveSessionUser } from "@/lib/portal/user";
import type { ApiResponse } from "@/types/api";
import {
  completionBlocked,
  mergeTaskResponses,
  pruneToFields,
  taskUpdateWithResponsesSchema,
  type TaskFormField,
} from "@/lib/portal/task-form";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(code: string, message: string, status: number, fieldErrors?: Record<string, string[]>) {
  return NextResponse.json<ApiResponse<never>>({ ok: false, error: { code, message, fieldErrors } }, { status });
}

/**
 * Update one of the signed-in speaker's own onboarding tasks.
 *
 * INV-TASK-001: completion lives on the per-speaker `SpeakerTask` assignment,
 * never on the `OnboardingTask` template. INV-EVENT-001: the task must belong to
 * the session's event, and we only ever touch the caller's own assignment row.
 */
export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) return fail("UNAUTHORIZED", "Sign in to update your tasks.", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_JSON", "Request body must be valid JSON.", 400);
  }

  const parsed = taskUpdateWithResponsesSchema.safeParse(body);
  if (!parsed.success) {
    return fail("VALIDATION_ERROR", "Task update is invalid.", 422, parsed.error.flatten().fieldErrors);
  }

  const { taskId, status, artifactUrl, notes, responses } = parsed.data;
  const user = await resolveSessionUser(session);
  if (!user) return fail("UNAUTHORIZED", "Sign in to update your tasks.", 401);

  // Scope the task to the caller's current event.
  const task = await prisma.onboardingTask.findFirst({
    where: { id: taskId, eventId: session.event.id },
    select: {
      id: true,
      formConfig: {
        select: {
          maxBioLength: true,
          fields: {
            select: {
              id: true, key: true, label: true, helpText: true, type: true,
              required: true, options: true, conditionalLogic: true, sortOrder: true,
            },
            orderBy: { sortOrder: "asc" },
          },
        },
      },
    },
  });
  if (!task) return fail("NOT_FOUND", "That task does not exist for this event.", 404);

  // Only update an assignment that already belongs to this speaker.
  const existing = await prisma.speakerTask.findUnique({
    where: { taskId_userId: { taskId, userId: user.id } },
    select: { taskId: true, responses: true },
  });
  if (!existing) return fail("NOT_ASSIGNED", "That task is not assigned to you.", 403);

  // Task forms: merge, prune to the live field list, and refuse to mark a
  // form-carrying task complete until its form is actually filled in.
  const fields = (task.formConfig?.fields ?? []) as unknown as TaskFormField[];
  const hasForm = task.formConfig !== null;
  if (responses && !hasForm) {
    return fail("NO_TASK_FORM", "This task does not have a form to fill in.", 422);
  }
  const mergedResponses = hasForm
    ? pruneToFields(mergeTaskResponses(existing.responses, responses), fields)
    : null;

  const blocked = completionBlocked({
    hasForm,
    nextStatus: status,
    fields,
    responses: mergedResponses ?? {},
  });
  if (blocked) {
    return fail(
      blocked.code,
      "Finish the form before marking this task done.",
      422,
      blocked.fieldErrors,
    );
  }

  const updated = await prisma.speakerTask.update({
    where: { taskId_userId: { taskId, userId: user.id } },
    data: {
      status,
      artifactUrl: artifactUrl ?? undefined,
      notes: notes ?? undefined,
      ...(mergedResponses ? { responses: mergedResponses as never } : {}),
      completedAt: status === "COMPLETED" ? new Date() : null,
    },
    select: { taskId: true, status: true, artifactUrl: true, notes: true, responses: true, completedAt: true },
  });

  return NextResponse.json<ApiResponse<typeof updated>>({ ok: true, data: updated });
}
