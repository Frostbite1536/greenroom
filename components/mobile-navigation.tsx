"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";

/**
 * `href: null` renders a visible, non-interactive entry. The C16 no-open-CFP
 * state (D-C5-3) must stay visible in the mobile menu without becoming a link
 * to nowhere.
 */
type NavigationLink = { href: string | null; label: string };

export function MobileNavigation({ links }: { links: NavigationLink[] }) {
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
        <div className="mobile-nav-overlay" onMouseDown={(event) => event.currentTarget === event.target && closeMenu()}>
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
              {links.map((link, index) =>
                link.href ? (
                  <Link className="mobile-nav-link" href={link.href} key={link.href} onClick={closeMenu}>
                    {link.label}
                  </Link>
                ) : (
                  <p className="mobile-nav-link mobile-nav-static" key={`static-${index}`}>
                    {link.label}
                  </p>
                ),
              )}
            </nav>
          </aside>
        </div>
      ) : null}
    </>
  );
}
