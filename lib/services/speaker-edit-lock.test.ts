import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  lockSpeakerContentWrite,
  type SpeakerContentWriteLockDependencies,
} from "@/lib/services/speaker-edit-lock";

const form = {
  id: "form-a",
  eventId: "event-a",
  published: true,
  opensAt: null,
  closesAt: null,
  minSpeakers: 1,
  maxSpeakers: 2,
  maxBioLength: 500,
  submissionLimit: null,
};

const fields = [{
  id: "field-a",
  updatedAt: new Date("2026-08-09T00:00:00Z"),
  key: "title_note",
  label: "Talk note",
  type: "SHORT_TEXT",
  required: true,
  options: null,
  conditionalLogic: null,
}];

test("speaker content locks take FormConfig, sorted current fields, then Abstract", async () => {
  const calls: string[] = [];
  const dependencies: SpeakerContentWriteLockDependencies = {
    async lockFormConfig(_tx, formConfigId) {
      calls.push(`form:${formConfigId}`);
      return form;
    },
    async lockCurrentFields(_tx, formConfigId) {
      calls.push(`fields:${formConfigId}`);
      return fields;
    },
    async lockAbstract(_tx, abstractId) {
      calls.push(`abstract:${abstractId}`);
    },
  };

  const result = await lockSpeakerContentWrite(
    {} as Prisma.TransactionClient,
    { formConfigId: "form-a", abstractId: "abstract-a" },
    dependencies,
  );
  assert.deepEqual(calls, ["form:form-a", "fields:form-a", "abstract:abstract-a"]);
  assert.deepEqual(result, { form, fields });
});

test("speaker content locks fail before FormFields or Abstract when the form disappeared", async () => {
  const calls: string[] = [];
  const dependencies: SpeakerContentWriteLockDependencies = {
    async lockFormConfig(_tx, formConfigId) {
      calls.push(`form:${formConfigId}`);
      return null;
    },
    async lockCurrentFields() {
      calls.push("fields");
      return fields;
    },
    async lockAbstract() {
      calls.push("abstract");
    },
  };

  const result = await lockSpeakerContentWrite(
    {} as Prisma.TransactionClient,
    { formConfigId: "missing-form", abstractId: "abstract-a" },
    dependencies,
  );
  assert.equal(result, null);
  assert.deepEqual(calls, ["form:missing-form"]);
});
