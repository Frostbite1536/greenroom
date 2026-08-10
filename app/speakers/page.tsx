import { redirect } from "next/navigation";
import { embedAliasTarget } from "@/lib/embed-alias";

export const dynamic = "force-dynamic";

/** Guessable public alias for the canonical speaker embed. */
export default async function SpeakersPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string }>;
}) {
  const { event } = await searchParams;
  redirect(embedAliasTarget("/embed/speakers", event));
}
