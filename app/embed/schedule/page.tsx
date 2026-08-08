import { notFound } from "next/navigation";
import "@/components/feature.css";
import { EmbedSchedule } from "@/components/embed-schedule";
import { getPublicAgenda } from "@/lib/data/reads";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ event?: string }>;
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
  searchParams: Promise<{ event?: string }>;
}) {
  const { event } = await searchParams;
  const agenda = await getPublicAgenda(event);
  if (!agenda) notFound();
  return <EmbedSchedule agenda={agenda} />;
}
