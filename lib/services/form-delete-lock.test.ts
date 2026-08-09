import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import { lockAndReadFormDeleteUsage, type FormDeleteLockDependencies } from "./form-delete-lock";

const tx = {} as Prisma.TransactionClient;

test("whole-form deletion locks fields then linked task rows before fresh usage reads", async () => {
  const calls: string[] = [];
  const dependencies: FormDeleteLockDependencies = {
    async lockFields(_tx, formConfigId) {
      calls.push(`fields:${formConfigId}`);
    },
    async lockLinkedTasks(_tx, formConfigId) {
      calls.push(`tasks:${formConfigId}`);
      return [];
    },
    async findAbstract(_tx, formConfigId) {
      calls.push(`abstract:${formConfigId}`);
      return null;
    },
  };

  const usage = await lockAndReadFormDeleteUsage(tx, "form-1", dependencies);

  assert.deepEqual(calls, ["fields:form-1", "tasks:form-1", "abstract:form-1"]);
  assert.deepEqual(usage, { hasAbstract: false, hasLinkedTask: false });
});

test("a linked task fails closed, including task assignment and response history", async () => {
  const dependencies: FormDeleteLockDependencies = {
    async lockFields() {},
    async lockLinkedTasks() {
      return [{ id: "task-with-speaker-task" }];
    },
    async findAbstract() {
      return null;
    },
  };

  const usage = await lockAndReadFormDeleteUsage(tx, "form-1", dependencies);

  assert.deepEqual(usage, { hasAbstract: false, hasLinkedTask: true });
});

test("an Abstract reference fails closed independently of linked tasks", async () => {
  const dependencies: FormDeleteLockDependencies = {
    async lockFields() {},
    async lockLinkedTasks() {
      return [];
    },
    async findAbstract() {
      return { id: "abstract-1" };
    },
  };

  const usage = await lockAndReadFormDeleteUsage(tx, "form-1", dependencies);

  assert.deepEqual(usage, { hasAbstract: true, hasLinkedTask: false });
});
