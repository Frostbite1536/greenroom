import { notFound } from "next/navigation";
import "@/components/feature.css";
import { EmbedSchedule } from "@/components/embed-schedule";
import { getPublicAgenda } from "@/lib/data/reads";

export const dynamic = "force-dynamic";

type ScheduleSearchParams = { event?: string; track?: string; day?: string; q?: string };

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<ScheduleSearchParams>;
}) {
  const { event } = await searchParams;
  const agenda = await getPublicAgenda(event);
  return {
    title: agenda ? `${agenda.event.name} — Schedule` : "Schedule",
    description: agenda ? `Public session schedule for ${agenda.event.name}.` : undefined,
  };
}

export default async function EmbedSchedulePage({
  searchParams,
}: {
  searchParams: Promise<ScheduleSearchParams>;
}) {
  const { event, track, day, q } = await searchParams;
  const agenda = await getPublicAgenda(event);
  if (!agenda) notFound();
  // `event` is echoed back into every generated link verbatim, so a host page's
  // slug-or-id choice survives filtering, search and day switching.
  return <EmbedSchedule agenda={agenda} eventParam={event} searchParams={{ track, day, q }} />;
}
