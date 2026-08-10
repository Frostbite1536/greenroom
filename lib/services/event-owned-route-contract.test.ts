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

test("ABS-12 score writes re-read the assignment under the locks and refuse a declared conflict", () => {
  const scores = source("app/api/evaluations/scores/route.ts");
  const transaction = scores.slice(scores.indexOf("await prisma.$transaction"));

  // The stale pre-transaction read is not trusted: the fresh read must come
  // from the assignment row itself, after both locks, and carry its abstract.
  assert.match(transaction, /await lockAbstractForWrite\(tx, input\.abstractId\)/);
  assert.match(
    transaction,
    /const fresh = await tx\.reviewAssignment\.findUnique\(\{[\s\S]*?where: \{ id: assignment\.id \},[\s\S]*?select: \{ status: true, abstract: \{ select: \{ status: true \} \} \}/,
  );
  assert.match(transaction, /const freshDeclined = scoreWriteRefusal\(fresh\.status\)/);
  assert.ok(transaction.indexOf("lockAbstractForWrite") < transaction.indexOf("const fresh ="));
  assert.ok(transaction.indexOf("const fresh =") < transaction.indexOf("freshDeclined"));
  // The refusal must precede every write, or a declaration that committed while
  // this request waited would be reversed by the status update below.
  assert.ok(transaction.indexOf("freshDeclined") < transaction.indexOf("tx.reviewScore.upsert"));
  assert.ok(transaction.indexOf("freshDeclined") < transaction.indexOf("tx.reviewAssignment.update"));

  // And an honest fast refusal before the transaction is even opened.
  const preflight = scores.slice(0, scores.indexOf("await prisma.$transaction"));
  assert.match(preflight, /const declined = scoreWriteRefusal\(assignment\.status\)/);
});

test("ABS-12 admin re-assignment restores only a declined row, never a completed review", () => {
  const assignments = source("app/api/evaluations/assignments/route.ts");
  const restore = assignments.slice(assignments.indexOf("await tx.reviewAssignment.upsert"));

  // Status-scoped: the whole point is that COMPLETED rows are excluded, so the
  // decision aggregate never loses a review it already counts.
  assert.match(
    restore,
    /tx\.reviewAssignment\.updateMany\(\{[\s\S]*?status: \{ in: \[\.\.\.RESTORABLE_ASSIGNMENT_STATUSES\] \},[\s\S]*?data: \{ status: "ASSIGNED", completedAt: null \}/,
  );
  // The upsert itself must stay teamKey-only: a plain re-assign of an active
  // row must not rewrite anything else about it.
  assert.match(assignments, /update: \{ teamKey \},/);
  // Restoration never rewrites review history.
  assert.doesNotMatch(restore, /reviewScore\.(?:delete|deleteMany|update|updateMany|upsert)/);
  // It stays inside the transaction that already holds the assignment locks.
  assert.ok(assignments.indexOf("lockReviewAssignmentWrite") < assignments.indexOf("RESTORABLE_ASSIGNMENT_STATUSES", assignments.indexOf("await tx.reviewAssignment.upsert")));
});
