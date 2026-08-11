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
  // The review group is editable, so it is never a field the operator can only
  // lose.
  assert.match(source, /value=\{draft\.defaultTeamKey\}/);
});

test("a row editor sends only the planned diff, never a rebuilt whole row", () => {
  // The stale-overwrite regression: naming the fields inline resends the
  // editor's snapshot of every one of them, so an untouched field silently
  // overwrites whatever a colleague changed while this editor sat open. The
  // body must be the planner's sparse output spread onto the id, nothing else.
  for (const [name, next, plan] of [
    // Rooms is the same defect class as the two taxonomies, so it is held to
    // the same contract here rather than left as the one editor that resends
    // a whole row.
    ["saveRoom", "removeRoom", "planRoomPatch\\(\\{ name: editingRoom\\.name, capacity: capacity \\?\\? null \\}, editingRoom\\.loaded\\)"],
    ["saveTrack", "removeTrack", "planTrackPatch\\(editingTrack, editingTrack\\.loaded\\)"],
    ["saveCategory", "removeCategory", "planCategoryPatch\\(editingCategory, editingCategory\\.loaded\\)"],
  ] as const) {
    const save = source.slice(source.indexOf(`async function ${name}`), source.indexOf(`async function ${next}`));
    assert.match(save, new RegExp(`const patch = ${plan}`), name);
    assert.match(save, /\.\.\.patch,/, name);
    // A no-op edit must not reach the API at all.
    assert.match(save, /if \(!patch\) \{/, name);
    // No field may be named in the outbound body beside the id.
    const bodyStart = save.indexOf("apiPatch");
    const body = save.slice(bodyStart, save.indexOf("});", bodyStart));
    for (const field of ["name:", "color:", "capacity:", "description:", "defaultTeamKey:", "sortOrder:"]) {
      assert.equal(body.includes(field), false, `${name} must not resend ${field}`);
    }
  }
});

test("a row editor diffs against the row as loaded, not against current server truth", () => {
  // Diffing against the live RSC payload would reintroduce the bug from the
  // other side: a field this operator never touched would differ from a
  // colleague's newer value and be resent, reverting it.
  assert.match(source, /loaded: \{ name: room\.name, capacity: room\.capacity \}/);
  assert.match(source, /loaded: \{ name: track\.name, color: track\.color \}/);
  assert.match(source, /loaded: \{[\s\S]{0,200}?defaultTeamKey: category\.defaultTeamKey,[\s\S]{0,40}?\}/);
  for (const save of ["saveRoom", "saveTrack", "saveCategory"]) {
    const start = source.indexOf(`async function ${save}`);
    const body = source.slice(start, source.indexOf("const patch", start));
    assert.doesNotMatch(body, /view\.(rooms|tracks|categories)\.find/, save);
  }
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
