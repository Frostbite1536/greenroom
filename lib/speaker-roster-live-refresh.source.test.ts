import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(new URL("../components/speaker-roster-live-refresh.tsx", import.meta.url), "utf8");
const speakersPage = readFileSync(new URL("../app/(app)/admin/speakers/page.tsx", import.meta.url), "utf8");
const taskManager = readFileSync(new URL("../components/onboarding-task-manager.tsx", import.meta.url), "utf8");

test("the roster refresh is a narrow route refresh, not a client data API", () => {
  assert.match(component, /startTransition\(\(\) => router\.refresh\(\)\)/);
  assert.doesNotMatch(component, /fetch\(|apiGet|apiPost|apiPatch/);
  assert.match(component, /SPEAKER_ROSTER_REFRESH_INTERVAL_MS/);
  assert.match(component, /window\.setTimeout/);
  assert.match(component, /window\.clearTimeout/);
});

test("the roster refresh pauses for browser state, dialogs, focused editors, dirty forms, and transitions", () => {
  assert.match(component, /visibilitychange/);
  assert.match(component, /focusin/);
  assert.match(component, /focusout/);
  assert.match(component, /window\.addEventListener\("focus"/);
  assert.match(component, /window\.addEventListener\("blur"/);
  assert.match(component, /new MutationObserver\(reconsider\)/);
  assert.match(component, /attributeFilter: \["open", "data-speaker-roster-refresh-blocker"\]/);
  assert.match(component, /observer\.disconnect\(\)/);
  assert.match(component, /document\.hasFocus\(\)/);
  assert.match(component, /dialog\[open\]/);
  assert.match(component, /data-speaker-roster-refresh-blocker='true'/);
  assert.match(component, /input:not\(\[disabled\]\):not\(\[readonly\]\)/);
  assert.match(component, /pending/);
  assert.match(component, /Pause live refresh/);
  assert.match(component, /Resume live refresh/);
  assert.match(component, /disabled=\{!mayManuallyRefresh\}/);
  assert.match(component, /requestRefresh\(true\)/);
  assert.match(component, /requestRefresh\(false\)/);
  assert.doesNotMatch(component, /aria-live=/);
});

test("the page mounts the refresh island and the inline task editor marks itself unsafe to refresh", () => {
  assert.match(speakersPage, /<SpeakerRosterLiveRefresh \/>/);
  assert.match(taskManager, /data-speaker-roster-refresh-blocker=\{draftDirty \|\| editingId !== null \? "true" : undefined\}/);
});
