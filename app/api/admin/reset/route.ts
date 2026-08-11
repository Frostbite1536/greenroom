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
 * deterministically), environment-gated (ALLOW_DEMO_RESET=true), authorized
 * (ADMIN session required), and *targeted* — the caller's active event must be
 * the event the seed rebuilds. Refused otherwise, so it is unauthorized in
 * production unless an operator deliberately opts in.
 */
export async function POST() {
  if (!isDemoResetAllowed()) {
    return fail("RESET_DISABLED", "Demo reset is disabled. Set ALLOW_DEMO_RESET=true to enable it.", 403);
  }

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
