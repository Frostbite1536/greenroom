import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const listRoute = read("app/api/v1/submissions/route.ts");
const itemRoute = read("app/api/v1/submissions/[submissionId]/route.ts");

test("the status filter narrows the existing submissions predicate and keeps its browse order", () => {
  assert.match(listRoute, /parseV1SubmissionQuery/);
  assert.match(listRoute, /eventId: event\.id, \.\.\.\(submissionQuery\.value \? \{ status: submissionQuery\.value \} : \{\}\)/);
  assert.match(listRoute, /orderBy: \[\{ createdAt: "asc" \}, \{ id: "asc" \}\]/);
  assert.doesNotMatch(listRoute, /updatedSince|nextCursor|cursor/);
});

test("the item read authenticates, scopes its event, and reuses the list projection and serializer", () => {
  assert.match(itemRoute, /authorizeV1Request\(req\.headers\)/);
  assert.match(itemRoute, /parseV1EventQuery/);
  assert.match(itemRoute, /parseV1SubmissionId/);
  assert.match(itemRoute, /where: v1EventWhere\(authorization\.scope, query\.value\.event\)/);
  assert.match(itemRoute, /where: \{ id: parsedId\.value, eventId: scoped\.event\.id \}/);
  assert.match(itemRoute, /select: v1SubmissionSelect/);
  assert.match(itemRoute, /serializeV1Submission\(submission\)/);
  assert.match(itemRoute, /code: "SUBMISSION_NOT_FOUND"/);
  assert.doesNotMatch(itemRoute, /review|evaluation|score|comment/i);
});
