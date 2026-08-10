import {
  ScheduleProgramme,
  scheduleMetadata,
  type ScheduleSearchParams,
} from "@/components/programme-pages";

export const dynamic = "force-dynamic";

/**
 * The canonical public schedule.
 *
 * This used to redirect to `/embed/schedule`, which meant the guessable URL —
 * the one a visitor types and a crawler indexes — resolved to a chrome-free
 * fragment meant for an iframe. The programme is served here now, with the
 * site's own header; `/embed/schedule` renders the same component tree without
 * that header for host pages.
 */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<ScheduleSearchParams>;
}) {
  return scheduleMetadata(searchParams);
}

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<ScheduleSearchParams>;
}) {
  return <ScheduleProgramme searchParams={searchParams} surface="canonical" />;
}
