import "@/components/feature.css";
import { EmbedSchedule } from "@/components/embed-schedule";
import { EVENT_META } from "@/lib/fixtures";

export const metadata = {
  title: `${EVENT_META.name} Schedule`,
  description: `Public schedule for ${EVENT_META.name}.`,
};

export default function EmbedSchedulePage() {
  return <EmbedSchedule />;
}
