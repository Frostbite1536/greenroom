import Link from "next/link";
import {
  BarChart3,
  BookOpen,
  CalendarDays,
  ClipboardCheck,
  Code2,
  FileStack,
  FileText,
  Gauge,
  LayoutDashboard,
  LogOut,
  MailCheck,
  Megaphone,
  Mic2,
  SlidersHorizontal,
  Settings2,
  UserCheck,
  Users,
  UsersRound,
} from "lucide-react";
import { homeForRole, type DemoSession } from "@/lib/auth";
import { logout } from "@/app/login/actions";
import { MobileNavigation } from "@/components/mobile-navigation";
import { openCfpNavItems, type OpenCfpEntry } from "@/lib/data/open-cfp";
import { EMPTY_WORKSPACE_LIST, type WorkspaceList } from "@/lib/data/event-memberships";

const ROLE_LABELS: Record<DemoSession["role"], string> = {
  ADMIN: "Event admin",
  EVALUATOR: "Evaluator",
  SPEAKER: "Speaker",
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

type Role = DemoSession["role"];

const EVERYONE: Role[] = ["ADMIN", "EVALUATOR", "SPEAKER"];

type NavGroup = "overview" | "cfp" | "programme" | "communications" | "public" | "configure";

type NavItem = { href: string; label: string; icon: typeof FileText; roles: Role[]; group: NavGroup };

/**
 * The labelled blocks the sidebar renders, in the order it renders them.
 *
 * Fourteen destinations in one flat column read as a list to be searched rather
 * than a workspace to be navigated, so each entry below names the stage of the
 * organizer's job it belongs to. This is presentation only: a group carries no
 * authorization and no destination, `roles` below is still the only thing that
 * decides what a session sees, and a group with no visible entry for the
 * current role renders nothing at all rather than an empty heading.
 *
 * Adding a destination is one line in `navigation` naming its `group`.
 */
const NAV_GROUPS: { key: NavGroup; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "cfp", label: "Call for proposals" },
  { key: "programme", label: "Program" },
  { key: "communications", label: "Communications" },
  { key: "public", label: "Public site" },
  { key: "configure", label: "Configure" },
];

/**
 * `roles` mirrors the server-side authorization each destination already
 * enforces (`pageContext()` in `lib/data/reads.ts`, `requireSession()` in the
 * portal), so the sidebar never advertises a page that would bounce the user
 * back to `/login`. This is presentation only — authorization is unchanged.
 */
const navigation: NavItem[] = [
  // First in the admin group: it is the organizer's landing view and every other
  // admin entry below is one of the workspaces it links into. ADMIN-only,
  // mirroring `pageContext(["ADMIN"])` in `getAdminDashboard()`.
  { href: "/admin", label: "Dashboard", icon: Gauge, roles: ["ADMIN"], group: "overview" },
  // Second: the dashboard's counterpart. Where Dashboard says how the programme
  // stands, Reports says how the process performed, and it owns the CSV exports.
  // ADMIN-only, mirroring `pageContext(["ADMIN"])` in `getAdminReports()`.
  { href: "/admin/reports", label: "Reports", icon: BarChart3, roles: ["ADMIN"], group: "overview" },
  { href: "/admin/forms", label: "CFP forms", icon: FileText, roles: ["ADMIN"], group: "cfp" },
  { href: "/admin/abstracts", label: "Abstracts", icon: FileStack, roles: ["ADMIN"], group: "cfp" },
  { href: "/admin/evaluations", label: "Evaluations", icon: ClipboardCheck, roles: ["ADMIN", "EVALUATOR"], group: "cfp" },
  { href: "/admin/agenda", label: "Agenda builder", icon: LayoutDashboard, roles: ["ADMIN"], group: "programme" },
  { href: "/admin/speakers", label: "Speaker onboarding", icon: UserCheck, roles: ["ADMIN"], group: "programme" },
  // Beside speaker onboarding, because both author what a speaker meets in the
  // portal: the checklist they must finish, and the pages that tell them how.
  // ADMIN-only, mirroring the page's own `ctx.role !== "ADMIN"` redirect.
  { href: "/admin/resources", label: "Resources & wiki", icon: BookOpen, roles: ["ADMIN"], group: "programme" },
  { href: "/admin/operations", label: "Operations", icon: Settings2, roles: ["ADMIN"], group: "communications" },
  { href: "/admin/emails", label: "Email history", icon: MailCheck, roles: ["ADMIN"], group: "communications" },
  // What an attendee or a speaker sees, gathered so an organizer checking their
  // published programme does not have to pick the four "view as" destinations
  // out of the operator entries around them.
  { href: "/admin/embeds", label: "Website embeds", icon: Code2, roles: ["ADMIN"], group: "public" },
  { href: "/embed/schedule", label: "Public schedule", icon: CalendarDays, roles: EVERYONE, group: "public" },
  { href: "/embed/speakers", label: "Public speakers", icon: Mic2, roles: EVERYONE, group: "public" },
  { href: "/portal", label: "Speaker portal", icon: Users, roles: ["ADMIN", "SPEAKER"], group: "public" },
  { href: "/admin/settings", label: "Event settings", icon: SlidersHorizontal, roles: ["ADMIN"], group: "configure" },
  // Beside Event settings: both configure the event itself rather than its
  // programme. ADMIN-only, mirroring the page's own `ctx.role !== "ADMIN"` check.
  { href: "/admin/team", label: "Event team", icon: UsersRound, roles: ["ADMIN"], group: "configure" },
];

/**
 * Roles that see the speaker-facing "Submit a talk" entry. Mirrors the speaker
 * portal's own role set so an organizer can still reach the public call they
 * published. The destinations are public pages, so this is presentation only.
 */
const SUBMIT_ENTRY_ROLES: Role[] = ["ADMIN", "SPEAKER"];

/**
 * The workspace switcher (D-C5-16 item 1).
 *
 * A plain form post to the real endpoint, so it works with JavaScript off and
 * an API client uses the same path the UI does — the same shape the login
 * page's credential form takes. Nothing here is authorization: the route
 * re-checks the membership server-side before it re-issues anything, and this
 * list is already the caller's own memberships.
 *
 * With exactly one membership the control is not rendered at all. A dropdown
 * whose only option is the option you are already on is a promise of a choice
 * that does not exist; the current-event line above it already says everything
 * a single-event organizer needs.
 */
function EventSwitcher({ session, list }: { session: DemoSession; list: WorkspaceList }) {
  if (list.workspaces.length <= 1) return null;
  return (
    <form action="/api/auth/switch-event" className="event-switch-form" method="post">
      <label className="sr-only" htmlFor="event-switch-select">Switch event</label>
      <select
        className="event-switch-select"
        defaultValue={session.event.id}
        id="event-switch-select"
        name="eventId"
      >
        {list.workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name} · {ROLE_LABELS[workspace.role]}
          </option>
        ))}
      </select>
      <button className="event-switch-button" type="submit">Switch</button>
      {list.truncated ? (
        <span className="event-switch-note">Showing your first {list.workspaces.length} events.</span>
      ) : null}
    </form>
  );
}

export function AppShell({
  session,
  openCfp,
  workspaces = EMPTY_WORKSPACE_LIST,
  children,
}: {
  session: DemoSession;
  /** D-C5-3 entry projection; `null` hides the entry for non-speaker roles. */
  openCfp: OpenCfpEntry | null;
  /** The caller's own memberships (D-C5-16); one or none renders no switcher. */
  workspaces?: WorkspaceList;
  children: React.ReactNode;
}) {
  const links = navigation.filter((item) => item.roles.includes(session.role));
  // Zero open calls still renders a visible, destination-free entry rather than
  // a dead link (D-C5-3); two or more render one entry each and never collapse.
  const cfpItems =
    openCfp && SUBMIT_ENTRY_ROLES.includes(session.role) ? openCfpNavItems(openCfp) : [];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href={homeForRole(session.role)} aria-label="Greenroom home">
          <span className="brand-mark"><Mic2 size={18} aria-hidden="true" /></span>
          <span>Greenroom</span>
        </Link>
        <div className="event-switcher">
          <span className="event-label">Current event</span>
          <strong>{session.event.name}</strong>
          <EventSwitcher list={workspaces} session={session} />
        </div>
        <nav aria-label="Workspace navigation">
          {NAV_GROUPS.map(({ key, label }) => {
            const group = links.filter((item) => item.group === key);
            // A role that reaches nothing in this group gets no heading for it.
            if (group.length === 0) return null;
            return (
              <div
                aria-labelledby={`nav-group-${key}`}
                className="nav-group"
                key={key}
                role="group"
              >
                <p className="nav-group-label" id={`nav-group-${key}`}>{label}</p>
                {group.map(({ href, label: entry, icon: Icon }) => (
                  <Link className="nav-link" href={href} key={href}>
                    <Icon size={17} aria-hidden="true" />
                    <span>{entry}</span>
                  </Link>
                ))}
              </div>
            );
          })}
        </nav>
        {cfpItems.length > 0 ? (
          <nav aria-label="Call for proposals" className="nav-cfp">
            {cfpItems.map((item, index) =>
              item.href ? (
                <Link className="nav-link" href={item.href} key={item.href}>
                  <Megaphone size={17} aria-hidden="true" />
                  <span>{item.label}</span>
                </Link>
              ) : (
                <p className="nav-link nav-static" key={`no-open-cfp-${index}`}>
                  <Megaphone size={17} aria-hidden="true" />
                  <span>{item.label}</span>
                </p>
              ),
            )}
          </nav>
        ) : null}
        <div className="sidebar-footer">
          <div className="avatar" aria-hidden="true">{initials(session.user.name)}</div>
          <div>
            <strong>{session.user.name}</strong>
            <span>{ROLE_LABELS[session.role]}</span>
          </div>
          <form action={logout} className="logout-form">
            <button className="icon-button" title="Sign out" type="submit" aria-label="Sign out">
              <LogOut size={16} aria-hidden="true" />
            </button>
          </form>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <MobileNavigation
            links={[...links.map(({ href, label }) => ({ href, label })), ...cfpItems]}
          />
          <span className="status-dot" aria-hidden="true" />
          <span>Planning workspace</span>
          <span className="topbar-spacer" />
          <span className="role-badge">{ROLE_LABELS[session.role]}</span>
        </header>
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}
