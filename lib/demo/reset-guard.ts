import { DEMO_EVENT } from "@/lib/demo/seed";

export const RESET_WRONG_EVENT_CODE = "RESET_WRONG_EVENT";
export const RESET_WRONG_EVENT_MESSAGE =
  "Demo reset rebuilds the demo event only. Switch your active event to the demo event to run it.";

/** The one event `seedDemo` wipes and rebuilds — read from the seed, never retyped. */
export const DEMO_RESET_TARGET_EVENT_ID = DEMO_EVENT.id;

export type ResetRefusal = { code: string; message: string; status: number };

/**
 * GRA2-05 — the reset target must be the caller's own event.
 *
 * `seedDemo` wipes and rebuilds a hard-coded event id. The route required an
 * ADMIN session and the `ALLOW_DEMO_RESET` environment gate, but never checked
 * that the admin asking was an admin *of that event* — so wherever reset is
 * enabled, an administrator of any other event could destroy and reseed the
 * demo event's data. Nothing in the request names an event, so there was no
 * scope assertion to fail: the mismatch is between the caller's active event
 * and a constant, which is why `assertEventScope` does not cover it.
 *
 * Harmless in the single-event demo, and mitigated in production by
 * `ALLOW_DEMO_RESET` being unset — but wrong by construction now that admins
 * can create their own events.
 *
 * 403 with a precise code, returned as a descriptor rather than thrown: this
 * route builds its refusals with its own `fail()` helper and is not wrapped in
 * `handle()`, so a thrown `ApiError` would escape as a 500.
 */
export function demoResetTargetRefusal(callerEventId: string): ResetRefusal | null {
  if (callerEventId === DEMO_RESET_TARGET_EVENT_ID) return null;
  return { code: RESET_WRONG_EVENT_CODE, message: RESET_WRONG_EVENT_MESSAGE, status: 403 };
}
