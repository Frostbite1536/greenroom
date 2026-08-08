import { headers } from "next/headers";
import "@/components/feature.css";
import { PageHeader } from "@/components/ui";
import { EmbedSnippets, type EmbedSnippet } from "@/components/embed-snippets";
import { getEmbedTargets } from "@/lib/data/reads";

export const metadata = { title: "Embeds" };
export const dynamic = "force-dynamic";

/**
 * Snippets must carry an absolute URL or they break the moment they are pasted
 * into another origin. Prefer the configured canonical `APP_URL` (same value the
 * `.ics` builder uses), then fall back to the forwarded request host so local
 * and preview deployments still produce working code.
 */
async function resolveOrigin(): Promise<string> {
  const configured = process.env.APP_URL?.trim().replace(/\/$/, "");
  if (configured) return configured;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

function iframe(url: string, title: string, height: number): string {
  return [
    `<iframe`,
    `  src="${url}"`,
    `  title="${title}"`,
    `  width="100%"`,
    `  height="${height}"`,
    `  style="border:1px solid #e3e8e6;border-radius:10px"`,
    `  loading="lazy"`,
    `></iframe>`,
  ].join("\n");
}

export default async function EmbedsPage() {
  const { event, scheduledSessions, publicSpeakers } = await getEmbedTargets();
  const origin = await resolveOrigin();
  const query = `?event=${encodeURIComponent(event.slug)}`;

  const scheduleUrl = `${origin}/embed/schedule${query}`;
  const speakersUrl = `${origin}/embed/speakers${query}`;

  const snippets: EmbedSnippet[] = [
    {
      key: "schedule",
      title: "Public schedule",
      description:
        "Day-by-day agenda with track colours and per-session calendar export. Updates automatically as the agenda changes.",
      url: scheduleUrl,
      snippet: iframe(scheduleUrl, `${event.name} schedule`, 900),
      emptyWarning:
        scheduledSessions === 0
          ? "No sessions are scheduled yet, so this embed will render an empty state for visitors."
          : undefined,
    },
    {
      key: "speakers",
      title: "Speaker gallery",
      description:
        "Compact grid of confirmed speakers with search and track filters. Only speakers on accepted, scheduled sessions appear.",
      url: speakersUrl,
      snippet: iframe(speakersUrl, `${event.name} speakers`, 1000),
      emptyWarning:
        publicSpeakers === 0
          ? "No speakers are on scheduled sessions yet, so this embed will render an empty state for visitors."
          : undefined,
    },
  ];

  return (
    <section className="page-stack" style={{ width: "min(920px, 100%)" }}>
      <PageHeader
        eyebrow="Publish"
        title="Website embeds"
        description="Drop the live schedule and speaker gallery into any marketing site or CMS. Both surfaces are public — no login, no API key."
      />

      <div className="metric-grid">
        <div className="metric"><span>Event</span><strong>{event.name}</strong></div>
        <div className="metric"><span>Scheduled sessions</span><strong>{scheduledSessions}</strong></div>
        <div className="metric"><span>Public speakers</span><strong>{publicSpeakers}</strong></div>
      </div>

      {origin === "" ? (
        <p className="conflict-banner" role="alert">
          Could not resolve this deployment&rsquo;s public origin. Set <code>APP_URL</code> so the
          snippets below contain absolute links.
        </p>
      ) : null}

      <EmbedSnippets snippets={snippets} />

      <div className="card" style={{ padding: 18 }}>
        <h2 style={{ margin: "0 0 6px", fontSize: 15 }}>Verifying from another origin</h2>
        <p className="hint">
          Both routes send no <code>X-Frame-Options</code> and set no cookies, so they frame cleanly
          from any host. A ready-made proof page lives in the repository at{" "}
          <code>docs/judging/embed-schedule-proof.html</code> — open it from the file system and the
          iframe above loads from the deployment.
        </p>
      </div>
    </section>
  );
}
