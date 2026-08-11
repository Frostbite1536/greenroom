/**
 * Database safety guard for every browser-level run in this directory.
 *
 * The e2e suites drive REAL writes through the product: they submit proposals,
 * accept them (which provisions Sessions and onboarding tasks), place schedule
 * slots and send mocked email. That is the point — a browser journey has to
 * write to be evidence — but it means these suites must never be pointed at the
 * shared demo database or at production.
 *
 * The guard mirrors `scripts/install-rehearsal.mjs` exactly, and for the same
 * reason it gives there: a loopback base URL only proves the SERVER is local,
 * not that its DATABASE is disposable. So the operator has to assert which
 * database they expect, by naming a distinctive substring of the disposable
 * `DATABASE_URL` in `E2E_EXPECTED_DB`. No value read here is ever printed.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const EXPECTED_DB_VAR = "E2E_EXPECTED_DB";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Playwright is launched by `npx`, not by `next`, so this process does not have
 * the repository `.env` unless we load it. Node's own loader is used rather
 * than a dependency; an absent file is not an error, because an operator may
 * legitimately export `DATABASE_URL` in the shell instead.
 */
export function loadRepoEnv(cwd: string = process.cwd()): void {
  if (process.env.DATABASE_URL) return;
  const file = resolve(cwd, ".env");
  if (!existsSync(file)) return;
  process.loadEnvFile(file);
}

/** The server must be local. A deployed target is refused outright. */
export function assertLoopbackTarget(baseUrl: string): void {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    throw new Error(`E2E base URL '${baseUrl}' is not a URL. These suites are loopback-only.`);
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run against '${host}': these suites write real data and are loopback-only, `
        + "so they cannot reach a deployed environment.",
    );
  }
}

/**
 * Refuse to run unless the operator has asserted which disposable database this
 * is. Returns the asserted substring so a caller can log the assertion (never
 * the URL) if it wants to.
 */
export function assertDisposableDatabase(env: NodeJS.ProcessEnv = process.env): string {
  const expected = env[EXPECTED_DB_VAR]?.trim();
  const actual = env.DATABASE_URL ?? "";

  if (!expected) {
    throw new Error(
      `Set ${EXPECTED_DB_VAR} to a distinctive substring of the DISPOSABLE database's host\n`
        + "(for example its Neon endpoint id) before running the e2e suites. These suites reseed\n"
        + "and write demo-event data, so they refuse to run against an unasserted database.",
    );
  }
  if (!actual) {
    throw new Error(
      "DATABASE_URL is not set in this process, so the disposable-database assertion cannot be\n"
        + "checked. Run from the repository root with a .env present, or export DATABASE_URL.",
    );
  }
  if (!actual.includes(expected)) {
    throw new Error(
      `DATABASE_URL in this environment does not contain '${expected}'.\n`
        + "Refusing to run: the server may be backed by a database you did not intend to mutate.",
    );
  }
  return expected;
}
