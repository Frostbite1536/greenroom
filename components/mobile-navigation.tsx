"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { LogOut, Menu, X } from "lucide-react";
import { logout } from "@/app/login/actions";

/**
 * `href: null` renders a visible, non-interactive entry. The C16 no-open-CFP
 * state (D-C5-3) must stay visible in the mobile menu without becoming a link
 * to nowhere.
 */
type NavigationLink = { href: string | null; label: string };

/**
 * One labelled block of the drawer, in the order the drawer renders them.
 *
 * The drawer used to render every destination as a single flat column — the
 * same "list to be searched rather than a workspace to be navigated" the
 * sidebar fixed by grouping, except a phone is where that column is longest.
 * It now renders the sidebar's own blocks, in the sidebar's own order.
 *
 * The grouping is computed once, in `app-shell.tsx`, off the `NAV_GROUPS`
 * table that already drives the sidebar, and handed down: this file holds no
 * second copy of the table and applies no authorization of its own. `roles`
 * on the server is still the only thing that decides what a session sees, and
 * a group the role reaches nothing in arrives empty and renders nothing —
 * never a heading with no entries under it.
 */
export type NavigationGroup = { key: string; label: string; links: NavigationLink[] };

export function MobileNavigation({
  groups,
  cfpLinks,
}: {
  groups: NavigationGroup[];
  /** The open-call entries the sidebar renders in its own trailing block. */
  cfpLinks: NavigationLink[];
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      closeRef.current?.focus();
      return;
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  function closeMenu() {
    setOpen(false);
  }

  function trapFocus(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled])',
    );
    if (!focusable?.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /** One entry, unchanged by the grouping: the blocks wrap them, nothing more. */
  function entry(link: NavigationLink, index: number) {
    return link.href ? (
      <Link className="mobile-nav-link" href={link.href} key={link.href} onClick={closeMenu}>
        {link.label}
      </Link>
    ) : (
      <p className="mobile-nav-link mobile-nav-static" key={`static-${index}`}>
        {link.label}
      </p>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        className="icon-button mobile-menu"
        type="button"
        aria-label="Open navigation"
        aria-controls="mobile-navigation"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Menu size={19} aria-hidden="true" />
      </button>
      {open ? (
        // onClick, not onMouseDown: closing on mousedown unmounts the overlay
        // mid-pointer-event, and the post-close focus restore then runs before
        // the press completes, leaving the trigger inactive (observed at
        // 390x664: a backdrop click closed the drawer but the trigger stayed
        // dead). onClick fires after the full pointer event, so the restore
        // lands. The own-target guard is unchanged: panel clicks do not close.
        <div className="mobile-nav-overlay" onClick={(event) => event.currentTarget === event.target && closeMenu()}>
          <aside
            ref={panelRef}
            id="mobile-navigation"
            className="mobile-nav-panel"
            aria-label="Workspace navigation"
            onKeyDown={trapFocus}
          >
            <div className="mobile-nav-heading">
              <strong>Navigation</strong>
              <button ref={closeRef} className="icon-button" type="button" aria-label="Close navigation" onClick={closeMenu}>
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <nav>
              {groups.map(({ key, label, links }) => {
                // A role that reaches nothing in this group gets no heading for it.
                if (links.length === 0) return null;
                return (
                  <div
                    aria-labelledby={`mobile-nav-group-${key}`}
                    className="nav-group"
                    key={key}
                    role="group"
                  >
                    <p className="nav-group-label" id={`mobile-nav-group-${key}`}>{label}</p>
                    {links.map(entry)}
                  </div>
                );
              })}
            </nav>
            {cfpLinks.length > 0 ? (
              <nav aria-label="Call for proposals" className="nav-cfp">
                {cfpLinks.map(entry)}
              </nav>
            ) : null}
            {/* The drawer offered no way out: on a phone the sidebar that owns
                the sign-out control is `display: none`, so the only route to
                it was to widen the window. This is the sidebar footer's own
                form — the same `logout` server action, posted the same way, so
                it carries the same session handling and still works with
                JavaScript off.

                It sits at the end of the panel's content, in flow. The panel
                is the scroll container, so the control scrolls with the list
                rather than floating over it: a fixed control would cover the
                last entries, which is the fold problem the panel's
                `overflow-y` was added to fix. */}
            <form action={logout} className="mobile-nav-signout">
              <button className="mobile-nav-link mobile-nav-signout-button" type="submit">
                <LogOut size={17} aria-hidden="true" />
                <span>Sign out</span>
              </button>
            </form>
          </aside>
        </div>
      ) : null}
    </>
  );
}
