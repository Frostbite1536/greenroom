import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { isDemoResetAllowed } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { seedDemo } from "@/lib/demo/seed";
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
 * deterministically), environment-gated (ALLOW_DEMO_RESET=true), and authorized
 * (ADMIN session required). Refused otherwise, so it is unauthorized in
 * production unless an operator deliberately opts in.
 */
export async function POST() {
  if (!isDemoResetAllowed()) {
    return fail("RESET_DISABLED", "Demo reset is disabled. Set ALLOW_DEMO_RESET=true to enable it.", 403);
  }

  const session = await getSession();
  if (!session || session.role !== "ADMIN") {
    return fail("FORBIDDEN", "An admin session is required to reset demo data.", 403);
  }

  try {
    const summary = await seedDemo(prisma);
    return NextResponse.json<ApiResponse<typeof summary>>({ ok: true, data: summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error during reset.";
    return fail("RESET_FAILED", message, 500);
  }
}
