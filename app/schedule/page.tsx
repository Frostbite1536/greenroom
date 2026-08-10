import { redirect } from "next/navigation";
import { embedAliasTarget } from "@/lib/embed-alias";

export const dynamic = "force-dynamic";

/** Guessable public alias for the canonical schedule embed. */
export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string }>;
}) {
  const { event } = await searchParams;
  redirect(embedAliasTarget("/embed/schedule", event));
}
