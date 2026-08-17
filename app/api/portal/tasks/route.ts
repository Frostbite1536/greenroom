import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveSessionUser } from "@/lib/portal/user";
import { storedFilePath } from "@/lib/uploads/stored-file";
import { lockFormFieldsForAnswerWrite } from "@/lib/services/form-field-lock";
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
 *
 * A deliverable is one column, `artifactUrl`, reachable two ways: `artifactUrl`
 * carries a pasted link exactly as before, and `artifactFileId` names a file the
 * caller already uploaded through `POST /api/files?kind=task-artifact`. The
 * second path never trusts the id — the row must be the caller's own
 * TASK_ARTIFACT stored under this event — and the served path is written by this
 * server, so no client ever names the string that lands in the column.
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

  const { taskId, status, artifactUrl, artifactFileId, notes, responses } = parsed.data;
  const user = await resolveSessionUser(session);
  if (!user) return fail("UNAUTHORIZED", "Sign in to update your tasks.", 401);

  // Scope the task to the caller's current event.
  const task = await prisma.onboardingTask.findFirst({
    where: { id: taskId, eventId: session.event.id },
    select: {
      id: true,
      formConfig: {
        select: {
          id: true,
          maxBioLength: true,
          fields: {
            select: {
              id: true, key: true, label: true, helpText: true, type: true,
              required: true, options: true, conditionalLogic: true, sortOrder: true, updatedAt: true,
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
    select: { taskId: true },
  });
  if (!existing) return fail("NOT_ASSIGNED", "That task is not assigned to you.", 403);

  // Task forms: merge, prune to the live field list, and refuse to mark a
  // form-carrying task complete until its form is actually filled in.
  const fields = (task.formConfig?.fields ?? []) as unknown as TaskFormField[];
  const hasForm = task.formConfig !== null;
  if (responses && !hasForm) {
    return fail("NO_TASK_FORM", "This task does not have a form to fill in.", 422);
  }
  const result = await prisma.$transaction(async (tx) => {
    // Task-form answers live in a JSON column, so they do not acquire an FK
    // lock automatically. Join B5's explicit protocol before re-reading and
    // validating: a concurrent shape edit either finishes first (409) or
    // waits until this answer write commits.
    if (task.formConfig) {
      const formIsCurrent = await lockFormFieldsForAnswerWrite(
        tx,
        new Map([[task.formConfig.id, task.formConfig.fields]]),
      );
      if (!formIsCurrent) {
        return {
          ok: false,
          error: {
            code: "FORM_CHANGED",
            message: "This form changed while your answers were being saved. Review the latest questions and try again.",
            status: 409,
          },
        } as const;
      }
    }

    // Serialize two tabs updating the same assignment so partial response
    // maps merge against the latest committed row instead of losing answers.
    await tx.$queryRaw<Array<{ taskId: string }>>`
      SELECT "taskId"
      FROM "SpeakerTask"
      WHERE "taskId" = ${taskId} AND "userId" = ${user.id}
      FOR UPDATE
    `;
    const fresh = await tx.speakerTask.findUnique({
      where: { taskId_userId: { taskId, userId: user.id } },
      select: { responses: true },
    });
    if (!fresh) {
      return {
        ok: false,
        error: {
          code: "NOT_ASSIGNED",
          message: "That task is no longer assigned to you.",
          status: 403,
        },
      } as const;
    }

    // An uploaded deliverable: the CLIENT sent an id, and the string that
    // reaches the column is built here from a row this server has verified.
    //
    // All four conditions are load-bearing and collapse into one 404, so the
    // route cannot be used to learn that someone else's file id is real:
    //   - the row exists;
    //   - its kind is TASK_ARTIFACT, so a speaker cannot re-point their own
    //     private slide deck or a proposal's supporting document at a task and
    //     thereby publish it to a surface its own feature never showed it on;
    //   - its uploader is the caller, so one speaker cannot attach another's
    //     file — the reason a bare id is never trusted;
    //   - its event is this task's event, which is also the caller's active
    //     event. That is what keeps `canReadStoredFile`'s ADMIN test (made
    //     against the FILE's event) and "the organizers of the event that asked
    //     for this task" the same question forever after.
    //
    // Read inside the transaction, like the proposal attach route: `eventId` is
    // nullable and goes null when an event is deleted, so a check outside the
    // write would be a check-then-write on a fact that can change.
    let uploadedArtifactUrl: string | null = null;
    if (artifactFileId !== undefined) {
      const file = await tx.storedFile.findUnique({
        where: { id: artifactFileId },
        select: { id: true, kind: true, uploaderUserId: true, eventId: true },
      });
      if (
        !file
        || file.kind !== "TASK_ARTIFACT"
        || file.uploaderUserId !== user.id
        || file.eventId !== session.event.id
      ) {
        return {
          ok: false,
          error: {
            code: "ARTIFACT_FILE_NOT_FOUND",
            message: "That uploaded file is not available. Upload it again and retry.",
            status: 404,
          },
        } as const;
      }
      uploadedArtifactUrl = storedFilePath(file.id);
    }

    const mergedResponses = hasForm
      ? pruneToFields(mergeTaskResponses(fresh.responses, responses), fields)
      : null;
    const blocked = completionBlocked({
      hasForm,
      nextStatus: status,
      fields,
      responses: mergedResponses ?? {},
      answerKeysToValidate: Object.keys(responses ?? {}),
      maxBioLength: task.formConfig?.maxBioLength,
    });
    if (blocked) {
      return {
        ok: false,
        error: {
          code: blocked.code,
          message: status === "COMPLETED"
            ? "Finish the form before marking this task done."
            : blocked.message,
          status: 422,
          fieldErrors: blocked.fieldErrors,
        },
      } as const;
    }

    const updated = await tx.speakerTask.update({
      where: { taskId_userId: { taskId, userId: user.id } },
      data: {
        status,
        // One column, filled two ways. The schema refuses both keys at once, so
        // this `??` chain is a fallback, never a precedence rule; omitting both
        // preserves the stored value exactly as it always has.
        artifactUrl: uploadedArtifactUrl ?? artifactUrl ?? undefined,
        notes: notes ?? undefined,
        ...(mergedResponses ? { responses: mergedResponses as never } : {}),
        completedAt: status === "COMPLETED" ? new Date() : null,
      },
      select: { taskId: true, status: true, artifactUrl: true, notes: true, responses: true, completedAt: true },
    });
    return { ok: true, data: updated } as const;
  });

  if (!result.ok) {
    return fail(
      result.error.code,
      result.error.message,
      result.error.status,
      "fieldErrors" in result.error ? result.error.fieldErrors : undefined,
    );
  }

  return NextResponse.json<ApiResponse<typeof result.data>>({ ok: true, data: result.data });
}
