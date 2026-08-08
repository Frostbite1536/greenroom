import type { PrismaClient } from "@prisma/client";
import { getResendFrom, useMockIntegrations } from "@/lib/env";

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
export type EmailAttachment = { filename: string; content: string };

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
export async function deliverEmail(message: EmailMessage, config: DeliveryConfig): Promise<DeliveryOutcome> {
  if (!canDeliverEmail(config)) return { status: "mocked" };
  const fetcher = config.fetcher ?? fetch;
  try {
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        // Retrying the same dispatch row can never send the same email twice.
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

export type DispatchInput = {
  templateId: string;
  senderId?: string | null;
  message: EmailMessage;
  /** Recorded on the dispatch row for auditing; never contains secrets. */
  variables?: Record<string, string>;
  fetcher?: Fetcher;
};

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
  const dispatch = await db.emailDispatch.create({
    data: {
      templateId: input.templateId,
      senderId: input.senderId ?? null,
      recipient: input.message.to,
      variables: (input.variables ?? {}) as never,
      status: "queued",
    },
    select: { id: true },
  });

  const outcome = await deliverEmail(input.message, {
    mocked: useMockIntegrations(),
    from: getResendFrom(),
    apiKey: process.env.RESEND_API_KEY,
    idempotencyKey: `greenroom-${dispatch.id}`,
    fetcher: input.fetcher,
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
