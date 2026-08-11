import { z } from "zod";

const boolish = z.enum(["true", "false"]);
export const V1_API_KEY_MIN_LENGTH = 32;
export const SESSION_SECRET_MIN_LENGTH = 32;
const v1ApiKeySchema = z.string().trim().min(V1_API_KEY_MIN_LENGTH).optional();
const sessionSecretSchema = z.string().trim().min(SESSION_SECRET_MIN_LENGTH).optional();
const resendFromSchema = z.string().trim().min(3).max(320).refine((value) => {
  const match = value.match(/^(?:[^<>\r\n]+\s)?<([^<>\s]+)>$/);
  return z.string().email().safeParse(match?.[1] ?? value).success;
}, "RESEND_FROM must be an email address or display name plus email address.").optional();

const envSchema = z.object({
  DATABASE_URL: z.string().url().startsWith("postgresql://"),
  // When true, external integrations (email, Accelevents, Airtable) run as
  // logged mocks instead of making real network calls. Safe default for demos.
  MOCK_EXTERNAL_APIS: boolish.default("true"),
  // Explicitly opt in to the destructive demo reset. Must be "true" for the
  // reset endpoint/script to run; otherwise reset is refused (INV-RESET-001).
  ALLOW_DEMO_RESET: boolish.default("false"),
  // GRA2-01. The one-click `/login` personas are passwordless by design for the
  // judged demo. In production they are refused unless this is exactly "true",
  // so a deployment that forgets it fails closed instead of publishing three
  // unauthenticated role logins. Outside production it is not consulted.
  DEMO_PERSONA_LOGIN_ENABLED: boolish.default("false"),
  // Optional real-integration credentials. Absent => the mock path is used.
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM: resendFromSchema,
  ACCELEVENTS_BASE_URL: z.string().url().optional(),
  ACCELEVENTS_API_KEY: z.string().min(1).optional(),
  AIRTABLE_API_KEY: z.string().min(1).optional(),
  AIRTABLE_BASE_ID: z.string().trim().min(1).optional(),
  // Optional server-only key for the read-only v1 REST surface. When absent,
  // those routes deliberately return 503 instead of becoming public.
  GREENROOM_API_KEY: v1ApiKeySchema,
  // Required in production for signed auth cookies; development/test gets an
  // intentionally non-production fallback so local demo tooling stays usable.
  SESSION_SECRET: sessionSecretSchema,
  // Public base URL of the deployment (used for absolute links in emails/.ics).
  APP_URL: z.string().url().optional(),
});

export type ServerEnv = z.infer<typeof envSchema>;

export function getServerEnv(): ServerEnv {
  return envSchema.parse({
    DATABASE_URL: process.env.DATABASE_URL,
    MOCK_EXTERNAL_APIS: process.env.MOCK_EXTERNAL_APIS,
    ALLOW_DEMO_RESET: process.env.ALLOW_DEMO_RESET,
    DEMO_PERSONA_LOGIN_ENABLED: process.env.DEMO_PERSONA_LOGIN_ENABLED,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_FROM: process.env.RESEND_FROM,
    ACCELEVENTS_BASE_URL: process.env.ACCELEVENTS_BASE_URL,
    ACCELEVENTS_API_KEY: process.env.ACCELEVENTS_API_KEY,
    AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY,
    AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
    GREENROOM_API_KEY: process.env.GREENROOM_API_KEY,
    SESSION_SECRET: process.env.SESSION_SECRET,
    APP_URL: process.env.APP_URL,
  });
}

/** True when external integrations should be mocked (default in the demo). */
export function useMockIntegrations(): boolean {
  return (process.env.MOCK_EXTERNAL_APIS ?? "true") !== "false";
}

/** Whether the destructive demo reset is permitted in this environment. */
export function isDemoResetAllowed(): boolean {
  return process.env.ALLOW_DEMO_RESET === "true";
}

/**
 * GRA2-01 — whether the passwordless one-click `/login` personas may be used.
 *
 * Fail-closed, and only where failing closed costs nothing to run the project:
 * in production the flag must be exactly the string `"true"`, so unset, `"false"`,
 * `"TRUE"`, `"1"`, or anything else refuses. Outside production (development,
 * test, and the `next start` smoke harnesses, which set no such flag) the
 * personas stay on with no configuration — they are how the demo, the seeds and
 * the local golden path are driven.
 *
 * Read at request time from `process.env`, exactly like `isDemoResetAllowed`, so
 * one deployment build can be flipped by configuration alone.
 */
export function arePersonaLoginsEnabled(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return process.env.DEMO_PERSONA_LOGIN_ENABLED === "true";
}

/** Server-only key for the optional read-only v1 REST surface. */
export function getV1ApiKey(): string | undefined {
  const parsed = v1ApiKeySchema.safeParse(process.env.GREENROOM_API_KEY);
  return parsed.success ? parsed.data : undefined;
}

/** Valid sender identity for live Resend calls. Missing/invalid keeps email mocked. */
export function getResendFrom(): string | undefined {
  const parsed = resendFromSchema.safeParse(process.env.RESEND_FROM);
  return parsed.success ? parsed.data : undefined;
}
