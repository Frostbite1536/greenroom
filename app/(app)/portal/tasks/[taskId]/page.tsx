import { notFound, redirect } from "next/navigation";
import "@/components/feature.css";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveSessionUser } from "@/lib/portal/user";
import { normalizeStoredResponses, type TaskFormField } from "@/lib/portal/task-form";
import { TaskForm } from "./task-form";

export const metadata = { title: "Your task" };
export const dynamic = "force-dynamic";

/**
 * One onboarding task that carries a form — the hotel-stay and
 * flight-reimbursement examples the director called must-haves.
 *
 * Server-rendered with the speaker's saved answers already in place, so a
 * half-finished form survives a closed tab. Authorization is the same rule the
 * API enforces: the assignment must belong to the caller, in this event
 * (INV-TASK-001, INV-EVENT-001).
 */
export default async function PortalTaskPage({
  params,
}: {
  params: Promise<{ taskId: string }>;
}) {
  const session = await requireSession();
  const user = await resolveSessionUser(session);
  if (!user) redirect("/login");
  const { taskId } = await params;

  const assignment = await prisma.speakerTask.findUnique({
    where: { taskId_userId: { taskId, userId: user.id } },
    select: {
      status: true,
      responses: true,
      notes: true,
      task: {
        select: {
          id: true,
          eventId: true,
          title: true,
          description: true,
          required: true,
          dueAt: true,
          formConfig: {
            select: {
              name: true,
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
      },
    },
  });
  // A task that is not yours, or not in this event, is simply not found.
  if (!assignment || assignment.task.eventId !== session.event.id) notFound();

  const fields = (assignment.task.formConfig?.fields ?? []) as unknown as TaskFormField[];

  return (
    <section className="page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow">Speaker workspace</p>
          <h1>{assignment.task.title}</h1>
          {assignment.task.description ? <p>{assignment.task.description}</p> : null}
        </div>
      </header>
      <TaskForm
        taskId={assignment.task.id}
        title={assignment.task.title}
        formName={assignment.task.formConfig?.name ?? null}
        required={assignment.task.required}
        dueAt={assignment.task.dueAt ? assignment.task.dueAt.toISOString() : null}
        status={assignment.status}
        fields={fields}
        initialResponses={normalizeStoredResponses(assignment.responses)}
      />
    </section>
  );
}
