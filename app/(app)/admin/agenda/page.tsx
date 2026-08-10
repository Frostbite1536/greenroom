import "@/components/feature.css";
import { PageHeader } from "@/components/ui";
import { AgendaBuilder } from "@/components/agenda-builder";
import { getAgendaData } from "@/lib/data/reads";
import { boundedCount } from "@/lib/bounded-count";

export const metadata = { title: "Agenda" };
export const dynamic = "force-dynamic";

export default async function AgendaPage() {
  const data = await getAgendaData();
  const scheduled = data.sessions.filter((s) => s.slot !== null).length;

  return (
    <section className="page-stack" style={{ width: "min(1280px, 100%)" }}>
      <PageHeader
        eyebrow="Program"
        title="Agenda"
        description="Build the schedule across rooms and tracks with live room and speaker conflict detection."
      />
      <div className="metric-grid">
        {/* Both session figures are counted off the capped read, so past the cap
            they are floors. Rooms and tracks come from their own uncapped reads
            and stay exact. The builder below states the cut in full. */}
        <div className="metric"><span>Scheduled</span><strong>{boundedCount(scheduled, data.truncated)}</strong></div>
        <div className="metric">
          <span>Unscheduled</span>
          <strong>{boundedCount(data.sessions.length - scheduled, data.truncated)}</strong>
        </div>
        <div className="metric"><span>Rooms · Tracks</span><strong>{data.rooms.length} · {data.tracks.length}</strong></div>
      </div>
      <AgendaBuilder data={data} />
    </section>
  );
}
