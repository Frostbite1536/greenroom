import { z } from "zod";

const boolish = z.enum(["true", "false"]);
export const V1_API_KEY_MIN_LENGTH = 32;
const v1ApiKeySchema = z.string().trim().min(V1_API_KEY_MIN_LENGTH).optional();

const envSchema = z.object({
  DATABASE_URL: z.string().url().startsWith("postgresql://"),
  // When true, external integrations (email, Accelevents, Airtable) run as
  // logged mocks instead of making real network calls. Safe default for demos.
  MOCK_EXTERNAL_APIS: boolish.default("true"),
  // Explicitly opt in to the destructive demo reset. Must be "true" for the
  // reset endpoint/script to run; otherwise reset is refused (INV-RESET-001).
  ALLOW_DEMO_RESET: boolish.default("false"),
  // Optional real-integration credentials. Absent => the mock path is used.
  RESEND_API_KEY: z.string().min(1).optional(),
  ACCELEVENTS_BASE_URL: z.string().url().optional(),
  ACCELEVENTS_API_KEY: z.string().min(1).optional(),
  AIRTABLE_API_KEY: z.string().min(1).optional(),
  AIRTABLE_BASE_ID: z.string().trim().min(1).optional(),
  // Optional server-only key for the read-only v1 REST surface. When absent,
  // those routes deliberately return 503 instead of becoming public.
  GREENROOM_API_KEY: v1ApiKeySchema,
  // Public base URL of the deployment (used for absolute links in emails/.ics).
  APP_URL: z.string().url().optional(),
});

export type ServerEnv = z.infer<typeof envSchema>;

export function getServerEnv(): ServerEnv {
  return envSchema.parse({
    DATABASE_URL: process.env.DATABASE_URL,
    MOCK_EXTERNAL_APIS: process.env.MOCK_EXTERNAL_APIS,
    ALLOW_DEMO_RESET: process.env.ALLOW_DEMO_RESET,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    ACCELEVENTS_BASE_URL: process.env.ACCELEVENTS_BASE_URL,
    ACCELEVENTS_API_KEY: process.env.ACCELEVENTS_API_KEY,
    AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY,
    AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
    GREENROOM_API_KEY: process.env.GREENROOM_API_KEY,
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

/** Server-only key for the optional read-only v1 REST surface. */
export function getV1ApiKey(): string | undefined {
  const parsed = v1ApiKeySchema.safeParse(process.env.GREENROOM_API_KEY);
  return parsed.success ? parsed.data : undefined;
}
