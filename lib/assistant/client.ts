import { z } from "zod";
import { getOpenAiApiKey } from "@/lib/env";

/**
 * The one provider boundary for AI-assisted drafting.
 *
 * Server-only by contract: it reads `OPENAI_API_KEY` at call time and must
 * never be imported from a client component — `client.test.ts` pins that. It is
 * also deliberately **feature-agnostic**: a caller composes its own
 * `instructions` and its own already-bounded `input` and gets back either text
 * or a reason code, so a second drafting feature reuses this file instead of
 * forking it.
 *
 * Deliberately absent, and not to be added here: streaming, tools/function
 * calling, conversation or chat state, stored prompts, and provider selection.
 * The model is given no capability beyond returning text, which is what makes
 * untrusted proposal and reviewer text safe to pass through as data.
 *
 * Failure is always a value, never a throw. Every caller keeps a deterministic
 * path that must stay usable when the assistant is unconfigured, slow,
 * throttled, or wrong, and a thrown error would take that path down with it.
 */

/** Official OpenAI Responses API. One configured provider, no SDK, no fallback. */
export const ASSISTANT_ENDPOINT = "https://api.openai.com/v1/responses";

/**
 * The single place to change the model.
 *
 * `gpt-5-mini` is the small text model this was written against. If the account
 * does not have it, the request fails closed as `provider_error` and the fix is
 * this constant — nothing else in the file names a model.
 */
export const ASSISTANT_MODEL = "gpt-5-mini";

/**
 * Moves with `ASSISTANT_MODEL`: `reasoning` is only valid for reasoning models
 * (the gpt-5 and o-series families). It is set low rather than omitted because
 * reasoning tokens are drawn from `max_output_tokens`, so a default-effort
 * request under a tight cap can spend the whole budget thinking and return an
 * empty message — which this boundary would then, correctly but uselessly,
 * report as `invalid_output`. Swapping to a non-reasoning model means deleting
 * this constant and the field that carries it.
 */
export const ASSISTANT_REASONING_EFFORT = "low";

/** Total wall-clock budget for one `runAssistant` call, retry included. */
export const ASSISTANT_TIMEOUT_MS = 12_000;

/** The original attempt plus at most one retry. */
export const ASSISTANT_MAX_ATTEMPTS = 2;

export const ASSISTANT_MAX_INSTRUCTION_CHARS = 2_000;
/**
 * Hard ceiling on instructions + input together, whatever the caller passes.
 *
 * 16,000 because the widest consumer sends a resource note of up to 8,000
 * characters *plus* fixed title, summary, and template content alongside it,
 * and a ceiling that clipped the fixed part would silently drop context rather
 * than data. Features stay well under this with their own caps; this is the
 * backstop, not the budget.
 */
export const ASSISTANT_MAX_TOTAL_INPUT_CHARS = 16_000;

/** Unchanged: a short prose draft is still what an unspecified caller gets. */
export const ASSISTANT_DEFAULT_MAX_OUTPUT_CHARS = 1_200;
/**
 * No caller may ask for more than this, however large its own cap is.
 *
 * 24,000 admits the widest consumer: a validated HTML body of up to 20,000
 * characters returned inside a JSON wrapper, whose escaping and envelope cost
 * meaningfully more than the payload's own length. Narrower features pass their
 * own `maxOutputChars` — decision-note drafting stays at 1,200 — so this
 * ceiling only bounds what the boundary will ever hand back.
 */
export const ASSISTANT_MAX_OUTPUT_CHARS = 24_000;
/**
 * Extra `max_output_tokens` beyond the character cap's own estimate, so a
 * reasoning model's hidden tokens do not consume the visible answer.
 *
 * A flat reserve rather than a proportional one: reasoning tokens track how
 * hard the task is, not how long the answer is. Raised alongside the output
 * ceiling because a 24,000-character structured generation is a harder task
 * than a paragraph.
 */
export const ASSISTANT_OUTPUT_TOKEN_HEADROOM = 1_024;

/**
 * The closed set of reasons a caller may ever see.
 *
 * Nothing derived from the provider joins this list: not its status text, not
 * its error body, not an exception message, not a fragment of the prompt or the
 * generated text. A caller that needs to explain a failure to a human maps one
 * of these five codes to its own copy.
 */
export const ASSISTANT_FAILURE_REASONS = [
  "disabled",
  "timeout",
  "rate_limited",
  "provider_error",
  "invalid_output",
] as const;

export type AssistantFailureReason = (typeof ASSISTANT_FAILURE_REASONS)[number];

export type AssistantResult =
  | { ok: true; text: string }
  | { ok: false; reason: AssistantFailureReason };

export type AssistantFetcher = typeof fetch;

/**
 * A caller-owned Responses `text.format` specification.
 *
 * Passed through verbatim, unread and unvalidated by this module. The caller
 * owns the schema, so the caller — not this boundary — is who knows what shape
 * came back and how to check it. Deliberately opaque here: a foundation that
 * understood the schema would have to keep up with every consumer's.
 */
export type AssistantTextFormat = Record<string, unknown>;

export type AssistantRequest = {
  /** How to write. Authored by the feature, never by a user. */
  instructions: string;
  /** What to write from. Untrusted content, passed as data. */
  input: string;
  /** Caller's own cap, clamped to `ASSISTANT_MAX_OUTPUT_CHARS`. */
  maxOutputChars?: number;
  /**
   * Opt into the provider's Structured Outputs mode.
   *
   * When present it becomes the request body's `text.format` unchanged, and
   * `result.text` is the RAW JSON STRING the model produced — this module does
   * not `JSON.parse` it and does not validate it. The caller parses and
   * Zod-validates its own schema's output, because only the caller can say
   * what a valid answer is. Absent (the default) leaves the request in plain
   * prose mode, exactly as before this field existed.
   */
  textFormat?: AssistantTextFormat;
  /** Test seam, mirroring `DeliveryConfig.fetcher` in `lib/comms/send.ts`. */
  fetcher?: AssistantFetcher;
  /** Test seam. May only shorten `ASSISTANT_TIMEOUT_MS`, never extend it. */
  timeoutMs?: number;
};

/** True when this deployment has a usable provider credential. */
export function isAssistantConfigured(): boolean {
  return getOpenAiApiKey() !== undefined;
}

/**
 * Truncate to the hard caps. Instructions keep their own reserve so a runaway
 * `input` cannot squeeze out the rules the model is supposed to follow.
 */
export function boundAssistantInput(request: { instructions: string; input: string }): {
  instructions: string;
  input: string;
} {
  const instructions = request.instructions.slice(0, ASSISTANT_MAX_INSTRUCTION_CHARS);
  const room = Math.max(0, ASSISTANT_MAX_TOTAL_INPUT_CHARS - instructions.length);
  return { instructions, input: request.input.slice(0, room) };
}

/** Clamp the caller's character cap into the range this boundary will serve. */
export function boundAssistantOutputChars(requested?: number): number {
  const wanted = Number.isFinite(requested) ? Math.floor(requested!) : ASSISTANT_DEFAULT_MAX_OUTPUT_CHARS;
  return Math.min(ASSISTANT_MAX_OUTPUT_CHARS, Math.max(1, wanted));
}

/** Token budget for a character cap, with room for hidden reasoning tokens. */
export function assistantMaxOutputTokens(maxOutputChars: number): number {
  return Math.ceil(maxOutputChars / 3) + ASSISTANT_OUTPUT_TOKEN_HEADROOM;
}

/**
 * Structured validation of the provider's payload.
 *
 * Assistant-local on purpose: `types/api.ts` is the locked shared contract
 * between this application's own client and server, and a third party's
 * response shape does not belong in it. Unknown keys are stripped rather than
 * rejected — a provider adding a field must not break drafting — but the shape
 * this file reads has to be there or the result is `invalid_output`.
 */
const providerResponseSchema = z.object({
  status: z.string().optional(),
  output: z.array(
    z.object({
      type: z.string(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    }),
  ),
  usage: z
    .object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() })
    .optional(),
});

type ProviderResponse = z.infer<typeof providerResponseSchema>;

/**
 * The assistant message's text, and only that.
 *
 * `output` is a list of items, not a single answer: a reasoning model emits a
 * `reasoning` item before its `message`, and a refused generation emits a
 * `refusal` content part rather than an `output_text` one. Both correctly
 * produce an empty string here, which the caller sees as `invalid_output`.
 */
function extractOutputText(payload: ProviderResponse): string {
  const parts: string[] = [];
  for (const item of payload.output) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join("").trim();
}

type AssistantUsage = { inputTokens: number; outputTokens: number };

const NO_USAGE: AssistantUsage = { inputTokens: 0, outputTokens: 0 };

type AttemptOutcome =
  | { kind: "text"; text: string; usage: AssistantUsage }
  | { kind: "fail"; reason: AssistantFailureReason; retryable: boolean; usage?: AssistantUsage };

/**
 * The only thing this module ever logs: which model ran, how it ended, and what
 * it cost. Every parameter is a primitive the server itself chose, so there is
 * no argument here that could carry a prompt, a draft, a provider body, or a
 * credential.
 */
function reportOutcome(outcome: string, inputTokens: number, outputTokens: number): void {
  console.info(`[assistant] model=${ASSISTANT_MODEL} outcome=${outcome} in=${inputTokens} out=${outputTokens}`);
}

/**
 * One provider call under one abort budget.
 *
 * `retryable` marks the failures where no response body had begun — a transport
 * error, a 429, or a 5xx. Anything the provider actually answered with is
 * final: retrying a 400 or a malformed payload only spends the budget twice.
 */
async function attemptGeneration(config: {
  apiKey: string;
  fetcher: AssistantFetcher;
  body: string;
  budgetMs: number;
}): Promise<AttemptOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.budgetMs);

  try {
    const response = await config.fetcher(ASSISTANT_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: config.body,
      signal: controller.signal,
    });

    if (!response.ok) {
      // The failure body is deliberately never read. It can quote the prompt
      // back, and the status class is the only thing this boundary acts on.
      if (response.status === 429) return { kind: "fail", reason: "rate_limited", retryable: true };
      if (response.status >= 500) return { kind: "fail", reason: "provider_error", retryable: true };
      return { kind: "fail", reason: "provider_error", retryable: false };
    }

    // `null` here means the body never produced JSON — it was malformed, or it
    // stalled and our own abort tore it up mid-read. Those are different
    // failures: a stalled body is a spent time budget, not a bad answer, and
    // reporting it as `invalid_output` would blame the provider's content for
    // a deadline this module set.
    const raw = await response.json().catch(() => null);
    if (raw === null && timedOut) return { kind: "fail", reason: "timeout", retryable: false };

    const parsed = providerResponseSchema.safeParse(raw);
    if (!parsed.success) return { kind: "fail", reason: "invalid_output", retryable: false };

    const usage = {
      inputTokens: parsed.data.usage?.input_tokens ?? 0,
      outputTokens: parsed.data.usage?.output_tokens ?? 0,
    };
    // A non-`completed` response is a truncated or abandoned generation. Half a
    // sentence is worse than no suggestion, because the caller's deterministic
    // path is still there and still whole.
    if (parsed.data.status !== undefined && parsed.data.status !== "completed") {
      return { kind: "fail", reason: "invalid_output", retryable: false, usage };
    }
    const text = extractOutputText(parsed.data);
    if (!text) return { kind: "fail", reason: "invalid_output", retryable: false, usage };
    return { kind: "text", text, usage };
  } catch {
    // Bindingless on purpose: with no error variable in scope, nothing in this
    // module can log or return the provider's raw failure.
    return timedOut
      ? { kind: "fail", reason: "timeout", retryable: false }
      : { kind: "fail", reason: "provider_error", retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate one bounded piece of text, or say why not.
 *
 * The whole call — first attempt and retry together — is bounded by
 * `ASSISTANT_TIMEOUT_MS`, so a retry cannot double the time a request holds a
 * route open.
 */
export async function runAssistant(request: AssistantRequest): Promise<AssistantResult> {
  const apiKey = getOpenAiApiKey();
  // No credential means no assistant. Returning before the fetch *and* before
  // the log keeps an unconfigured deployment silent and free rather than
  // noisy — and never fabricates a draft to cover the gap.
  if (!apiKey) return { ok: false, reason: "disabled" };

  const maxOutputChars = boundAssistantOutputChars(request.maxOutputChars);
  const bounded = boundAssistantInput(request);
  const body = JSON.stringify({
    model: ASSISTANT_MODEL,
    instructions: bounded.instructions,
    input: bounded.input,
    max_output_tokens: assistantMaxOutputTokens(maxOutputChars),
    reasoning: { effort: ASSISTANT_REASONING_EFFORT },
    // Structured Outputs, only when a caller asked for it. Spread rather than
    // set to `undefined`, so a plain-prose request produces the identical body
    // it produced before this option existed.
    ...(request.textFormat ? { text: { format: request.textFormat } } : {}),
    // Non-retention. Reviewer comments must not become a conversation held on
    // the provider's side that Greenroom would then owe someone a deletion for.
    store: false,
  });

  const fetcher = request.fetcher ?? fetch;
  const budget = Math.min(ASSISTANT_TIMEOUT_MS, Math.max(1, request.timeoutMs ?? ASSISTANT_TIMEOUT_MS));
  const deadline = Date.now() + budget;
  let outcome: AttemptOutcome = { kind: "fail", reason: "timeout", retryable: false };

  for (let attempt = 1; attempt <= ASSISTANT_MAX_ATTEMPTS; attempt += 1) {
    const budgetMs = deadline - Date.now();
    if (budgetMs <= 0) {
      outcome = { kind: "fail", reason: "timeout", retryable: false };
      break;
    }
    outcome = await attemptGeneration({ apiKey, fetcher, body, budgetMs });
    if (outcome.kind === "text" || !outcome.retryable) break;
  }

  const usage = outcome.usage ?? NO_USAGE;
  reportOutcome(outcome.kind === "text" ? "ok" : outcome.reason, usage.inputTokens, usage.outputTokens);
  if (outcome.kind !== "text") return { ok: false, reason: outcome.reason };
  return { ok: true, text: outcome.text.slice(0, maxOutputChars).trimEnd() };
}
