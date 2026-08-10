import { redirect } from "next/navigation";
import { CANONICAL_SCHEDULE_PATH, publicSurfaceUrl } from "@/lib/embed-alias";

export const dynamic = "force-dynamic";

/** Guessable alias for the canonical public schedule. */
export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string }>;
}) {
  const { event } = await searchParams;
  redirect(publicSurfaceUrl(CANONICAL_SCHEDULE_PATH, event));
}
