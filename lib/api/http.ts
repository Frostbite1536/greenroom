import { ZodError, type ZodTypeAny, type z } from "zod";
import type { ApiFailure } from "@/types/api";

/**
 * Backend HTTP helpers. Every route returns the locked shared-contract shape
 * (`ApiResponse<T>` from `types/api.ts`): `{ ok: true, data }` on success or
 * `{ ok: false, error }` on failure. Validation happens at the boundary and
 * authorization is enforced server-side (see `lib/api/context.ts`).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function ok<T>(data: T, status = 200): Response {
  return Response.json({ ok: true, data }, { status });
}

export function fail(
  status: number,
  code: string,
  message: string,
  fieldErrors?: Record<string, string[]>,
): Response {
  const body: ApiFailure = { ok: false, error: { code, message, fieldErrors } };
  return Response.json(body, { status });
}

/** Parse + validate a JSON request body against a Zod schema. */
export async function parseBody<S extends ZodTypeAny>(
  req: Request,
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw fromZod(result.error);
  return result.data;
}

export function fromZod(error: ZodError): ApiError {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".") || "_root";
    (fieldErrors[path] ??= []).push(issue.message);
  }
  return new ApiError(422, "VALIDATION_ERROR", "Request validation failed.", fieldErrors);
}

/**
 * Wrap a route handler so thrown `ApiError`/`ZodError` become stable failure
 * responses and everything else becomes a 500 without leaking internals.
 */
export function handle(
  fn: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    try {
      return await fn(req);
    } catch (error) {
      return toResponse(error);
    }
  };
}

export function toResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return fail(error.status, error.code, error.message, error.fieldErrors);
  }
  if (error instanceof ZodError) {
    const apiError = fromZod(error);
    return fail(apiError.status, apiError.code, apiError.message, apiError.fieldErrors);
  }
  console.error("[api] unhandled error", error);
  return fail(500, "INTERNAL_ERROR", "Something went wrong.");
}
