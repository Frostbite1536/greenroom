import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Source contract for the taxonomy half of the event-settings surface. The
 * component's behaviour on a refusal is a rendering-time property with no pure
 * seam to observe, so the wiring itself is asserted — the same style the repo
 * already uses for component invariants. Regexes stay CRLF-safe: a worktree may
 * check out either line ending, and `[^\n]*$` would make this suite pass or
 * fail depending on which.
 */
const source = readFileSync(new URL("../components/event-settings.tsx", import.meta.url), "utf8");

test("tracks reach every verb of the settings API the rooms section already uses", () => {
  assert.match(source, /apiPost<\{ track: TrackView \}>\("\/api\/admin\/settings\/tracks"[^\r\n]*/);
  assert.match(source, /apiPatch<\{ track: TrackView \}>\("\/api\/admin\/settings\/tracks"[^\r\n]*/);
  assert.match(source, /apiDelete<\{ track: TrackView \}>\([\s\S]{0,120}?\/api\/admin\/settings\/tracks\?trackId=\$\{encodeURIComponent\(track\.id\)\}/);
});

test("a category edit sends PATCH, so renaming cannot clear the review group", () => {
  // POST is whole-row: it rewrites defaultTeamKey from the body every time. The
  // editor must not use it, or a rename silently unroutes the category.
  assert.match(source, /apiPatch<CategoryView>\("\/api\/cfp\/categories"[^\r\n]*/);
  assert.match(source, /apiDelete<CategoryView>\([\s\S]{0,120}?\/api\/cfp\/categories\?categoryId=\$\{encodeURIComponent\(category\.id\)\}/);
  const save = source.slice(source.indexOf("async function saveCategory"), source.indexOf("async function removeCategory"));
  assert.doesNotMatch(save, /apiPost/);
  // The review group is editable and round-trips through the same save, so it
  // is never a field the operator can only lose.
  assert.match(save, /defaultTeamKey: optionalText\(editingCategory\.defaultTeamKey\)/);
  assert.match(save, /description: optionalText\(editingCategory\.description\)/);
  assert.match(source, /value=\{draft\.defaultTeamKey\}/);
});

test("a refused removal keeps the row, because the record is still real event data", () => {
  for (const name of ["removeTrack", "removeCategory"]) {
    const body = source.slice(source.indexOf(`async function ${name}`));
    const guard = body.slice(body.indexOf("if (!res.ok)"), body.indexOf("refresh();"));
    assert.match(guard, /setTrackError\(res\.error\.message\)|setCategoryError\(res\.error\.message\)/, name);
    // Nothing may drop the row locally: the 409 means the server kept it.
    assert.doesNotMatch(guard, /filter\(/, name);
  }
});

test("both removals confirm first and name the condition that allows them", () => {
  assert.match(source, /window\.confirm\([^\r\n]*only available when no sessions are scheduled on the track[^\r\n]*/);
  assert.match(source, /window\.confirm\([^\r\n]*only available when no proposals or sessions use it[^\r\n]*/);
});

test("a stored track colour is normalized before it reaches the colour input", () => {
  // `<input type="color">` shows black for anything that is not `#rrggbb`, and
  // saving from that state would write black over an untouched colour.
  assert.match(source, /normalizeHex\(track\.color, DEFAULT_TRACK_COLOUR\)/);
  assert.match(source, /import \{ normalizeHex \} from "@\/lib\/color-contrast"/);
});

test("every taxonomy mutation refreshes the server truth rather than patching a local list", () => {
  for (const name of ["addTrack", "saveTrack", "removeTrack", "addCategory", "saveCategory", "removeCategory"]) {
    const start = source.indexOf(`async function ${name}`);
    assert.notEqual(start, -1, name);
    const body = source.slice(start, source.indexOf("\n  }", start));
    assert.match(body, /refresh\(\);/, name);
    // The list rendered is always `view.*` from the RSC payload.
    assert.doesNotMatch(body, /setView|useState<.*\[\]>/, name);
  }
  assert.match(source, /\{view\.tracks\.map\(\(track\) => \(/);
  assert.match(source, /\{view\.categories\.map\(\(category\) => \(/);
});

test("row actions are busy-scoped per row, so one edit never disables the whole list", () => {
  assert.match(source, /busy=\{trackBusy === track\.id \|\| trackBusy === `delete:\$\{track\.id\}`\}/);
  assert.match(source, /busy=\{categoryBusy === category\.id \|\| categoryBusy === `delete:\$\{category\.id\}`\}/);
  // The add forms keep the same "new" sentinel the rooms form uses.
  assert.match(source, /trackBusy === "new" \? "Adding…" : "Add track"/);
  assert.match(source, /categoryBusy === "new" \? "Adding…" : "Add category"/);
});
