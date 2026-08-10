import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("S1 direct event-owned writers lock and authorize stored rows before their write", () => {
  const rooms = source("app/api/admin/settings/rooms/route.ts");
  const roomPatch = rooms.slice(rooms.indexOf("export const PATCH"), rooms.indexOf("export const DELETE"));
  assert.match(roomPatch, /prisma\.\$transaction\(/);
  assert.match(roomPatch, /FROM "Room" WHERE "id" = \$\{input\.id\} FOR UPDATE/);
  assert.match(roomPatch, /requireEventOwnedRow\(existing, ctx\.eventId, "ROOM_NOT_FOUND", "Room"\)/);
  assert.ok(roomPatch.indexOf("FOR UPDATE") < roomPatch.indexOf("tx.room.update"));

  const templates = source("app/api/comms/templates/[templateId]/route.ts");
  assert.match(templates, /prisma\.\$transaction\(/);
  assert.match(templates, /FROM "EmailTemplate" WHERE "id" = \$\{templateId\} FOR UPDATE/);
  assert.match(templates, /requireEventOwnedRow\(existing, auth\.eventId, "TEMPLATE_NOT_FOUND", "Template"\)/);
  assert.ok(templates.indexOf("FOR UPDATE") < templates.indexOf("tx.emailTemplate.update"));
});

test("S15 form deletion locks retained task history and maps the final Restrict race", () => {
  const forms = source("app/api/cfp/forms/route.ts");
  assert.match(forms, /create: \{ eventId: ctx\.eventId, \.\.\.data \}/);
  assert.doesNotMatch(forms, /assertEventScope/);
  assert.match(forms, /lockFormConfigForShapeWrite\(tx, input\.id\)/);

  const formDelete = source("app/api/cfp/forms/[formId]/route.ts");
  assert.match(formDelete, /prisma\.\$transaction\(/);
  assert.match(formDelete, /lockFormConfigForShapeWrite\(tx, formId\)/);
  assert.match(formDelete, /requireEventOwnedRow\(existing, auth\.eventId, "FORM_NOT_FOUND", "Form"\)/);
  assert.match(formDelete, /lockAndReadFormDeleteUsage\(tx, form\.id\)/);
  assert.match(formDelete, /"FORM_HAS_ABSTRACTS"/);
  assert.match(formDelete, /PrismaClientKnownRequestError && error\.code === "P2003"/);
  assert.match(formDelete, /tx\.formConfig\.delete\(\{ where: \{ id: form\.id \} \}\)/);
  assert.ok(formDelete.indexOf("lockFormConfigForShapeWrite") < formDelete.indexOf("lockAndReadFormDeleteUsage"));

  const deleteLock = source("lib/services/form-delete-lock.ts");
  assert.match(deleteLock, /FROM "OnboardingTask"[\s\S]*?WHERE "formConfigId" = \$\{formConfigId\}[\s\S]*?ORDER BY "id"[\s\S]*?FOR UPDATE/);
  const deleteLockOrchestration = deleteLock.slice(deleteLock.indexOf("export async function lockAndReadFormDeleteUsage"));
  assert.ok(deleteLockOrchestration.indexOf("lockFields") < deleteLockOrchestration.indexOf("lockLinkedTasks"));
  assert.ok(deleteLockOrchestration.indexOf("lockLinkedTasks") < deleteLockOrchestration.indexOf("findAbstract"));
});

test("S18 template PATCH preserves an omitted trigger and clears only explicit values", () => {
  const templates = source("app/api/comms/templates/[templateId]/route.ts");
  assert.match(templates, /\.\.\.templateTriggerPatch\(input\.trigger\)/);
  assert.doesNotMatch(templates, /trigger: input\.trigger\?\.trim\(\) \? input\.trigger\.trim\(\) : null/);
});

test("C33 required onboarding templates fan out inside the write's own transaction", () => {
  const tasks = source("app/api/admin/tasks/route.ts");

  const post = tasks.slice(tasks.indexOf("export const POST"), tasks.indexOf("export const PATCH"));
  assert.match(post, /requireContext\(\["ADMIN"\]\)/);
  assert.match(post, /prisma\.\$transaction\(/);
  // The create and the fan-out share one transaction: there must be no window
  // in which a required task exists but no confirmed speaker holds it.
  assert.match(post, /required\s*\?\s*await backfillConfirmedSpeakerTasks\(tx, ctx\.eventId\)/);
  assert.ok(post.indexOf("tx.onboardingTask.create") < post.indexOf("backfillConfirmedSpeakerTasks"));
  assert.ok(post.indexOf("lockEventTaskFanOut") < post.indexOf("lockFormConfigsForTaskWrite"));
  // Event scope is the session's, never the body's.
  assert.match(post, /eventId: ctx\.eventId/);

  const patch = tasks.slice(tasks.indexOf("export const PATCH"), tasks.indexOf("export const DELETE"));
  assert.match(patch, /requireContext\(\["ADMIN"\]\)/);
  assert.match(patch, /requireEventOwnedRow\(locked, ctx\.eventId, "TASK_NOT_FOUND", "Task"\)/);
  // Marking an existing optional template required is the case that would
  // otherwise leave speakers falsely Ready, so the fan-out keys off the
  // resulting state rather than off the request containing `required: true`.
  assert.match(patch, /const required = input\.required \?\? owned\.required/);
  assert.match(patch, /required\s*\?\s*await backfillConfirmedSpeakerTasks\(tx, ctx\.eventId\)/);
  assert.ok(patch.indexOf("lockOnboardingTaskForWrite") < patch.indexOf("tx.onboardingTask.update"));
  assert.ok(patch.indexOf("tx.onboardingTask.update") < patch.indexOf("backfillConfirmedSpeakerTasks"));

  const backfill = source("lib/services/onboarding-task-backfill.ts");
  // Reuse, do not fork: the accept/convert path and the template path must
  // stay one implementation.
  assert.match(backfill, /import \{ assignOnboardingTasks[\s\S]*?\} from "@\/lib\/services\/session-provisioning"/);
  assert.doesNotMatch(backfill, /speakerTask\.createMany/);

  const assign = source("app/api/admin/tasks/assign/route.ts");
  assert.match(assign, /requireContext\(\["ADMIN"\]\)/);
  assert.match(assign, /lockEventTaskFanOut\(tx, ctx\.eventId\)/);
  assert.match(assign, /backfillConfirmedSpeakerTasks\(tx, ctx\.eventId\)/);
});

test("onboarding template deletion locks FormConfig before the task and preserves speaker work", () => {
  const tasks = source("app/api/admin/tasks/route.ts");
  const del = tasks.slice(tasks.indexOf("export const DELETE"));

  assert.match(del, /requireContext\(\["ADMIN"\]\)/);
  assert.match(del, /prisma\.\$transaction\(/);
  assert.match(del, /requireEventOwnedRow\(locked, ctx\.eventId, "TASK_NOT_FOUND", "Task"\)/);
  assert.match(del, /startedTaskAssignmentWhere\(owned\.id\)/);
  assert.match(del, /"TASK_HAS_RESPONSES"|decision\.code/);
  // S15 class order: FormConfig before OnboardingTask. Reversing it deadlocks
  // against whole-form deletion, which holds FormConfig FOR UPDATE first.
  assert.ok(del.indexOf("lockFormConfigsForTaskWrite") < del.indexOf("lockOnboardingTaskForWrite"));
  assert.ok(del.indexOf("lockOnboardingTaskForWrite") < del.indexOf("tx.speakerTask.count"));
  assert.ok(del.indexOf("tx.speakerTask.count") < del.indexOf("tx.onboardingTask.delete"));
  // The refusal must come from the shared decision, not an inline condition.
  assert.match(del, /decideOnboardingTaskDeletion\(started\)/);

  const lock = source("lib/services/onboarding-task-lock.ts");
  assert.match(lock, /FROM "OnboardingTask" WHERE "id" = \$\{taskId\} FOR UPDATE/);
  assert.match(lock, /FROM "FormConfig" WHERE "id" = \$\{id\} FOR SHARE/);
  assert.match(lock, /pg_advisory_xact_lock/);
  // Sorted acquisition inside the FormConfig class keeps two writers touching
  // the same pair from deadlocking against each other.
  assert.match(lock, /\.sort\(\)/);
});

test("C6 withdrawal serializes on Abstract before declining only open review work", () => {
  const submission = source("app/api/cfp/submissions/[abstractId]/route.ts");
  const withdrawal = submission.slice(submission.indexOf('if (patch.status === "WITHDRAWN")'), submission.indexOf("const saved"));

  assert.match(withdrawal, /await lockAbstractForWrite\(tx, existing\.id\)/);
  assert.match(withdrawal, /const freshRefusal = withdrawRefusal\(fresh\.status, Boolean\(fresh\.session\)\)/);
  assert.match(withdrawal, /tx\.abstract\.update\([\s\S]*?data: \{ status: "WITHDRAWN" \}/);
  assert.match(withdrawal, /tx\.reviewAssignment\.updateMany\(\{[\s\S]*?abstractId: existing\.id,[\s\S]*?status: \{ in: \[\.\.\.WITHDRAWAL_OPEN_ASSIGNMENT_STATUSES\] \},[\s\S]*?data: \{ status: "DECLINED" \}/);
  assert.ok(withdrawal.indexOf("lockAbstractForWrite") < withdrawal.indexOf("freshRefusal"));
  assert.ok(withdrawal.indexOf("freshRefusal") < withdrawal.indexOf("tx.abstract.update"));
  assert.ok(withdrawal.indexOf("tx.abstract.update") < withdrawal.indexOf("reviewAssignment.updateMany"));
  assert.doesNotMatch(withdrawal, /reviewScore\.(?:delete|deleteMany|update|updateMany)/);
});
