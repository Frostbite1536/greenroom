import {
  ScheduleProgramme,
  scheduleMetadata,
  type ScheduleSearchParams,
} from "@/components/programme-pages";

export const dynamic = "force-dynamic";

/**
 * The frameable schedule: the canonical `/schedule` page's exact component
 * tree with the standalone site header omitted, so a host page can drop it in
 * an iframe without inheriting a second brand bar. Rendered rather than
 * redirected — a redirect either way would break one of the two use cases.
 */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<ScheduleSearchParams>;
}) {
  return scheduleMetadata(searchParams);
}

export default async function EmbedSchedulePage({
  searchParams,
}: {
  searchParams: Promise<ScheduleSearchParams>;
}) {
  return <ScheduleProgramme searchParams={searchParams} surface="embed" />;
}
