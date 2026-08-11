import { getServerEnv, ServerEnvError } from "@/lib/env";

/**
 * D-02 — validate the server environment once, at boot.
 *
 * `lib/env.ts` has carried a full `envSchema` since early in the sprint, and
 * until this file existed it had ZERO call sites: the `postgresql://` check on
 * `DATABASE_URL`, the 32-character floor on `SESSION_SECRET`, the URL shape of
 * `ACCELEVENTS_BASE_URL` — none of it ever executed. A deployment with a
 * mistyped variable booted green and reported healthy, then failed at whatever
 * request first happened to touch the broken thing, which is both later and
 * much harder to read than a failed deploy.
 *
 * `register()` is Next's supported hook for exactly this: it runs once per
 * server instance and **must complete before the server handles requests**
 * (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/`
 * `instrumentation.md`), so throwing here fails the boot rather than degrading
 * the running app. `.env` files are loaded before it runs.
 *
 * Node runtime only. The same hook is invoked in the Edge runtime, where the
 * server-only variables this schema describes are not present at all — running
 * it there would fail every deploy for a reason that is not a misconfiguration.
 * Nothing in this app runs on the edge today; the guard is so that adding an
 * edge route later does not turn this safety net into an outage.
 *
 * The rethrow is deliberately the ORIGINAL error: `ServerEnvError` already
 * names the offending variables without echoing their values, and this line
 * goes to a deploy log where a value must never appear.
 */
export function register(): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    getServerEnv();
  } catch (error) {
    if (error instanceof ServerEnvError) {
      // Logged as well as thrown: on some platforms the boot log is the only
      // surface an operator sees, and a bare stack trace buries the one line
      // that says which variable to fix.
      console.error(`[boot] ${error.message}`);
    }
    throw error;
  }
}
