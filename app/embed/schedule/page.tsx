import { PagePlaceholder } from "@/components/page-placeholder";

export default function EmbedSchedulePage() {
  return <PagePlaceholder eyebrow="Public embed" title="Forward 2026 schedule" description="A responsive, shareable agenda surface with calendar downloads and track-aware filtering." metrics={[{ label: "Sessions", value: "42" }, { label: "Speakers", value: "58" }, { label: "Tracks", value: "4" }]} nextSteps={["Render a mobile-first public schedule.", "Add speaker gallery embed route.", "Connect per-session .ics downloads."]} />;
}
