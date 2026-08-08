import "@/components/feature.css";
import { PageHeader } from "@/components/ui";
import { AgendaBuilder } from "@/components/agenda-builder";
import { EVENT_META, ROOMS, SLOTS, TRACKS } from "@/lib/fixtures";

export const metadata = { title: "Agenda · Sessionboard" };

export default function AgendaPage() {
  return (
    <section className="page-stack" style={{ width: "min(1280px, 100%)" }}>
      <PageHeader
        eyebrow="Program"
        title="Agenda"
        description={`Build the ${EVENT_META.name} schedule across rooms and tracks with live room and speaker conflict detection.`}
      />
      <div className="metric-grid">
        <div className="metric"><span>Scheduled</span><strong>{SLOTS.length}</strong></div>
        <div className="metric"><span>Rooms</span><strong>{ROOMS.length}</strong></div>
        <div className="metric"><span>Tracks</span><strong>{TRACKS.length}</strong></div>
      </div>
      <AgendaBuilder />
    </section>
  );
}
