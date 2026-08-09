import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CFP_DRAFT_RECOVERY_VERSION,
  clearDraftRecovery,
  draftRecoveryHash,
  draftRecoveryStorageKey,
  hasDraftRecoveryHash,
  parseDraftRecoveryHash,
  readDraftRecovery,
  shouldApplyRecoveredDraft,
  withoutDraftRecoveryHash,
  writeDraftRecovery,
  type DraftRecoveryStorage,
} from "./cfp-draft-recovery";

const metadata = {
  version: CFP_DRAFT_RECOVERY_VERSION,
  formConfigId: "form-a",
  abstractId: "draft-a",
  capability: "token-without-form-values",
  draftRevision: 2,
} as const;

function memoryStorage(initial: Record<string, string> = {}): DraftRecoveryStorage & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

test("draft recovery storage is versioned, form-scoped, metadata-only, and guarded", () => {
  const storage = memoryStorage();
  assert.equal(draftRecoveryStorageKey("form-a"), "greenroom.cfp.draft.v1:form-a");
  assert.equal(writeDraftRecovery(storage, metadata), true);
  const raw = storage.values.get(draftRecoveryStorageKey("form-a"));
  assert.deepEqual(JSON.parse(raw ?? "{}"), metadata);
  assert.deepEqual(readDraftRecovery(storage, "form-a"), metadata);
  assert.equal(readDraftRecovery(storage, "form-b"), null);

  storage.values.set(draftRecoveryStorageKey("form-a"), "not json");
  assert.equal(readDraftRecovery(storage, "form-a"), null);
  clearDraftRecovery(storage, "form-a");
  assert.equal(storage.values.has(draftRecoveryStorageKey("form-a")), false);
});

test("draft recovery storage tolerates unavailable browser storage", () => {
  const storageError = new Error("blocked");
  const unavailable: DraftRecoveryStorage = {
    getItem: () => { throw storageError; },
    setItem: () => { throw storageError; },
    removeItem: () => { throw storageError; },
  };
  const originalError = console.error;
  const diagnostics: unknown[][] = [];
  console.error = (...args: unknown[]) => { diagnostics.push(args); };
  try {
    assert.equal(readDraftRecovery(unavailable, "form-a"), null);
    assert.equal(writeDraftRecovery(unavailable, metadata), false);
    assert.doesNotThrow(() => clearDraftRecovery(unavailable, "form-a"));
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(diagnostics, [
    ["CFP draft recovery storage read failed", storageError],
    ["CFP draft recovery storage write failed", storageError],
    ["CFP draft recovery storage clear failed", storageError],
  ]);
  assert.ok(diagnostics.every((entry) => entry.length === 2));
});

test("draft recovery links are fragment-only and strict", () => {
  const hash = draftRecoveryHash(metadata);
  assert.equal(hash, "#draft=draft-a&cap=token-without-form-values");
  assert.deepEqual(parseDraftRecoveryHash(hash), { abstractId: "draft-a", capability: "token-without-form-values" });
  assert.equal(parseDraftRecoveryHash("#draft=draft-a"), null);
  assert.equal(parseDraftRecoveryHash("#draft=draft-a&cap=token&other=value"), null);
  assert.equal(hasDraftRecoveryHash("#draft=draft-a"), true);
  assert.equal(hasDraftRecoveryHash("#cap=token&cap=duplicate"), true);
  assert.equal(hasDraftRecoveryHash("#section-about"), false);
  assert.equal(withoutDraftRecoveryHash("/cfp/event/form", "?preview=1"), "/cfp/event/form?preview=1");
});

test("a recovered response only applies when no newer local edit exists", () => {
  assert.equal(shouldApplyRecoveredDraft(4, 4), true);
  assert.equal(shouldApplyRecoveredDraft(4, 5), false);
});
