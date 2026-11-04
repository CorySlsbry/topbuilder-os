"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { STEP_UP_EVENT } from "@/lib/client/api";

// The one shell every signed-in page lives in: Top Builder AI brand,
// sidebar grouped by how Mike thinks (work / money / system), topbar with
// the shop + person, slide-over nav under 900px. Nav items are HIDDEN when
// the signed-in person lacks the department wall — hiding is courtesy, the
// server is the enforcement.

interface Me {
  uid: string;
  email?: string;
  scope: { tenantId: string; role: string; departments: string[] } | null;
  memberships: { tenantId: string; tenantName: string }[];
  /** Unread inbound messages across the shop — the one live badge in the nav.
   *  It rides along on /api/me rather than polling on its own. */
  inboxUnread?: number;
  /** Capabilities this tenant's PLAN does not include (the Light fence). */
  missingCapabilities?: string[];
  planName?: string | null;
}

interface NavItem {
  href: string;
  label: string;
  ico: string;
  /**
   * Wall needed to see it (owner/admin hold all walls implicitly).
   *
   * `field` joined this union when the field board landed. Until then every
   * walled screen was a MONEY or PEOPLE screen, so the type had quietly encoded
   * "walls are for hiding sensitive things from the crew" — and the crew having
   * nothing of their own was the consequence.
   */
  wall?: "financials" | "hr" | "field";
  /** Capability the tenant's PLAN must include — the Light fence. */
  needs?: string;
  adminOnly?: boolean;
  /** Renders a live count beside the label. */
  badge?: "inbox";
}

const GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: "WORK",
    items: [
      // The Monday-morning view. First in the list because it is the screen
      // that tells you which of the others to open.
      { href: "/dashboard", label: "Dashboard", ico: "🧭", wall: "financials" },
      // The other half of the shop. `/dashboard` is money and therefore walled,
      // which left everyone WITHOUT that wall — techs, dispatchers, the front
      // desk — with no home screen at all: the nav item was hidden and the
      // route 403'd, so most of a company logged in to a job list. This one is
      // walled the other way and carries no dollar figure anywhere.
      { href: "/field-board", label: "Today", ico: "📋", wall: "field" },
      // No wall: the inbox self-filters to the caller's departments, so each
      // person sees exactly their slice of "what needs me?".
      { href: "/approvals", label: "Approvals", ico: "✅", needs: "agents" },
      // Also unwalled, and for the mirror-image reason: the front desk is
      // whoever picks up. A tech answering "running 20 minutes late" from a
      // roof is the point of this screen, not an exception to it.
      { href: "/inbox", label: "Inbox", ico: "💬", badge: "inbox", needs: "comms" },
      { href: "/intake", label: "Intake", ico: "📥" },
      { href: "/customers", label: "Customers", ico: "👥" },
      { href: "/sales", label: "Sales", ico: "🎯" },
      { href: "/memberships", label: "Memberships", ico: "🔁" },
      { href: "/jobs", label: "Jobs", ico: "🏠" },
      { href: "/pricebook", label: "Pricebook", ico: "📕" },
      { href: "/forms", label: "Forms", ico: "📋" },
      { href: "/dispatch", label: "Dispatch", ico: "🗓", needs: "dispatch" },
      { href: "/field", label: "Field", ico: "🛻" },
      { href: "/crew", label: "Crew & time", ico: "⏱", needs: "workforce" },
      { href: "/inventory", label: "Stock", ico: "📦", needs: "inventory" },
    ],
  },
  {
    title: "MONEY",
    items: [
      { href: "/bank", label: "Bank", ico: "🏦", wall: "financials" },
      { href: "/purchasing", label: "Purchasing", ico: "🧾", wall: "financials", needs: "purchasing" },
      { href: "/wip", label: "WIP", ico: "📐", wall: "financials", needs: "bonding" },
      // Unwalled: a cost code is a label for what kind of work a cost was,
      // not a dollar figure, and the people who code costs in the field are
      // not the people who hold the financials wall.
      { href: "/cost-codes", label: "Cost codes", ico: "🏷" },
      { href: "/money", label: "Money HQ", ico: "📊", wall: "financials" },
      { href: "/reports", label: "Reports", ico: "📈", wall: "financials" },
      { href: "/bonding", label: "Bonding & surety", ico: "🏛", wall: "financials", needs: "bonding" },
      { href: "/accountant", label: "Accountant", ico: "🤝", wall: "financials" },
    ],
  },
  {
    title: "SYSTEM",
    items: [
      { href: "/agents", label: "Helpers", ico: "✨", needs: "agents" },
      { href: "/team", label: "Team & access", ico: "🔐", adminOnly: true },
      { href: "/security", label: "Sign-in security", ico: "🔒" },
      { href: "/billing", label: "Plan & billing", ico: "💳" },
      { href: "/account", label: "Your data", ico: "🗄" },
    ],
  },
];

export default function AppShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState(false);

  // ── collapsible nav groups (the ServiceTitan rail pattern, Cory 2026-08-13)
  // Deterministic first paint: only the group holding the CURRENT page is
  // open, so server and client render identically (no hydration flash).
  // The user's own opens/closes then load from localStorage in an effect and
  // win from that point on. The active page's group is always forced open on
  // navigation — a nav that hides where you ARE is worse than a long one.
  const groupHasCurrent = (g: (typeof GROUPS)[number]) =>
    g.items.some((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("tbos-nav-groups") ?? "{}");
      setExpanded((prev) => ({ ...stored, ...prev }));
    } catch { /* a corrupt pref never breaks the nav */ }
  }, []);
  useEffect(() => {
    // arriving on a page inside a collapsed group re-opens that group
    const g = GROUPS.find(groupHasCurrent);
    if (g) setExpanded((prev) => (prev[g.title] === false ? { ...prev, [g.title]: true } : prev));
    // Depends on `pathname` ALONE on purpose: `groupHasCurrent` is redefined
    // every render, so listing it would re-run this on every render and fight
    // the user's own collapse. (This used to carry an
    // `eslint-disable-next-line react-hooks/exhaustive-deps`, but that plugin
    // is not installed here — ESLint 9 errors on a directive naming a rule it
    // does not know, so the whole lint step failed on this one line.)
  }, [pathname]);
  const toggleGroup = (title: string, isOpen: boolean) => {
    setExpanded((prev) => {
      const next = { ...prev, [title]: !isOpen };
      try { localStorage.setItem("tbos-nav-groups", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };
  const [needsStepUp, setNeedsStepUp] = useState(false);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  useEffect(() => setOpen(false), [pathname]);

  // A blocked step-up is about the ACCOUNT, not the page that happened to hit
  // it — so it is handled once here rather than in every page's catch block.
  useEffect(() => {
    const onStepUp = () => setNeedsStepUp(true);
    window.addEventListener(STEP_UP_EVENT, onStepUp);
    return () => window.removeEventListener(STEP_UP_EVENT, onStepUp);
  }, []);

  const unread = me?.inboxUnread ?? 0;
  const role = me?.scope?.role;
  const isAdmin = role === "owner" || role === "admin";
  const walls = new Set(me?.scope?.departments ?? []);
  // Capabilities the tenant's PLAN does not include. Unlike the department
  // walls, this is not about who you are — a Light owner holds every wall and
  // still has no dispatch board, because his plan does not have one.
  const withoutPlan = new Set(me?.missingCapabilities ?? []);
  const canSee = (item: NavItem) => {
    if (!me?.scope) return true; // pre-load: render everything, server enforces
    if (item.adminOnly) return isAdmin;
    if (item.needs && withoutPlan.has(item.needs)) return false;
    if (item.wall) return isAdmin || walls.has(item.wall);
    return true;
  };
  const tenantName =
    me?.memberships.find((m) => m.tenantId === me.scope?.tenantId)?.tenantName ?? "";

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.push("/login");
  }

  return (
    <>
      {/*
        One app-wide live region. Screen readers announce whatever lands here;
        before this, a failed sign-in, a rejected code or a blocked action
        changed the screen with nothing announced at all (WCAG 2.2 AA 4.1.3).
      */}
      <div role="status" aria-live="polite" className="sr-only">
        {needsStepUp ? "This action needs 2-step verification." : ""}
      </div>
      {/*
        ⛔ THE BANNERS LIVE OUTSIDE `.app`, AND THAT IS LOAD-BEARING.
        `.app` is `display: flex` — a ROW of sidebar + content. These bars were
        written with `grid-column: 1 / -1`, which is a GRID property and does
        exactly nothing in a flex container. So instead of spanning the width,
        each bar became an ordinary flex ITEM in the row: it took ~1000px of
        horizontal space, shoved the sidebar to the right edge, and squeezed
        `.content` (flex: 1 1 0) down to ZERO WIDTH.
        The whole app rendered as an empty page with the nav stranded on the
        right — on every desktop viewport, on the PUBLIC DEMO, which is the
        first thing a stranger clicks. It survived because the bar only ever
        renders for the demo seat or an aal2 prompt, and neither had been
        opened on a wide screen. Found 2026-08-12 by screenshotting the live
        site in a real browser.
      */}
      {me?.uid === "demo:public" && (
        <div className="stepup" role="note" style={{ background: "var(--brand-tint)" }}>
          <strong>You&apos;re touring Desert Aire Mechanical</strong> — a
          made-up 11-person HVAC shop, running on the real product. Every
          number here was posted by the same engine a paying shop uses, so the
          books actually tie. Nothing you click will save: this seat is
          read-only.{" "}
          <a href="https://topbuilderai.com/#join" target="_blank" rel="noreferrer">
            Start your own — 30 days free
          </a>
        </div>
      )}
      {needsStepUp && (
        <div className="stepup" role="alert">
          <strong>2-step verification needed.</strong> That action changes money,
          access, or your account, so it asks for a code first.{" "}
          <Link href="/security">Turn it on — takes a minute</Link>
          <button
            type="button"
            onClick={() => setNeedsStepUp(false)}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
    <div className="app" data-nav={open ? "open" : "closed"}>
      <button
        className="backdrop"
        aria-label="Close menu"
        tabIndex={-1}
        onClick={() => setOpen(false)}
      />
      <aside className="sidebar" aria-label="Main navigation">
        <div className="brandmark">
          <span className="bars" aria-hidden="true">
            <span /><span /><span />
          </span>
          TOP BUILDER <span className="os">OS</span>
        </div>
        {GROUPS.map((g) => {
          const visible = g.items.filter(canSee);
          if (visible.length === 0) return null;
          const isOpen = expanded[g.title] ?? groupHasCurrent(g);
          return (
            <nav key={g.title} aria-label={g.title}>
              <button
                type="button"
                className="navgroup navgroup-toggle"
                aria-expanded={isOpen}
                onClick={() => toggleGroup(g.title, isOpen)}
              >
                <span className="chev" aria-hidden="true">▸</span>
                {g.title}
              </button>
              {isOpen && visible.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="navitem"
                  aria-current={
                    pathname === item.href || pathname.startsWith(`${item.href}/`)
                      ? "page"
                      : undefined
                  }
                >
                  <span className="ico" aria-hidden="true">{item.ico}</span>
                  {item.label}
                  {item.badge === "inbox" && unread > 0 && (
                    <span className="navbadge" aria-label={`${unread} unread`}>
                      {unread > 99 ? "99+" : unread}
                    </span>
                  )}
                </Link>
              ))}
            </nav>
          );
        })}
      </aside>
      <div className="content">
        <header className="topbar">
          <button className="menubtn" onClick={() => setOpen(true)} aria-label="Open menu">
            ☰
          </button>
          <h1>{title}</h1>
          <div className="who">
            {tenantName && <span className="pill">{tenantName}</span>}
            {me?.email && <span>{me.email}</span>}
            <button className="secondary" style={{ minHeight: 34, padding: "4px 12px" }} onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </header>
        <div className="pagebody">{children}</div>
      </div>
      {/* Phone thumb-bar: the four doors Mike actually opens all day, plus
          the full menu. Wall-filtered like the sidebar. */}
      <nav className="tabbar" aria-label="Quick navigation">
        {[
          { href: "/jobs", label: "Jobs", ico: "🏠" },
          { href: "/intake", label: "Intake", ico: "📥" },
          { href: "/dispatch", label: "Dispatch", ico: "🗓" },
          { href: "/money", label: "Money", ico: "📊", wall: "financials" as const },
        ]
          .filter((t) => canSee(t))
          .map((t) => (
            <Link
              key={t.href}
              href={t.href}
              aria-current={pathname.startsWith(t.href) ? "page" : undefined}
            >
              <span className="tico" aria-hidden="true">{t.ico}</span>
              {t.label}
            </Link>
          ))}
        <button className="tab" onClick={() => setOpen(true)} aria-label="Full menu">
          <span className="tico" aria-hidden="true">☰</span>
          More
        </button>
      </nav>
    </div>
    </>
  );
}
