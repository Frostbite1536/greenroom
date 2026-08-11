import { NextResponse } from "next/server";
import { requireContext } from "@/lib/api/context";
import { ApiError } from "@/lib/api/http";
import { isDemoResetAllowed } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { seedDemo } from "@/lib/demo/seed";
import { demoResetTargetRefusal } from "@/lib/demo/reset-guard";
import type { ApiResponse } from "@/types/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(code: string, message: string, status: number) {
  return NextResponse.json<ApiResponse<never>>({ ok: false, error: { code, message } }, { status });
}

/**
 * Demo reset — wipes and reseeds the demo event's data.
 *
 * Guardrails (INV-RESET-001): explicit (POST only), idempotent (seed rebuilds
 * deterministically), authorized (ADMIN session required), environment-gated
 * (ALLOW_DEMO_RESET=true), and *targeted* — the caller's active event must be
 * the event the seed rebuilds. Refused otherwise, so it is unauthorized in
 * production unless an operator deliberately opts in.
 *
 * S-18 — the order of those checks is itself a contract. The env gate used to
 * run FIRST, so an anonymous POST got `RESET_DISABLED` where reset is off and
 * `FORBIDDEN` where it is on: an unauthenticated prober could read the value of
 * a deployment's `ALLOW_DEMO_RESET` from the refusal body alone, which is the
 * one thing standing between a visitor-admin and a destructive rebuild. Every
 * caller who has not proved they are an admin now gets the same 403 `FORBIDDEN`
 * regardless of configuration or active event; the configuration and targeting
 * refusals are reachable only after authorization succeeds, where the caller is
 * an administrator of this deployment and already entitled to know.
 *
 * The three refusals stay distinct for an authenticated admin on purpose —
 * "turn the flag on" and "switch your active event" are different actions and
 * collapsing them would leave an operator guessing.
 */
export async function POST() {
  let ctx;
  try {
    ctx = await requireContext(["ADMIN"]);
  } catch (error) {
    if (error instanceof ApiError) {
      return fail("FORBIDDEN", "An admin session is required to reset demo data.", 403);
    }
    // Keep diagnostics server-side and intentionally avoid request/cookie/DB details.
    console.error("[reset] authorization unavailable", { errorType: error instanceof Error ? error.name : typeof error });
    return fail("AUTH_UNAVAILABLE", "Authorization could not be verified. Try again later.", 503);
  }

  if (!isDemoResetAllowed()) {
    return fail("RESET_DISABLED", "Demo reset is disabled. Set ALLOW_DEMO_RESET=true to enable it.", 403);
  }

  // GRA2-05: being an ADMIN is not enough — the seed rebuilds one hard-coded
  // event, so an admin of any *other* event must not be able to run it. Checked
  // before the seed is reached, so a refusal writes nothing.
  const wrongEvent = demoResetTargetRefusal(ctx.eventId);
  if (wrongEvent) return fail(wrongEvent.code, wrongEvent.message, wrongEvent.status);

  try {
    const summary = await seedDemo(prisma);
    return NextResponse.json<ApiResponse<typeof summary>>({ ok: true, data: summary });
  } catch (error) {
    console.error("[reset] seed failed", { errorType: error instanceof Error ? error.name : typeof error });
    return fail("RESET_FAILED", "Demo reset could not be completed.", 500);
  }
}
