import { notFound, redirect } from "next/navigation";
import {
  canonicalPublicFormPath,
  resolveLegacyPublishedPublicForm,
} from "@/lib/services/public-form-resolver";

export const dynamic = "force-dynamic";
export const metadata = { title: "Submit a proposal" };

/**
 * Compatibility page for historic one-segment public URLs. `eventSlug` is
 * intentionally only a route-segment name here: it is passed as an opaque
 * legacy ID-or-slug token to the shared resolver before redirecting.
 */
export default async function LegacyPublicCfpPage({
  params,
}: {
  params: Promise<{ eventSlug: string }>;
}) {
  const { eventSlug: legacyFormIdOrSlug } = await params;
  const scope = await resolveLegacyPublishedPublicForm(legacyFormIdOrSlug);
  if (!scope) notFound();
  redirect(canonicalPublicFormPath(scope));
}
