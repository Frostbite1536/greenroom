import { redirect } from "next/navigation";
import { Users } from "lucide-react";
import "@/components/feature.css";
import { EmptyState, PageHeader, Pill } from "@/components/ui";
import { getApiContext } from "@/lib/api/context";
import { prisma } from "@/lib/prisma";
import { formatEventDateTime } from "@/lib/tz";
import { readEventTeam } from "@/lib/data/event-team";
import { TEAM_ROLE_DESCRIPTIONS, TEAM_ROLE_LABELS } from "@/lib/team/roles";
import { AddTeamMemberDialog, TeamMemberActions } from "@/components/event-team-manager";

export const metadata = { title: "Event team" };
export const dynamic = "force-dynamic";

/**
 * Everyone with a membership on this event, and the only surface that changes
 * one (INV-EVENT-001).
 *
 * Server-rendered like every other admin screen, with page-level auth that
 * redirects rather than throws. The redirect is presentation: the write routes
 * behind the dialogs re-read the caller's ADMIN row inside their own
 * transaction, so reaching this page never grants anything.
 *
 * This lists `EventMember` rows and nothing else. That is deliberately a
 * different set from `/admin/speakers`, which unions memberships with
 * `SessionSpeaker` — a speaker who arrived through an accepted abstract has a
 * session but no membership row, and so has nothing here to change. The two
 * screens are not two views of one list, and the copy below says which is which
 * rather than letting an organizer read a shorter table as people going missing.
 */

/** Pills that mirror `TEAM_ROLE_LABELS`; tone tracks authority, not health. */
const ROLE_TONE: Record<string, string> = { ADMIN: "info", EVALUATOR: "neutral", SPEAKER: "neutral" };

export default async function AdminTeamPage() {
  // Page-level auth: redirect rather than throw, matching the other admin pages.
  const ctx = await getApiContext();
  if (!ctx) redirect("/login");
  if (ctx.role !== "ADMIN") redirect("/portal");

  const [team, event] = await Promise.all([
    readEventTeam(ctx.eventId),
    prisma.event.findUnique({ where: { id: ctx.eventId }, select: { timezone: true } }),
  ]);
  // A missing timezone means the event id names no event; redirect rather than
  // render a team against a row that is not there.
  if (!event) redirect("/login");
  const timezone = event.timezone;

  const reviewers = team.members.filter((member) => member.role === "EVALUATOR").length;
  const speakers = team.members.filter((member) => member.role === "SPEAKER").length;

  return (
    <section className="page-stack" style={{ width: "min(1080px, 100%)" }}>
      <PageHeader
        eyebrow="Event setup"
        title="Event team"
        description="Everyone with access to this event, and what that access is. Roles are stored per event and re-read on every request, so a change here takes effect immediately."
        actions={<AddTeamMemberDialog />}
      />

      <div className="metric-grid">
        <div className="metric"><span>Organizers</span><strong>{team.adminCount}</strong></div>
        <div className="metric"><span>Reviewers</span><strong>{reviewers}</strong></div>
        <div className="metric"><span>Named speakers</span><strong>{speakers}</strong></div>
      </div>

      {team.adminCount === 1 ? (
        <p className="hint" role="status">
          This event has one organizer. If that account is lost there is no way to grant the role back —
          nobody but an organizer can add one. Add a second organizer before you need to.
        </p>
      ) : null}

      {team.truncated ? (
        <p className="hint" role="status">
          This event has more members than this page loads at once. The list below is incomplete — the
          organizer count above is read separately and stays correct.
        </p>
      ) : null}

      <div className="card">
        {team.members.length === 0 ? (
          <EmptyState icon={<Users size={20} aria-hidden="true" />} title="No members on this event yet">
            Add an organizer or a reviewer above.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <caption className="sr-only">Event team members with their role and join date</caption>
              <thead>
                <tr>
                  <th scope="col">Member</th>
                  <th scope="col">Role</th>
                  <th scope="col">Joined</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {team.members.map((member) => {
                  const isSelf = member.userId === ctx.userId;
                  return (
                    <tr key={member.userId}>
                      <td>
                        <div className="cell-title">
                          {member.name}
                          {isSelf ? <span className="muted"> (you)</span> : null}
                        </div>
                        <div className="cell-sub">{member.email}</div>
                      </td>
                      <td>
                        <Pill tone={ROLE_TONE[member.role] ?? "neutral"}>{TEAM_ROLE_LABELS[member.role]}</Pill>
                        <div className="cell-sub">{TEAM_ROLE_DESCRIPTIONS[member.role]}</div>
                      </td>
                      <td>
                        {/* The event's own zone, so it matches every other date
                            an organizer reads on this workspace (C12). */}
                        {formatEventDateTime(member.joinedAt, timezone) ?? <span className="muted">Unknown</span>}
                      </td>
                      <td>
                        <TeamMemberActions
                          member={{
                            userId: member.userId,
                            name: member.name,
                            email: member.email,
                            role: member.role,
                            joined: formatEventDateTime(member.joinedAt, timezone) ?? "",
                            isSelf,
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="hint">
        Speakers who arrived through an accepted proposal appear on{" "}
        <strong>Speaker onboarding</strong>, not here: their sessions are recorded against the programme
        rather than against a membership. This screen lists only people who hold a role on the event.
      </p>
    </section>
  );
}
