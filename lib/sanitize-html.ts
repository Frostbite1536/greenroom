/**
 * Minimal server-side HTML sanitizer (INV-HTML-001).
 *
 * Conservative allowlist: every element not named below is dropped entirely,
 * and every attribute except a safe `href`/`title` on links is stripped. Script,
 * style, iframe, object and event-handler content can therefore never survive.
 *
 * NOTE: this is deliberately dependency-free because `package.json` is
 * Architect-owned. It is strict rather than clever — it removes anything it does
 * not explicitly understand. For anything beyond admin-authored demo content,
 * swap in `sanitize-html` or DOMPurify (see requests/ for the dependency ask).
 */

const ALLOWED_TAGS = new Set([
  "p", "br", "strong", "b", "em", "i", "u", "s",
  "h2", "h3", "h4",
  "ul", "ol", "li",
  "blockquote", "code", "pre",
  "a", "hr",
  "table", "thead", "tbody", "tr", "th", "td",
]);

/** Only http(s) and mailto links survive — blocks `javascript:`/`data:` URLs. */
function safeHref(value: string): string | null {
  const trimmed = value.trim();
  // Strip control/whitespace characters used to smuggle `java\nscript:`.
  const normalized = trimmed.replace(/[\u0000-\u0020]/g, "").toLowerCase();
  if (normalized.startsWith("http://") || normalized.startsWith("https://") || normalized.startsWith("mailto:")) {
    return trimmed;
  }
  if (normalized.startsWith("/") && !normalized.startsWith("//")) return trimmed;
  return null;
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function sanitizeHtml(input: string): string {
  // 1. Remove entire dangerous elements *including their contents*.
  let html = input.replace(
    /<(script|style|iframe|object|embed|noscript|template|svg|math)\b[\s\S]*?<\/\1\s*>/gi,
    "",
  );
  // Drop unclosed/self-closing variants of the same.
  html = html.replace(/<\/?(script|style|iframe|object|embed|noscript|template|svg|math)\b[^>]*>/gi, "");
  // Remove comments (can hide conditional-comment payloads).
  html = html.replace(/<!--[\s\S]*?-->/g, "");

  // 2. Walk remaining tags; keep allowlisted ones, escape everything else.
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (match, rawName: string, rawAttrs: string) => {
    const name = rawName.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return "";

    const isClosing = match.startsWith("</");
    if (isClosing) return `</${name}>`;

    // Only <a> keeps attributes, and only a vetted href/title.
    if (name === "a") {
      const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/i.exec(rawAttrs);
      const raw = hrefMatch ? (hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? "") : "";
      const href = raw ? safeHref(raw) : null;
      if (!href) return "<a>";
      // External links get noopener/noreferrer.
      return `<a href="${escapeText(href)}" rel="noopener noreferrer nofollow" target="_blank">`;
    }

    return `<${name}>`;
  });
}
