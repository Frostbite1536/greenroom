import "@/components/feature.css";
import { PageHeader } from "@/components/ui";
import { EventSettings } from "@/components/event-settings";
import { getEventSettings } from "@/lib/data/reads";

export const metadata = { title: "Event settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const view = await getEventSettings();

  return (
    <section className="page-stack" style={{ width: "min(1080px, 100%)" }}>
      <PageHeader
        eyebrow="Event setup"
        title="Event settings"
        description="Keep the essentials current: event dates and time zone, rooms, and the programme groupings your team already uses."
      />
      <EventSettings view={view} />
    </section>
  );
}
