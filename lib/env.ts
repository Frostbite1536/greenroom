import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url().startsWith("postgresql://"),
  MOCK_EXTERNAL_APIS: z.enum(["true", "false"]).default("true"),
});

export type ServerEnv = z.infer<typeof envSchema>;

export function getServerEnv(): ServerEnv {
  return envSchema.parse({
    DATABASE_URL: process.env.DATABASE_URL,
    MOCK_EXTERNAL_APIS: process.env.MOCK_EXTERNAL_APIS,
  });
}
