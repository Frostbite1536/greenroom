/**
 * How a proposal's speaker roster reads (ABS-11).
 *
 * A co-speaker's contribution — "Co-presenter", "Panellist" — is stored per
 * proposal on `AbstractSpeaker.role`, and the reviewing organizer is the person
 * it exists for: it is the difference between two names and a named line-up.
 * Pure so the phrasing is asserted rather than eyeballed on a rendered drawer.
 */
export type ProposalSpeaker = {
  name: string;
  isPrimary: boolean;
  role?: string | null;
};

/**
 * One speaker, described exactly as much as the record allows.
 *
 * "(primary)" is structural and always shown; the role is shown only when the
 * submitter actually stated one. A stated role never replaces the primary
 * marker — an organizer needs to know both who leads the talk and what each
 * person does on it.
 */
export function proposalSpeakerLabel(speaker: ProposalSpeaker): string {
  const role = speaker.role?.trim();
  const parts = [speaker.name];
  if (speaker.isPrimary) parts.push("(primary)");
  if (role) parts.push(`— ${role}`);
  return parts.join(" ");
}

/**
 * The whole roster on one line, or an em dash when a proposal somehow has no
 * speakers at all. Order is the caller's: the stored roster order is the one
 * the submitter chose.
 */
export function proposalRosterLine(speakers: readonly ProposalSpeaker[]): string {
  if (speakers.length === 0) return "—";
  return speakers.map(proposalSpeakerLabel).join(", ");
}

/**
 * The co-speaker summary under the primary name in the abstracts table.
 * Names the roles when they are stated and distinct, and falls back to a plain
 * count when they are not — a list of three identical "Co-presenter" labels
 * tells an organizer less than "+3 co-speakers" does.
 */
export function coSpeakerSummary(speakers: readonly ProposalSpeaker[]): string | null {
  const primaryIndex = speakers.findIndex((speaker) => speaker.isPrimary);
  const others = speakers.filter((_, index) => index !== (primaryIndex === -1 ? 0 : primaryIndex));
  if (others.length === 0) return null;

  const roles = others.map((speaker) => speaker.role?.trim()).filter((role): role is string => Boolean(role));
  const distinct = [...new Set(roles)];
  const noun = others.length === 1 ? "co-speaker" : "co-speakers";
  if (roles.length === others.length && distinct.length === others.length) {
    return `+${others.length} ${noun}: ${roles.join(", ")}`;
  }
  return `+${others.length} ${noun}`;
}
