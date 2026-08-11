import { sanitizeHtml } from "@/lib/sanitize-html";

/** Template keys the future resource-draft assistant is allowed to accept. */
export const RESOURCE_ASSISTANT_TEMPLATE_KEYS = [
  "speaker-handbook",
  "venue-travel",
  "av-stage",
  "day-of",
] as const;

export const RESOURCE_TEMPLATE_KEYS = [
  ...RESOURCE_ASSISTANT_TEMPLATE_KEYS,
  "blank",
] as const;

export type ResourceAssistantTemplateKey = (typeof RESOURCE_ASSISTANT_TEMPLATE_KEYS)[number];
export type ResourceTemplateKey = (typeof RESOURCE_TEMPLATE_KEYS)[number];

export type ResourceTemplate = {
  key: ResourceTemplateKey;
  label: string;
  description: string;
  sections: readonly { key: string; heading: string }[];
  htmlContent: string;
};

/**
 * Deterministic starting points for organizer-authored resource pages.
 *
 * These are intentionally event-agnostic. Bracketed prompts stay visible until
 * an organizer replaces them, rather than pretending to know an event's dates,
 * address, contacts, policies, or links. Every byte is valid under the existing
 * resource sanitizer, so applying a template and previewing it are stable even
 * when no AI provider is configured.
 */
export const RESOURCE_TEMPLATES: readonly ResourceTemplate[] = [
  {
    key: "speaker-handbook",
    label: "Speaker handbook",
    description: "Arrival, preparation, presentation, and support guidance.",
    sections: [
      { key: "welcome", heading: "Welcome, speakers" },
      { key: "key-dates", heading: "Key dates" },
      { key: "before-arrival", heading: "Before you arrive" },
      { key: "presentation", heading: "Presentation guidance" },
      { key: "help", heading: "Need help?" },
    ],
    htmlContent: [
      "<h2>Welcome, speakers</h2>",
      "<p>Use this handbook to prepare for your session and know what to expect on event day.</p>",
      "<h3>Key dates</h3>",
      "<ul><li><strong>Slides due:</strong> [Add date and submission instructions]</li><li><strong>Speaker check-in:</strong> [Add time and location]</li></ul>",
      "<h3>Before you arrive</h3>",
      "<ul><li>[Add preparation guidance]</li><li>[Add accessibility or accommodation guidance]</li></ul>",
      "<h3>Presentation guidance</h3>",
      "<ul><li>[Add session length and format]</li><li>[Add slide format or sharing guidance]</li></ul>",
      "<h3>Need help?</h3>",
      "<p>[Add the event-approved contact method]</p>",
    ].join(""),
  },
  {
    key: "venue-travel",
    label: "Venue and travel guide",
    description: "Venue access, transport, lodging, and arrival details.",
    sections: [
      { key: "venue", heading: "Venue" },
      { key: "getting-there", heading: "Getting there" },
      { key: "lodging", heading: "Lodging" },
      { key: "accessibility", heading: "Accessibility" },
    ],
    htmlContent: [
      "<h2>Venue and travel</h2>",
      "<h3>Venue</h3>",
      "<p><strong>Address:</strong> [Add venue address]</p>",
      "<p><strong>Speaker entrance:</strong> [Add entrance and access instructions]</p>",
      "<h3>Getting there</h3>",
      "<ul><li><strong>Public transport:</strong> [Add route guidance]</li><li><strong>Parking:</strong> [Add parking guidance]</li><li><strong>Airport or station:</strong> [Add transfer guidance]</li></ul>",
      "<h3>Lodging</h3>",
      "<p>[Add approved hotel or lodging information]</p>",
      "<h3>Accessibility</h3>",
      "<p>[Add step-free access, quiet space, and accommodation details]</p>",
    ].join(""),
  },
  {
    key: "av-stage",
    label: "A/V and stage requirements",
    description: "Room setup, slide delivery, microphones, and technical checks.",
    sections: [
      { key: "slide-delivery", heading: "Slide delivery" },
      { key: "on-stage", heading: "On stage" },
      { key: "technical-check", heading: "Technical check" },
      { key: "special-requirements", heading: "Special requirements" },
    ],
    htmlContent: [
      "<h2>A/V and stage requirements</h2>",
      "<h3>Slide delivery</h3>",
      "<ul><li><strong>Format:</strong> [Add accepted file formats]</li><li><strong>Deadline:</strong> [Add deadline]</li><li><strong>Delivery:</strong> [Add upload or handoff instructions]</li></ul>",
      "<h3>On stage</h3>",
      "<ul><li><strong>Microphone:</strong> [Add microphone setup]</li><li><strong>Display:</strong> [Add aspect ratio and resolution]</li><li><strong>Confidence monitor:</strong> [Add availability]</li></ul>",
      "<h3>Technical check</h3>",
      "<p>[Add check-in time, location, and technical contact method]</p>",
      "<h3>Special requirements</h3>",
      "<p>[Add the process and deadline for requesting additional equipment]</p>",
    ].join(""),
  },
  {
    key: "day-of",
    label: "Day-of schedule and contacts",
    description: "A concise run-of-show with check-in points and support contacts.",
    sections: [
      { key: "schedule", heading: "Schedule" },
      { key: "contacts", heading: "Contacts" },
      { key: "changes", heading: "If plans change" },
    ],
    htmlContent: [
      "<h2>Day-of schedule and contacts</h2>",
      "<h3>Schedule</h3>",
      "<table><thead><tr><th>Time</th><th>What to do</th><th>Where</th></tr></thead><tbody><tr><td>[Add time]</td><td>Speaker check-in</td><td>[Add location]</td></tr><tr><td>[Add time]</td><td>Technical check</td><td>[Add location]</td></tr><tr><td>[Add time]</td><td>Be ready near your room</td><td>[Add location]</td></tr></tbody></table>",
      "<h3>Contacts</h3>",
      "<ul><li><strong>Speaker support:</strong> [Add approved contact method]</li><li><strong>Technical support:</strong> [Add approved contact method]</li><li><strong>Urgent venue issue:</strong> [Add approved contact method]</li></ul>",
      "<h3>If plans change</h3>",
      "<p>[Add the event-approved escalation and update process]</p>",
    ].join(""),
  },
  {
    key: "blank",
    label: "Blank page",
    description: "Start with an empty HTML editor.",
    sections: [],
    htmlContent: "",
  },
] as const;

const RESOURCE_TEMPLATE_BY_KEY = new Map(
  RESOURCE_TEMPLATES.map((template) => [template.key, template] as const),
);

const RESOURCE_ASSISTANT_TEMPLATE_KEY_SET = new Set<string>(RESOURCE_ASSISTANT_TEMPLATE_KEYS);

export function isResourceTemplateKey(value: string): value is ResourceTemplateKey {
  return RESOURCE_TEMPLATE_BY_KEY.has(value as ResourceTemplateKey);
}

export function isResourceAssistantTemplateKey(value: string): value is ResourceAssistantTemplateKey {
  return RESOURCE_ASSISTANT_TEMPLATE_KEY_SET.has(value);
}

export function getResourceTemplate(key: ResourceTemplateKey): ResourceTemplate {
  const template = RESOURCE_TEMPLATE_BY_KEY.get(key);
  if (!template) throw new Error(`Unknown resource template: ${key}`);
  return template;
}

export function sanitizedResourceTemplateHtml(key: ResourceTemplateKey): string {
  return sanitizeHtml(getResourceTemplate(key).htmlContent);
}

export function resourceTemplateNeedsConfirmation(currentHtml: string, _key: ResourceTemplateKey): boolean {
  // Even re-applying the same template is an explicit replacement action. The
  // caller asks first whenever the editor already contains meaningful bytes.
  return currentHtml.trim() !== "";
}

/** Every generated suggestion follows the same explicit-overwrite rule. */
export function resourceHtmlNeedsReplacementConfirmation(currentHtml: string): boolean {
  return currentHtml.trim() !== "";
}

/** Replace only HTML; metadata and publish state remain byte-for-byte unchanged. */
export function applyResourceTemplate<T extends { htmlContent: string }>(draft: T, key: ResourceTemplateKey): T {
  return { ...draft, htmlContent: getResourceTemplate(key).htmlContent };
}
