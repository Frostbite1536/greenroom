import assert from "node:assert/strict";
import test from "node:test";
import {
  SPEAKER_ROSTER_REFRESH_INTERVAL_MS,
  mayManuallyRefreshSpeakerRoster,
  mayRefreshSpeakerRoster,
  speakerRosterRefreshStatus,
  type SpeakerRosterRefreshBlockers,
} from "./speaker-roster-live-refresh";

const clear: SpeakerRosterRefreshBlockers = {
  paused: false,
  hidden: false,
  focused: true,
  dialogOpen: false,
  dirtyEditor: false,
  editableFocused: false,
  pending: false,
};

test("the speaker roster waits a deliberate twenty seconds between automatic checks", () => {
  assert.equal(SPEAKER_ROSTER_REFRESH_INTERVAL_MS, 20_000);
});

test("automatic speaker roster refresh runs only when every dirty-safety guard is clear", () => {
  assert.equal(mayRefreshSpeakerRoster(clear), true);
  for (const blocker of [
    "paused",
    "hidden",
    "dialogOpen",
    "dirtyEditor",
    "editableFocused",
    "pending",
  ] as const) {
    assert.equal(mayRefreshSpeakerRoster({ ...clear, [blocker]: true }), false, blocker);
  }
  assert.equal(mayRefreshSpeakerRoster({ ...clear, focused: false }), false, "unfocused");
});

test("manual refresh overrides only the browser-tab pause, never an unsafe editor state", () => {
  assert.equal(mayManuallyRefreshSpeakerRoster({ ...clear, paused: true }), true);
  assert.equal(mayManuallyRefreshSpeakerRoster({ ...clear, hidden: true, focused: false }), true);
  for (const blocker of ["dialogOpen", "dirtyEditor", "editableFocused", "pending"] as const) {
    assert.equal(mayManuallyRefreshSpeakerRoster({ ...clear, [blocker]: true }), false, blocker);
  }
});

test("the live-refresh status says why it is paused instead of implying a check happened", () => {
  assert.match(speakerRosterRefreshStatus({ ...clear, paused: true }, null), /paused for this browser tab/i);
  assert.match(speakerRosterRefreshStatus({ ...clear, hidden: true }, null), /tab is active/i);
  assert.match(speakerRosterRefreshStatus({ ...clear, dialogOpen: true }, null), /while you edit/i);
  assert.match(speakerRosterRefreshStatus({ ...clear, pending: true }, null), /Refreshing/i);
  assert.match(speakerRosterRefreshStatus(clear, null), /every 20 seconds/i);
  assert.match(speakerRosterRefreshStatus(clear, Date.UTC(2026, 4, 1, 9, 5)), /Refresh requested at/i);
});
