import Link from "next/link";
import { ArrowRight, Megaphone } from "lucide-react";
import { OPEN_CFP_LABELS, type OpenCfpEntry } from "@/lib/data/open-cfp";

/**
 * The one rendered "Submit a talk" entry point (Architect decision D-C5-3).
 *
 * Every surface renders this same component from the same projection, so the
 * three states are identical everywhere:
 *   none → a visible, honest no-open-CFP message and no link at all;
 *   one  → a direct link to the canonical public form path;
 *   many → a chooser listing every open call in the projection's order.
 *
 * Server component: it takes an already-resolved entry and adds no client JS.
 */
export function OpenCfpEntryPanel({
  entry,
  id = "open-cfp",
  compact = false,
}: {
  entry: OpenCfpEntry;
  /** Unique per page — the heading id it derives labels the section. */
  id?: string;
  /** Denser presentation for a secondary surface such as a resource article. */
  compact?: boolean;
}) {
  const headingId = `${id}-heading`;
  const eventName = entry.event?.name ?? null;
  const [only] = entry.forms;

  return (
    <section
      className={`open-cfp${compact ? " open-cfp-compact" : ""}`}
      aria-labelledby={headingId}
    >
      <h2 className="open-cfp-heading" id={headingId}>
        <Megaphone size={17} aria-hidden="true" />
        <span>{OPEN_CFP_LABELS.heading}</span>
      </h2>

      {entry.state === "none" ? (
        <p className="open-cfp-empty">
          {eventName
            ? `There is no open call for proposals for ${eventName} right now.`
            : "There is no open call for proposals right now."}{" "}
          When submissions open, the form will be linked here.
        </p>
      ) : null}

      {entry.state === "one" && only ? (
        <>
          <p className="open-cfp-meta">
            {eventName ? `${eventName} is accepting proposals.` : "Proposals are open."}
          </p>
          <Link className="open-cfp-cta" href={only.href}>
            <span>Submit to {only.name}</span>
            <ArrowRight size={15} aria-hidden="true" />
          </Link>
          <p className="open-cfp-meta">
            {only.closesAtLabel
              ? `Submissions close ${only.closesAtLabel}.`
              : "No closing date has been announced."}
          </p>
        </>
      ) : null}

      {entry.state === "many" ? (
        <>
          <p className="open-cfp-meta">{OPEN_CFP_LABELS.chooserLead}</p>
          <ul className="open-cfp-list">
            {entry.forms.map((form) => (
              <li key={form.id}>
                <Link className="open-cfp-choice" href={form.href}>
                  <span>{form.name}</span>
                  <ArrowRight size={15} aria-hidden="true" />
                </Link>
                <span className="open-cfp-meta">
                  {form.closesAtLabel
                    ? `Closes ${form.closesAtLabel}`
                    : "No closing date announced"}
                </span>
              </li>
            ))}
          </ul>
          {entry.truncated ? (
            <p className="open-cfp-meta">
              Showing the first {entry.forms.length} open calls for proposals.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
