import Link from "next/link";
import {
  CalendarDays,
  ClipboardCheck,
  Code2,
  FileStack,
  FileText,
  LayoutDashboard,
  LogOut,
  Mic2,
  SlidersHorizontal,
  Settings2,
  UserCheck,
  Users,
} from "lucide-react";
import { homeForRole, type DemoSession } from "@/lib/auth";
import { logout } from "@/app/login/actions";
import { MobileNavigation } from "@/components/mobile-navigation";

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

/**
 * `roles` mirrors the server-side authorization each destination already
 * enforces (`pageContext()` in `lib/data/reads.ts`, `requireSession()` in the
 * portal), so the sidebar never advertises a page that would bounce the user
 * back to `/login`. This is presentation only — authorization is unchanged.
 */
const navigation: { href: string; label: string; icon: typeof FileText; roles: Role[] }[] = [
  { href: "/admin/forms", label: "CFP forms", icon: FileText, roles: ["ADMIN"] },
  { href: "/admin/abstracts", label: "Abstracts", icon: FileStack, roles: ["ADMIN"] },
  { href: "/admin/evaluations", label: "Evaluations", icon: ClipboardCheck, roles: ["ADMIN", "EVALUATOR"] },
  { href: "/admin/agenda", label: "Agenda builder", icon: LayoutDashboard, roles: ["ADMIN"] },
  { href: "/admin/speakers", label: "Speaker onboarding", icon: UserCheck, roles: ["ADMIN"] },
  { href: "/admin/embeds", label: "Website embeds", icon: Code2, roles: ["ADMIN"] },
  { href: "/admin/settings", label: "Event settings", icon: SlidersHorizontal, roles: ["ADMIN"] },
  { href: "/admin/operations", label: "Operations", icon: Settings2, roles: ["ADMIN"] },
  { href: "/portal", label: "Speaker portal", icon: Users, roles: ["ADMIN", "SPEAKER"] },
  { href: "/embed/schedule", label: "Public schedule", icon: CalendarDays, roles: EVERYONE },
  { href: "/embed/speakers", label: "Public speakers", icon: Mic2, roles: EVERYONE },
];

export function AppShell({ session, children }: { session: DemoSession; children: React.ReactNode }) {
  const links = navigation.filter((item) => item.roles.includes(session.role));

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
        </div>
        <nav aria-label="Workspace navigation">
          {links.map(({ href, label, icon: Icon }) => (
            <Link className="nav-link" href={href} key={href}>
              <Icon size={17} aria-hidden="true" />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
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
          <MobileNavigation links={links.map(({ href, label }) => ({ href, label }))} />
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
