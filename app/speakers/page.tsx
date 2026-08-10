import {
  SpeakersProgramme,
  speakersMetadata,
  type SpeakersSearchParams,
} from "@/components/programme-pages";

export const dynamic = "force-dynamic";

/**
 * The canonical public speaker directory. Same reversal as `/schedule`: served
 * here with the site header, while `/embed/speakers` stays the frameable
 * variant of the identical component tree.
 */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SpeakersSearchParams>;
}) {
  return speakersMetadata(searchParams);
}

export default async function SpeakersPage({
  searchParams,
}: {
  searchParams: Promise<SpeakersSearchParams>;
}) {
  return <SpeakersProgramme searchParams={searchParams} surface="canonical" />;
}
