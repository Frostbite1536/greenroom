import type { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { getResendFrom, useMockIntegrations } from "@/lib/env";
import { normalizeEmailSubject } from "@/lib/comms/subject";

/**
 * One audited path for every email Greenroom sends.
 *
 * Before this existed the only sender was inlined in the reminders route, so a
 * second email feature would have meant a second copy of the provider call,
 * the mock branch, and the `EmailDispatch` bookkeeping. Everything now goes
 * through `dispatchEmail`, which means: every send is recorded in
 * `EmailDispatch` first (so a crash mid-provider-call leaves evidence), the
 * mock branch is identical everywhere, and one idempotency key scheme covers
 * all of it.
 */
export type EmailAttachment = {
  filename: string;
  content: string;
  /**
   * MIME type for this part. Resend derives one from the filename when this is
   * absent, which is right for most attachments and wrong for exactly one: a
   * calendar invitation has to arrive as `text/calendar; method=REQUEST` before
   * Gmail or Outlook will treat it as an invitation rather than a file. Omitted
   * by every existing caller, so their delivered bytes are unchanged.
   */
  contentType?: string;
};

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
};

export type DeliveryMode = "sent" | "mocked" | "failed";
export type DeliveryOutcome = { status: DeliveryMode; providerId?: string; error?: string };

export type Fetcher = typeof fetch;

/** Resend's success payload; `message` carries the reason on failure. */
type ResendResponse = { id?: string; message?: string };

export type DeliveryConfig = {
  /** True when this deployment must not make real provider calls. */
  mocked: boolean;
  from?: string;
  apiKey?: string;
  idempotencyKey: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
};

/**
 * Decide, before any network call, whether email can really be delivered.
 *
 * Mirrors the operator console's `integrationStatus`: demo mode wins over
 * credentials, and missing credentials fall back to mock rather than error, so
 * a deployment without Resend still records what it would have sent.
 */
export function canDeliverEmail(config: { mocked: boolean; from?: string; apiKey?: string }): boolean {
  return !config.mocked && Boolean(config.apiKey) && Boolean(config.from);
}

/** POST one message to Resend. Never throws — failures come back as an outcome. */
async function deliverNormalizedEmail(message: EmailMessage, config: DeliveryConfig): Promise<DeliveryOutcome> {
  if (!canDeliverEmail(config)) return { status: "mocked" };
  const fetcher = config.fetcher ?? fetch;
  try {
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        // Retrying the same logical email reuses this key.
        "Idempotency-Key": config.idempotencyKey,
      },
      signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
      body: JSON.stringify({
        from: config.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        ...(message.attachments?.length
          ? {
              attachments: message.attachments.map((attachment) => ({
                filename: attachment.filename,
                content: Buffer.from(attachment.content, "utf8").toString("base64"),
                // Resend's field is snake_case `content_type` (verified against
                // its send-email API reference). Spread conditionally so an
                // attachment without one produces the identical request body it
                // produced before this field existed.
                ...(attachment.contentType ? { content_type: attachment.contentType } : {}),
              })),
            }
          : {}),
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as ResendResponse;
    if (!response.ok || !payload.id) {
      return { status: "failed", error: (payload.message || `Resend returned ${response.status}.`).slice(0, 500) };
    }
    return { status: "sent", providerId: payload.id };
  } catch (error) {
    return {
      status: "failed",
      error: (error instanceof Error ? error.message : "Email provider request failed.").slice(0, 500),
    };
  }
}

/** Direct callers retain the same safe provider boundary as dispatches. */
export async function deliverEmail(message: EmailMessage, config: DeliveryConfig): Promise<DeliveryOutcome> {
  return deliverNormalizedEmail({ ...message, subject: normalizeEmailSubject(message.subject) }, config);
}

export type DispatchInput = {
  templateId: string;
  senderId?: string | null;
  message: EmailMessage;
  /** Recorded on the dispatch row for auditing; never contains secrets. */
  variables?: Record<string, string>;
  fetcher?: Fetcher;
};

/**
 * Stable across retries of the same logical email, but changes with the
 * recipient, rendered content, template variables, attachment, or sender.
 */
export function logicalEmailIdempotencyKey(input: DispatchInput, from?: string): string {
  const variables = Object.fromEntries(
    Object.entries(input.variables ?? {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  );
  const logicalMessage = JSON.stringify({
    v: 1,
    templateId: input.templateId,
    from: from ?? null,
    to: input.message.to.trim().toLowerCase(),
    subject: input.message.subject,
    html: input.message.html,
    attachments: input.message.attachments ?? [],
    variables,
  });
  return `greenroom-${createHash("sha256").update(logicalMessage).digest("hex")}`;
}

/**
 * Record the intent, attempt delivery, record the result.
 *
 * The row is written *before* the provider call on purpose: if the process dies
 * mid-flight the email is visible as `queued` rather than vanishing, which is
 * the difference between "we don't know" and "we know it didn't finish".
 */
export async function dispatchEmail(
  db: Pick<PrismaClient, "emailDispatch">,
  input: DispatchInput,
): Promise<DeliveryOutcome & { dispatchId: string }> {
  const normalizedInput = { ...input, message: { ...input.message, subject: normalizeEmailSubject(input.message.subject) } };
  const dispatch = await db.emailDispatch.create({
    data: {
      templateId: normalizedInput.templateId,
      senderId: normalizedInput.senderId ?? null,
      recipient: normalizedInput.message.to,
      variables: (normalizedInput.variables ?? {}) as never,
      status: "queued",
    },
    select: { id: true },
  });

  const from = getResendFrom();
  const outcome = await deliverNormalizedEmail(normalizedInput.message, {
    mocked: useMockIntegrations(),
    from,
    apiKey: process.env.RESEND_API_KEY,
    idempotencyKey: logicalEmailIdempotencyKey(normalizedInput, from),
    fetcher: normalizedInput.fetcher,
  });

  await db.emailDispatch.update({
    where: { id: dispatch.id },
    data: {
      status: outcome.status,
      providerId: outcome.providerId ?? (outcome.status === "mocked" ? `mock:${dispatch.id}` : null),
      error: outcome.error ?? null,
      sentAt: outcome.status === "failed" ? null : new Date(),
    },
  });

  return { ...outcome, dispatchId: dispatch.id };
}
