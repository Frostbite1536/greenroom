import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_GRID_END,
  DEFAULT_GRID_START,
  gridBounds,
  hourMarks,
  packLanes,
} from "./agenda-layout";

test("gridBounds keeps the default window when everything fits inside it", () => {
  const bounds = gridBounds([{ startMin: 9 * 60, endMin: 10 * 60 }]);
  assert.deepEqual(bounds, { start: DEFAULT_GRID_START, end: DEFAULT_GRID_END });
});

test("gridBounds expands (never clips) for early and late sessions", () => {
  const bounds = gridBounds([
    { startMin: 7 * 60 + 30, endMin: 8 * 60 },
    { startMin: 20 * 60, endMin: 21 * 60 + 15 },
  ]);
  assert.deepEqual(bounds, { start: 7 * 60, end: 22 * 60 });
});

test("gridBounds handles an empty agenda", () => {
  assert.deepEqual(gridBounds([]), { start: DEFAULT_GRID_START, end: DEFAULT_GRID_END });
});

test("hourMarks covers both ends inclusively", () => {
  assert.deepEqual(hourMarks({ start: 8 * 60, end: 11 * 60 }), [480, 540, 600, 660]);
});

test("packLanes puts non-overlapping sessions in a single lane", () => {
  const { lanes, laneCount } = packLanes([
    { startMin: 540, endMin: 600 },
    { startMin: 600, endMin: 660 },
    { startMin: 700, endMin: 730 },
  ]);
  assert.deepEqual(lanes, [0, 0, 0]);
  assert.equal(laneCount, 1);
});

test("packLanes splits simultaneous sessions into side-by-side lanes", () => {
  const { lanes, laneCount } = packLanes([
    { startMin: 540, endMin: 600 },
    { startMin: 540, endMin: 630 },
    { startMin: 570, endMin: 600 },
  ]);
  assert.deepEqual(lanes, [0, 1, 2]);
  assert.equal(laneCount, 3);
});

test("packLanes reuses a lane once its previous session has ended", () => {
  const { lanes, laneCount } = packLanes([
    { startMin: 540, endMin: 600 },
    { startMin: 550, endMin: 610 },
    { startMin: 600, endMin: 660 },
  ]);
  assert.deepEqual(lanes, [0, 1, 0]);
  assert.equal(laneCount, 2);
});

test("packLanes is stable for an empty day", () => {
  const { lanes, laneCount } = packLanes([]);
  assert.deepEqual(lanes, []);
  assert.equal(laneCount, 1);
});
