import { z } from "zod";
import { sanitizeHtml } from "@/lib/sanitize-html";

/**
 * Editing rules for reminder templates.
 *
 * Dependency-free and pure so the same rules run in the browser (live preview,
 * placeholder warnings) and on the server (the authoritative write), and so the
 * whole surface is unit-testable without a database.
 */

/**
 * Placeholders the reminders route substitutes for every recipient
 * (`app/api/comms/reminders/route.ts`). Sample values are only used for preview.
 */
export const TEMPLATE_VARIABLES = [
  { key: "speakerName", label: "Speaker's name", sample: "Sofia Marques" },
  { key: "eventName", label: "Event name", sample: "Forward 2026" },
  { key: "talkTitle", label: "Their talk", sample: "Scaling Vector Search" },
  { key: "slotTime", label: "When they're on", sample: "2026-05-12 17:00 UTC" },
  { key: "roomName", label: "Where they're on", sample: "Hall A" },
  { key: "openTasks", label: "Tasks they still owe", sample: "2" },
  { key: "dueDate", label: "Event start date", sample: "2026-05-12" },
] as const;

export const KNOWN_TEMPLATE_VARIABLES: readonly string[] = TEMPLATE_VARIABLES.map((variable) => variable.key);

/** `{{ name }}` with optional inner spacing — same pattern the renderer uses. */
const PLACEHOLDER = /{{\s*([A-Za-z][A-Za-z0-9_]*)\s*}}/g;

export function extractTemplateVariables(...texts: string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(PLACEHOLDER)) found.add(match[1]);
  }
  return [...found].sort();
}

/**
 * Placeholders that will render as empty text because nothing supplies them.
 *
 * A silently blank sentence in a speaker email is the failure this prevents, so
 * it is a warning surfaced to the operator, not a hard rejection: the reminders
 * API also accepts caller-supplied `variables`, so an unknown name is unusual
 * rather than definitely wrong.
 */
export function unknownTemplateVariables(...texts: string[]): string[] {
  return extractTemplateVariables(...texts).filter((name) => !KNOWN_TEMPLATE_VARIABLES.includes(name));
}

export const emailTemplateUpdateSchema = z.object({
  subject: z.string().trim().min(1, "Give the email a subject.").max(200),
  htmlBody: z.string().trim().min(1, "The email needs a message.").max(20_000),
  // Free-form label on the model; kept short and optional.
  trigger: z.string().trim().max(60).nullish(),
});

export type EmailTemplateUpdate = z.infer<typeof emailTemplateUpdateSchema>;

/**
 * Sanitize a submitted body and report whether anything was removed.
 *
 * Storing the sanitized value keeps INV-HTML-001 true at rest as well as on
 * read. Silently dropping an operator's markup would be worse than refusing it,
 * so the caller gets `changed` and can tell them what happened.
 */
export function sanitizeTemplateBody(htmlBody: string): { htmlBody: string; changed: boolean } {
  const sanitized = sanitizeHtml(htmlBody);
  return { htmlBody: sanitized, changed: sanitized.trim() !== htmlBody.trim() };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render with sample data exactly the way `renderEmailTemplate` renders with
 * real data: sanitize first, then substitute escaped values, so a preview can
 * never execute markup the real email would have stripped.
 */
export function previewTemplate(template: { subject: string; htmlBody: string }): { subject: string; html: string } {
  const samples = Object.fromEntries(TEMPLATE_VARIABLES.map((variable) => [variable.key, variable.sample]));
  const substitute = (text: string, escape: boolean) =>
    text.replace(PLACEHOLDER, (_match, key: string) => {
      const value = samples[key] ?? "";
      return escape ? escapeHtml(value) : value;
    });
  return {
    subject: substitute(template.subject, false),
    html: substitute(sanitizeHtml(template.htmlBody), true),
  };
}
