/**
 * The public programme, rendered once and served at two URLs.
 *
 * `/schedule` and `/speakers` are the canonical pages a visitor guesses and a
 * crawler indexes; `/embed/schedule` and `/embed/speakers` are the same thing
 * without the site header, for a host page's iframe. Rather than redirect one
 * at the other — which would either strip the chrome off the canonical page or
 * break framing for the embed — both route files delegate here and differ only
 * by `surface`.
 *
 * That keeps the smallest honest structure: one read, one component tree, one
 * place where a filter link's base path is decided.
 */
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import "@/components/feature.css";
import { EmbedSchedule } from "@/components/embed-schedule";
import { EmbedSpeakers } from "@/components/embed-speakers";
import { PublicChrome } from "@/components/public-chrome";
import { getPublicAgenda, getPublicSpeakers } from "@/lib/data/reads";
import { schedulePathFor, speakersPathFor, type ProgrammeSurface } from "@/lib/embed-alias";

export type ScheduleSearchParams = { event?: string; track?: string; day?: string; q?: string };
export type SpeakersSearchParams = { event?: string; q?: string; track?: string };

export async function scheduleMetadata(
  searchParams: Promise<ScheduleSearchParams>,
): Promise<Metadata> {
  const { event } = await searchParams;
  const agenda = await getPublicAgenda(event);
  return {
    title: agenda ? `${agenda.event.name} — Schedule` : "Schedule",
    description: agenda ? `Public session schedule for ${agenda.event.name}.` : undefined,
  };
}

export async function speakersMetadata(
  searchParams: Promise<SpeakersSearchParams>,
): Promise<Metadata> {
  const { event } = await searchParams;
  const gallery = await getPublicSpeakers(event);
  return {
    title: gallery ? `${gallery.event.name} — Speakers` : "Speakers",
    description: gallery ? `Public speaker lineup for ${gallery.event.name}.` : undefined,
  };
}

export async function ScheduleProgramme({
  searchParams,
  surface,
}: {
  searchParams: Promise<ScheduleSearchParams>;
  surface: ProgrammeSurface;
}) {
  const { event, track, day, q } = await searchParams;
  const agenda = await getPublicAgenda(event);
  if (!agenda) notFound();

  // `event` is echoed back into every generated link verbatim, so a host page's
  // slug-or-id choice survives filtering, search and day switching.
  const schedule = (
    <EmbedSchedule
      agenda={agenda}
      eventParam={event}
      searchParams={{ track, day, q }}
      basePath={schedulePathFor(surface)}
      speakersPath={speakersPathFor(surface)}
    />
  );

  if (surface === "embed") return schedule;
  return <PublicChrome eventParam={event} active="schedule">{schedule}</PublicChrome>;
}

export async function SpeakersProgramme({
  searchParams,
  surface,
}: {
  searchParams: Promise<SpeakersSearchParams>;
  surface: ProgrammeSurface;
}) {
  const { event, q, track } = await searchParams;
  const gallery = await getPublicSpeakers(event);
  if (!gallery) notFound();

  const speakers = (
    <EmbedSpeakers
      gallery={gallery}
      initialQuery={q ?? ""}
      initialTrack={track ?? "all"}
      eventParam={event}
      basePath={speakersPathFor(surface)}
      schedulePath={schedulePathFor(surface)}
    />
  );

  if (surface === "embed") return speakers;
  return <PublicChrome eventParam={event} active="speakers">{speakers}</PublicChrome>;
}
