import Link from "next/link";
import {
  CalendarDays,
  ClipboardCheck,
  FileStack,
  FileText,
  LayoutDashboard,
  LogOut,
  Mic2,
  Users,
} from "lucide-react";
import type { DemoSession } from "@/lib/auth";
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

const navigation = [
  { href: "/admin/forms", label: "CFP forms", icon: FileText },
  { href: "/admin/abstracts", label: "Abstracts", icon: FileStack },
  { href: "/admin/evaluations", label: "Evaluations", icon: ClipboardCheck },
  { href: "/admin/agenda", label: "Agenda builder", icon: LayoutDashboard },
  { href: "/portal", label: "Speaker portal", icon: Users },
  { href: "/embed/schedule", label: "Public schedule", icon: CalendarDays },
  { href: "/embed/speakers", label: "Public speakers", icon: Mic2 },
];

export function AppShell({ session, children }: { session: DemoSession; children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href="/admin/forms" aria-label="Greenroom home">
          <span className="brand-mark"><Mic2 size={18} aria-hidden="true" /></span>
          <span>Greenroom</span>
        </Link>
        <div className="event-switcher">
          <span className="event-label">Current event</span>
          <strong>{session.event.name}</strong>
        </div>
        <nav aria-label="Workspace navigation">
          {navigation.map(({ href, label, icon: Icon }) => (
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
          <MobileNavigation links={navigation.map(({ href, label }) => ({ href, label }))} />
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
