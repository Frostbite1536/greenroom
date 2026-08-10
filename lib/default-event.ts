/**
 * The one pinned default event.
 *
 * This module deliberately has NO imports. It exists so the pinned slug can be
 * read by pure policy modules (sign-in landing) as well as by the database-
 * backed public reads, without either pulling the other's dependencies in.
 *
 * The pin is an EXPLICIT slug, never "whichever event sorts or was created
 * first". That is the property D-C5-9 depends on: admin event creation must
 * never be able to displace the judged programme on `/` or the embeds. An
 * order-sensitive default would silently hand `/` to a brand-new empty event.
 */
export const DEFAULT_PUBLIC_EVENT = "forward-2026";
