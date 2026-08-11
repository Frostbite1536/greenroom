/**
 * Server-only projection of the events the signed-in user may switch into
 * (D-C5-16 item 1).
 *
 * This lives beside `lib/data/open-cfp.ts` and is shaped the same way: a pure
 * ordering/selection half that tests exercise directly, and a typed Prisma seam
 * behind it. It is the single authority for what the workspace switcher lists.
 *
 * Scope rules, all load-bearing:
 * - It is keyed on the caller's own `userId`. It can therefore only ever return
 *   the caller's own memberships — it is not an event directory, and no surface
 *   may pass another user's id into it.
 * - It exposes only what the switcher renders: the event's id, name and slug,
 *   plus the caller's role *on that event*. No counts, no dates, no other
 *   member. Listing an event here does not grant anything: the switch route
 *   re-checks the membership server-side before any cookie is re-issued.
 */
import { cache } from "react";
import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Safety bound on the switcher's read, in the spirit of `OPEN_CFP_LIST_TAKE`.
 * A sidebar control is not a paginated screen, so an identity past this bound
 * reports `truncated` and the shell says so rather than silently dropping
 * workspaces.
 */
export const WORKSPACE_LIST_TAKE = 25;

/** One event the caller belongs to, reduced to what the switcher may render. */
export type Workspace = {
  id: string;
  name: string;
  slug: string;
  /** The caller's role on THIS event — it may differ from their current one. */
  role: UserRole;
};

export type WorkspaceList = {
  workspaces: Workspace[];
  truncated: boolean;
};

export const EMPTY_WORKSPACE_LIST: WorkspaceList = { workspaces: [], truncated: false };

/** The raw row shape the ordering is defined over. */
export type WorkspaceCandidate = {
  role: UserRole;
  event: { id: string; name: string; slug: string };
};

/**
 * Stable switcher order: event name ascending, then id ascending as the
 * tie-break. Comparison is codepoint-ordered rather than locale-collated so two
 * servers in different locales render the same list — the same rule
 * `compareOpenCfpCandidates` follows.
 */
export function compareWorkspaces(a: Workspace, b: Workspace): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** Pure selection: project, order, bound. */
export function selectWorkspaces(
  candidates: readonly WorkspaceCandidate[],
  take: number = WORKSPACE_LIST_TAKE,
): WorkspaceList {
  const ordered = candidates
    .map((row) => ({ id: row.event.id, name: row.event.name, slug: row.event.slug, role: row.role }))
    .sort(compareWorkspaces);
  const visible = ordered.slice(0, Math.max(take, 0));
  return { workspaces: visible, truncated: ordered.length > visible.length };
}

/**
 * Typed data seam. Production delegates to Prisma; tests exercise the selection
 * without opening a database connection.
 */
export type WorkspaceReaderClient = {
  listMemberships(query: { userId: string; take: number }): Promise<readonly WorkspaceCandidate[]>;
};

const prismaWorkspaceReaderClient: WorkspaceReaderClient = {
  async listMemberships({ userId, take }) {
    return prisma.eventMember.findMany({
      where: { userId },
      orderBy: [{ event: { name: "asc" } }, { eventId: "asc" }],
      take,
      select: { role: true, event: { select: { id: true, name: true, slug: true } } },
    });
  },
};

export async function readUserWorkspaces(
  userId: string,
  client: WorkspaceReaderClient = prismaWorkspaceReaderClient,
): Promise<WorkspaceList> {
  if (!userId) return EMPTY_WORKSPACE_LIST;
  const rows = await client.listMemberships({
    userId,
    // One past the bound so `truncated` is observed rather than inferred.
    take: WORKSPACE_LIST_TAKE + 1,
  });
  return selectWorkspaces(rows);
}

/**
 * Request-deduplicated read: the workspace layout renders the switcher on every
 * page below it, and `cache()` collapses that into one query per request.
 */
export const getUserWorkspaces = cache(async function getUserWorkspaces(
  userId: string,
): Promise<WorkspaceList> {
  return readUserWorkspaces(userId);
});
