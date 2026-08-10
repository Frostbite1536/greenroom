import {
  SpeakersProgramme,
  speakersMetadata,
  type SpeakersSearchParams,
} from "@/components/programme-pages";

export const dynamic = "force-dynamic";

/** The frameable speaker directory: `/speakers` without the site header. */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SpeakersSearchParams>;
}) {
  return speakersMetadata(searchParams);
}

export default async function EmbedSpeakersPage({
  searchParams,
}: {
  searchParams: Promise<SpeakersSearchParams>;
}) {
  return <SpeakersProgramme searchParams={searchParams} surface="embed" />;
}
