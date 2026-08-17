import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Source contract for the task-deliverable write path and its two renderers.
 *
 * These properties are about PROVENANCE and ORDER — the stored path being built
 * by the server rather than accepted from the client, the ownership check
 * happening inside the transaction, an href being gated before it is rendered —
 * and none of them is visible to a unit test of any single function. The repo
 * already asserts route properties this way (`lib/uploads/file-route-contract.test.ts`).
 *
 * Every read is normalized to LF, so a CRLF checkout cannot smuggle a `\r` into
 * an anchored or multi-line match. Patterns still use `[\s\S]` rather than `.`
 * with a dotall flag for the same reason: the normalization is the belt, the
 * pattern is the braces.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relative: string) =>
  readFileSync(path.join(repoRoot, relative), "utf8").replace(/\r\n/g, "\n");

const route = read("app/api/portal/tasks/route.ts");
const policy = read("lib/portal/task-artifact.ts");
const schema = read("lib/portal/task-form.ts");
const taskForm = read("app/(app)/portal/tasks/[taskId]/task-form.tsx");
const taskPage = read("app/(app)/portal/tasks/[taskId]/page.tsx");
const checklist = read("app/(app)/portal/task-checklist.tsx");
const adminRoster = read("app/(app)/admin/speakers/page.tsx");
const rosterRead = read("lib/speakers/roster-read.ts");

test("the served path is built by the server and is never a string the client sent", () => {
  // The only value that can reach `artifactUrl` from the id path is this call's.
  assert.match(route, /uploadedArtifactUrl = storedFilePath\(file\.id\)/);
  assert.match(route, /artifactUrl: uploadedArtifactUrl \?\? artifactUrl \?\? undefined,/);
  // No hand-built path anywhere in the route: the prefix lives in one module.
  assert.doesNotMatch(route, /"\/api\/files\//);
  assert.doesNotMatch(route, /`\/api\/files\//);
  // And the id is used for a primary-key lookup only.
  assert.match(route, /where: \{ id: artifactFileId \}/);
});

test("a file id is refused unless it is the caller's own TASK_ARTIFACT for this event", () => {
  // All four conditions, each load-bearing: a missing row, another feature's
  // kind, another person's upload, and another event's file.
  for (const condition of [
    /!file/,
    /file\.kind !== "TASK_ARTIFACT"/,
    /file\.uploaderUserId !== user\.id/,
    /file\.eventId !== session\.event\.id/,
  ]) {
    assert.match(route, condition, `the ownership check must include ${condition}`);
  }
  // They are one refusal, so the route cannot be used to learn which of the four
  // failed — i.e. cannot confirm that a stranger's file id is real.
  assert.equal(route.split("ARTIFACT_FILE_NOT_FOUND").length - 1, 1);
  assert.match(route, /code: "ARTIFACT_FILE_NOT_FOUND",[\s\S]{0,200}?status: 404,/);
});

test("the stored-file lookup happens inside the transaction, before the write", () => {
  const txStart = route.indexOf("prisma.$transaction(async (tx) => {");
  const lookup = route.indexOf("tx.storedFile.findUnique(");
  const update = route.indexOf("tx.speakerTask.update(");
  assert.ok(txStart > 0 && lookup > 0 && update > 0);
  // `eventId` is nullable and goes null on event delete, so a check outside the
  // transaction would be a check-then-write on a fact that can change.
  assert.ok(lookup > txStart, "the lookup must be inside the transaction");
  assert.ok(lookup < update, "the lookup must precede the write it authorizes");
  // The transactional client, never the ambient one, for this read.
  assert.doesNotMatch(route, /prisma\.storedFile\./);
});

test("both artifact keys at once is a refusal in the schema, not a precedence rule in the route", () => {
  assert.match(schema, /body\.artifactUrl === undefined \|\| body\.artifactFileId === undefined/);
  // The route therefore needs no tie-break of its own beyond the `??` fallback.
  assert.doesNotMatch(route, /artifactFileId \?\? artifactUrl|artifactUrl \?\? artifactFileId/);
});

test("the deliverable uploader fills the field beside it, exactly as the profile form's does", () => {
  // Either/or, never both: the uploader reports a URL upward and the parent's one
  // field still holds and still submits the value.
  assert.match(taskForm, /kind="TASK_ARTIFACT"/);
  assert.match(taskForm, /onUploaded=\{\(url\) => setArtifact\(url\)\}/);
  assert.match(taskForm, /value=\{artifact\}/);
  assert.match(taskForm, /onChange=\{\(e\) => setArtifact\(e\.target\.value\)\}/);
  // Exactly one uploader on this form: a second would write the same field twice.
  assert.equal(taskForm.split('kind="TASK_ARTIFACT"').length - 1, 1);
  // Which key travels is the shared pure decision, not restated on the client.
  assert.match(taskForm, /\.\.\.taskArtifactSubmission\(artifact\)/);
  assert.doesNotMatch(taskForm, /artifactFileId:/);
});

test("the artifact control is reachable for a task with no form, and the page loads its value", () => {
  // `artifactUrl` exists on every assignment, so the no-form branch must offer
  // the same control rather than being a dead end.
  assert.equal(taskForm.split("{artifactBlock}").length - 1, 2, "both branches render it");
  // Responses are omitted for a formless task, which the route refuses outright.
  assert.match(taskForm, /fields\.length === 0\n\s*\? \{\}/);
  // The stored value is server-rendered in, so a saved deliverable survives a
  // closed tab exactly as saved answers do.
  assert.match(taskPage, /artifactUrl: true,/);
  assert.match(taskPage, /initialArtifactUrl=\{assignment\.artifactUrl\}/);
  // And the checklist links to the page for every task, not only form-carrying
  // ones — otherwise the control above has no route to it.
  assert.doesNotMatch(checklist, /task\.hasForm \? \(\s*<a/);
  assert.match(checklist, /href=\{`\/portal\/tasks\/\$\{task\.taskId\}`\}/);
});

test("neither renderer builds an href from a stored value without gating it first", () => {
  // `artifactUrl` is validated `z.string().url()`, which accepts non-HTTP
  // schemes (GRA2-07), and these are its first renderers.
  assert.match(policy, /isStoredFilePath\(trimmed\)\) return trimmed/);
  assert.match(policy, /return isHttpUrl\(trimmed\) \? trimmed : null/);

  // The portal renders the gated value, never the raw field.
  assert.match(taskForm, /const artifactHref = taskArtifactHref\(artifact\)/);
  assert.match(taskForm, /href=\{artifactHref\}/);
  assert.doesNotMatch(taskForm, /href=\{artifact\}/);

  // The organizer's roster renders the gated value the read computed, and shows
  // an ungated one as text rather than dropping it.
  assert.match(adminRoster, /artifact\.href \? \(/);
  assert.match(adminRoster, /href=\{artifact\.href\}/);
  assert.doesNotMatch(adminRoster, /href=\{artifact\.url\}/);
  assert.match(adminRoster, /<span className="muted">\{artifact\.url\}<\/span>/);
});

test("the organizer's deliverables come from the same bounded, filtered slice as the rows", () => {
  // A speaker excluded for being partially loaded must not come back with a
  // deliverable attached to a row that is not rendered.
  assert.match(rosterRead, /for \(const row of taskSlice\) \{\n\s*if \(!isComplete\(row\.userId\)\) continue;/);
  // Read with the assignment it belongs to — no extra unbounded round trip.
  assert.doesNotMatch(rosterRead, /speakerTask\.findMany[\s\S]{0,400}?artifactUrl[\s\S]{0,400}?speakerTask\.findMany/);
  assert.match(rosterRead, /href: taskArtifactHref\(url\)/);
  // Beside the rows, like `decks` — not a new field on the shared projection
  // that the dashboard card, CSV export and report metrics also read.
  assert.match(rosterRead, /artifacts: Record<string, SpeakerTaskArtifact\[\]>/);
  assert.doesNotMatch(rosterRead, /taskAssignments[\s\S]{0,200}?artifactUrl/);
});
