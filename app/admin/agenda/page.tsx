import { PagePlaceholder } from "@/components/page-placeholder";

export default function AgendaPage() {
  return <PagePlaceholder eyebrow="Program operations" title="Agenda builder" description="Place confirmed sessions across days, rooms, and tracks while catching speaker and room conflicts immediately." metrics={[{ label: "Scheduled", value: "42" }, { label: "Unscheduled", value: "11" }, { label: "Conflicts", value: "2" }]} nextSteps={["Add day, room, track, and list modes.", "Implement accessible session placement.", "Surface room and speaker overlap conflicts inline."]} />;
}
