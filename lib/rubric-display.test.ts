import assert from "node:assert/strict";
import test from "node:test";
import { rubricCriterionLines, type StoredRubricCriterion } from "./rubric-display";

const rubric: StoredRubricCriterion[] = [
  { key: "relevance", label: "Relevance", min: 1, max: 5, weight: 1.5 },
  { key: "originality", label: "Originality", min: 1, max: 5, weight: 1 },
  { key: "clarity", label: "Clarity", min: 1, max: 5, weight: 1 },
];

test("a criterion states its name, its share of the round's weight, and its range", () => {
  const lines = rubricCriterionLines(rubric);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].label, "Relevance");
  // 1.5 / 3.5 = 42.857…% → one decimal, matching the round editor's own line.
  assert.equal(lines[0].meta, "Weight 1.5 · 42.9% of rubric weight · scores 1–5");
  assert.equal(lines[1].meta, "Weight 1 · 28.6% of rubric weight · scores 1–5");
  assert.equal(lines[0].range, "1–5");
  assert.equal(lines[0].key, "relevance");
});

test("the share is a share of the total, never a percentage the weights must add up to", () => {
  // Weights are relative multipliers (D-C5-8 §2.2). `2,1,1` and `50,25,25`
  // score identically, so they must also DISPLAY identically.
  const small = rubricCriterionLines([
    { key: "a", label: "A", min: 1, max: 5, weight: 2 },
    { key: "b", label: "B", min: 1, max: 5, weight: 1 },
    { key: "c", label: "C", min: 1, max: 5, weight: 1 },
  ]);
  const large = rubricCriterionLines([
    { key: "a", label: "A", min: 1, max: 5, weight: 50 },
    { key: "b", label: "B", min: 1, max: 5, weight: 25 },
    { key: "c", label: "C", min: 1, max: 5, weight: 25 },
  ]);
  assert.deepEqual(small.map((l) => l.sharePercent), [50, 25, 25]);
  assert.deepEqual(large.map((l) => l.sharePercent), [50, 25, 25]);
  // The wording never claims the weights themselves total 100.
  assert.equal(small[0].meta, "Weight 2 · 50% of rubric weight · scores 1–5");
  assert.equal(large[0].meta, "Weight 50 · 50% of rubric weight · scores 1–5");
});

test("a single criterion owns the whole rubric", () => {
  const lines = rubricCriterionLines([{ key: "only", label: "Only", min: 0, max: 10, weight: 7 }]);
  assert.equal(lines[0].sharePercent, 100);
  assert.equal(lines[0].meta, "Weight 7 · 100% of rubric weight · scores 0–10");
});

test("a rubric is stored JSON, so an unreadable entry is dropped rather than rendered", () => {
  // The compiler's guarantee stops at the database boundary: `p.rubric` is cast
  // from Prisma.Json. Each of these would otherwise print `undefined` on a card
  // an organizer is meant to trust.
  const damaged = [
    { key: "good", label: "Good", min: 1, max: 5, weight: 1 },
    { key: "", label: "Blank key", min: 1, max: 5, weight: 1 },
    { key: "no_label", label: "   ", min: 1, max: 5, weight: 1 },
    { key: "missing", min: 1, max: 5, weight: 1 },
    null,
  ] as unknown as StoredRubricCriterion[];
  const lines = rubricCriterionLines(damaged);
  assert.deepEqual(lines.map((l) => l.key), ["good"]);
  // The one survivor holds the whole readable weight, so the shares shown still
  // add to 100% rather than silently under-counting against a dropped entry.
  assert.equal(lines[0].sharePercent, 100);
});

test("an unreadable weight or range is omitted, never repaired to a number", () => {
  // Same refusal the round editor makes: `Number(value) || 1` is exactly the
  // silent coercion D-C5-8 §2.4 forbids.
  const lines = rubricCriterionLines([
    { key: "a", label: "A", min: 1, max: 5, weight: 0 },
    { key: "b", label: "B", min: 5, max: 5, weight: 1 },
  ] as unknown as StoredRubricCriterion[]);
  assert.equal(lines[0].sharePercent, null, "a zero weight has no share");
  assert.equal(lines[0].meta, "Weight 0 · scores 1–5");
  assert.equal(lines[1].range, "", "an inverted or empty range prints nothing");
  assert.equal(lines[1].meta, "Weight 1 · 100% of rubric weight");
  assert.equal(/undefined|NaN/.test(JSON.stringify(lines)), false);
});

test("an absent or non-array rubric yields no lines instead of throwing", () => {
  assert.deepEqual(rubricCriterionLines(null), []);
  assert.deepEqual(rubricCriterionLines(undefined), []);
  assert.deepEqual(rubricCriterionLines([]), []);
  assert.deepEqual(rubricCriterionLines("nonsense" as unknown as StoredRubricCriterion[]), []);
});
