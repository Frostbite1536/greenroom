import { notFound } from "next/navigation";
import "@/components/feature.css";
import { EmbedSpeakers } from "@/components/embed-speakers";
import { getPublicSpeakers } from "@/lib/data/reads";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ event?: string }>;
}) {
  const { event } = await searchParams;
  const gallery = await getPublicSpeakers(event);
  return {
    title: gallery ? `${gallery.event.name} — Speakers` : "Speakers",
    description: gallery ? `Public speaker lineup for ${gallery.event.name}.` : undefined,
  };
}

export default async function EmbedSpeakersPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string; q?: string; track?: string }>;
}) {
  const { event, q, track } = await searchParams;
  const gallery = await getPublicSpeakers(event);
  if (!gallery) notFound();
  return <EmbedSpeakers gallery={gallery} initialQuery={q ?? ""} initialTrack={track ?? "all"} />;
}
