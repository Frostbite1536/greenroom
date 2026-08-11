import { requireContext } from "@/lib/api/context";
import { parseBoundedJson } from "@/lib/api/bounded-json";
import { ApiError, fromZod, handle, ok } from "@/lib/api/http";
import {
  RESOURCE_DRAFT_BODY_MAX_BYTES,
  generateResourceDraft,
  resourceDraftRequestSchema,
  type ResourceDraftGenerationResult,
  type ResourceDraftRequest,
} from "@/lib/assistant/resource-draft";
import { enforceAssistantRateLimit } from "@/lib/services/assistant-rate";

export const dynamic = "force-dynamic";

type ResourceDraftContext = { userId: string; eventId: string };

export type ResourceDraftRouteDependencies = {
  requireAdmin: () => Promise<ResourceDraftContext>;
  enforceRate: (input: ResourceDraftContext) => Promise<void>;
  generate: (input: ResourceDraftRequest) => Promise<ResourceDraftGenerationResult>;
};

const productionDependencies: ResourceDraftRouteDependencies = {
  requireAdmin: async () => requireContext(["ADMIN"]),
  enforceRate: enforceAssistantRateLimit,
  generate: generateResourceDraft,
};

const ASSISTANT_FAILURES = {
  disabled: {
    status: 503,
    code: "ASSISTANT_DISABLED",
    message: "AI drafting is not configured. Templates, preview, manual HTML, save, and publish still work.",
  },
  timeout: {
    status: 504,
    code: "ASSISTANT_TIMEOUT",
    message: "AI drafting timed out. Your notes and current page draft were not changed.",
  },
  rate_limited: {
    status: 503,
    code: "ASSISTANT_PROVIDER_RATE_LIMITED",
    message: "The AI provider is temporarily busy. Your notes and current page draft were not changed.",
  },
  provider_error: {
    status: 502,
    code: "ASSISTANT_PROVIDER_ERROR",
    message: "The AI provider could not create a suggestion. Your notes and current page draft were not changed.",
  },
  invalid_output: {
    status: 502,
    code: "ASSISTANT_INVALID_OUTPUT",
    message: "The AI response was not safe to use. Your notes and current page draft were not changed.",
  },
} as const;

function assistantFailure(result: Extract<ResourceDraftGenerationResult, { ok: false }>): ApiError {
  const failure = ASSISTANT_FAILURES[result.reason];
  return new ApiError(failure.status, failure.code, failure.message);
}

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/**
 * POST /api/assistant/resource-draft
 *
 * ADMIN-only. Event scope comes only from the resolved session and is used
 * only for the durable cost bucket; the feature reads no event record and its
 * strict body has no eventId. Generation returns a suggestion — never a save,
 * publication, provider memory, or side effect on the resource table.
 */
export function createResourceDraftPost(
  dependencies: ResourceDraftRouteDependencies = productionDependencies,
): (req: Request) => Promise<Response> {
  const action = handle(async (req) => {
    const ctx = await dependencies.requireAdmin();
    const parsed = resourceDraftRequestSchema.safeParse(
      await parseBoundedJson(req, RESOURCE_DRAFT_BODY_MAX_BYTES),
    );
    if (!parsed.success) throw fromZod(parsed.error);

    await dependencies.enforceRate({ userId: ctx.userId, eventId: ctx.eventId });
    const generated = await dependencies.generate(parsed.data);
    if (!generated.ok) throw assistantFailure(generated);
    return ok({ suggestion: generated.suggestion });
  });
  return async (req) => noStore(await action(req));
}

export const POST = createResourceDraftPost();
