import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  lockPublicDraftWrite,
  type PublicDraftWriteLockDependencies,
} from "./public-draft-write-lock";

const form = {
  id: "form-a", eventId: "event-a", published: true, opensAt: null, closesAt: null,
  minSpeakers: 1, maxSpeakers: 2, maxBioLength: 500, submissionLimit: null,
};
const fields = [{
  id: "field-a", updatedAt: new Date("2026-08-09T00:00:00Z"), key: "note", label: "Note",
  type: "SHORT_TEXT", required: false, options: null, conditionalLogic: null,
}];

test("existing public drafts lock form, fields, identities, then Abstract", async () => {
  const calls: string[] = [];
  const dependencies: PublicDraftWriteLockDependencies = {
    async lockFormConfig(_tx, id) { calls.push(`form:${id}`); return form; },
    async lockCurrentFields(_tx, id) { calls.push(`fields:${id}`); return fields; },
    async lockIdentities(_tx, emails) { calls.push(`identities:${emails.join(",")}`); },
    async lockAbstract(_tx, id) { calls.push(`abstract:${id}`); },
  };
  await lockPublicDraftWrite(
    {} as Prisma.TransactionClient,
    { formConfigId: "form-a", speakerEmails: ["b@example.test", "a@example.test"], abstractId: "abstract-a" },
    dependencies,
  );
  assert.deepEqual(calls, [
    "form:form-a", "fields:form-a", "identities:b@example.test,a@example.test", "abstract:abstract-a",
  ]);
});

test("new public drafts stop before the Abstract class", async () => {
  const calls: string[] = [];
  const dependencies: PublicDraftWriteLockDependencies = {
    async lockFormConfig(_tx, id) { calls.push(`form:${id}`); return form; },
    async lockCurrentFields(_tx, id) { calls.push(`fields:${id}`); return fields; },
    async lockIdentities() { calls.push("identities"); },
    async lockAbstract() { calls.push("abstract"); },
  };
  await lockPublicDraftWrite(
    {} as Prisma.TransactionClient,
    { formConfigId: "form-a", speakerEmails: ["a@example.test"] },
    dependencies,
  );
  assert.deepEqual(calls, ["form:form-a", "fields:form-a", "identities"]);
});
