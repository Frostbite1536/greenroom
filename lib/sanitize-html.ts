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
  //
  // Done as an explicit scan rather than one `String.replace`, because what is
  // BETWEEN the matches matters as much as the matches themselves. The tag
  // pattern requires a closing `>`, so a half-open `<img src=x onerror=alert(1)`
  // matched nothing and used to be copied through byte-for-byte. Every caller of
  // this function then concatenates the result with more HTML
  // (`lib/comms/notifications.ts` puts trusted paragraphs after an admin note),
  // and the next part's first `>` closes the tag the sanitizer declined to see —
  // with `alert(1)<p` as its `onerror`, which still runs.
  //
  // So the inter-tag text is escaped on its own: after this walk the only `<`
  // left in the output is one this function emitted for an allowlisted tag.
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let out = "";
  let cursor = 0;
  for (let match = tagPattern.exec(html); match !== null; match = tagPattern.exec(html)) {
    out += escapeStrayMarkup(html.slice(cursor, match.index));
    out += emitTag(match[0], match[1], match[2]);
    cursor = match.index + match[0].length;
  }
  return out + escapeStrayMarkup(html.slice(cursor));
}

/**
 * Text that is not part of any tag this sanitizer recognised.
 *
 * Only `<` is rewritten. A stray `>` cannot open anything, and escaping it
 * would churn every existing resource template and email body for no gain.
 */
function escapeStrayMarkup(text: string): string {
  return text.replace(/</g, "&lt;");
}

function emitTag(match: string, rawName: string, rawAttrs: string): string {
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
}
