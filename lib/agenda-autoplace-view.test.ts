import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyRefusalCopy, fillOpenSlotsSummary } from "@/lib/agenda-autoplace-view";

const plan = (considered: number, placed: number, blocked: number) => ({
  consideredSessions: considered,
  placements: Array.from({ length: placed }, (_, i) => i),
  unplaceable: Array.from({ length: blocked }, (_, i) => i),
});

test("an empty backlog says so instead of reporting a failed plan", () => {
  const summary = fillOpenSlotsSummary(plan(0, 0, 0));
  assert.match(summary.title, /already scheduled/);
  assert.match(summary.detail ?? "", /nothing in the unscheduled backlog/i);
  assert.equal(summary.canApply, false);
});

test("a plan that places nothing offers no Apply button", () => {
  const one = fillOpenSlotsSummary(plan(1, 0, 1));
  assert.match(one.title, /No open slot fits the talk/);
  assert.equal(one.canApply, false);

  const several = fillOpenSlotsSummary(plan(3, 0, 3));
  assert.match(several.title, /any of the talks/);
  assert.equal(several.canApply, false);
});

test("a clean plan counts the talks and promises nothing else moves", () => {
  const one = fillOpenSlotsSummary(plan(1, 1, 0));
  assert.equal(one.title, "1 talk will be placed");
  assert.match(one.detail ?? "", /Nothing already on the schedule moves/);
  assert.equal(one.canApply, true);

  assert.equal(fillOpenSlotsSummary(plan(4, 4, 0)).title, "4 talks will be placed");
});

test("a partial plan states both numbers rather than only the good one", () => {
  const mixed = fillOpenSlotsSummary(plan(5, 3, 2));
  assert.equal(mixed.title, "3 talks will be placed, 2 cannot be");
  assert.match(mixed.detail ?? "", /leaves the rest in the backlog/);
  assert.equal(mixed.canApply, true);

  assert.equal(fillOpenSlotsSummary(plan(2, 1, 1)).title, "1 talk will be placed, 1 cannot be");
});

test("no summary ever claims a talk it did not account for", () => {
  for (const [considered, placed, blocked] of [[0, 0, 0], [1, 1, 0], [1, 0, 1], [7, 4, 3]]) {
    const summary = fillOpenSlotsSummary(plan(considered, placed, blocked));
    assert.ok(summary.title.length > 0);
    // Apply is offered exactly when there is something to write.
    assert.equal(summary.canApply, placed > 0);
  }
});

test("a stale refusal keeps the server's wording and adds the reassurance", () => {
  const stale = "The agenda changed after this preview was created. Generate a new preview before applying it.";
  assert.equal(applyRefusalCopy("STALE_PREVIEW", stale), `${stale} Nothing was changed.`);
  assert.equal(applyRefusalCopy("VALIDATION_ERROR", "Request validation failed."), "Request validation failed.");
});

test("the builder previews before it writes and keeps dragging primary", () => {
  const builder = readFileSync(
    new URL("../components/agenda-builder.tsx", import.meta.url),
    "utf8",
  );

  // The action asks for a plan; only a second, explicit press writes.
  assert.match(builder, /apiPost<PlacementPreview>\("\/api\/agenda\/autoplace\/preview"/);
  assert.match(builder, /apiPost\("\/api\/agenda\/autoplace\/apply"/);
  assert.ok(
    builder.indexOf("autoplace/preview") < builder.indexOf("autoplace/apply"),
    "the preview request must be declared before the apply request",
  );
  // The dialog is the only route from a preview to an apply.
  assert.match(builder, /onApply=\{\(\) => applyPlacementPreview\(preview\)\}/);
  assert.match(builder, /onDiscard=\{\(\) => setPreview\(null\)\}/);
  assert.match(builder, /const summary = fillOpenSlotsSummary\(preview\)/);
  // Apply exists only when the shared copy says there is something to write.
  assert.match(builder, /\{summary\.canApply \? \(\s*<button className="primary-button"/);

  // A refused apply drops the plan rather than offering a retry of dead state.
  assert.match(builder, /setPreview\(null\);\s*setPreviewError\(applyRefusalCopy\(res\.error\.code, res\.error\.message\)\)/);

  // Manual drag-and-drop is untouched and still the primary editor.
  assert.match(builder, /onMove=\{view === "day" \? moveSlot : undefined\}/);
  assert.match(builder, /draggable=\{draggable && movingId === null\}/);
  assert.match(builder, /Drag a session to another room or time/);

  // The panel names its own honesty: nothing saved yet, and no publication.
  assert.match(builder, /Fill open slots — nothing saved yet/);
  assert.match(builder, /It does not\s*\n?\s*publish anything/);
  assert.match(builder, /Could not be placed \(\{preview\.unplaceable\.length\}\)/);
});
