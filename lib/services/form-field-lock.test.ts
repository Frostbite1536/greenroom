import assert from "node:assert/strict";
import test from "node:test";
import { formFieldSnapshotsMatch } from "@/lib/services/form-field-lock";

const at = (iso: string) => new Date(iso);

test("form-field snapshots match independent of row order", () => {
  const expected = [
    { id: "a", updatedAt: at("2026-08-08T12:00:00Z") },
    { id: "b", updatedAt: at("2026-08-08T12:01:00Z") },
  ];
  assert.equal(formFieldSnapshotsMatch(expected, [...expected].reverse()), true);
});

test("form-field snapshots detect deletion, addition, and an in-place edit", () => {
  const expected = [
    { id: "a", updatedAt: at("2026-08-08T12:00:00Z") },
    { id: "b", updatedAt: at("2026-08-08T12:01:00Z") },
  ];
  assert.equal(formFieldSnapshotsMatch(expected, expected.slice(0, 1)), false);
  assert.equal(formFieldSnapshotsMatch(expected, [...expected, { id: "c", updatedAt: at("2026-08-08T12:02:00Z") }]), false);
  assert.equal(formFieldSnapshotsMatch(expected, [expected[0], { ...expected[1], updatedAt: at("2026-08-08T12:03:00Z") }]), false);
});
