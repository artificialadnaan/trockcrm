import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Handshake,
  ClipboardList,
  Kanban,
  Menu,
  X,
  Camera,
  Users,
  Building2,
  CheckSquare,
  BarChart3,
  FileImage,
  Mail,
  Image,
  DollarSign,
  Ticket,
  Shield,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

type Role = "admin" | "director" | "sales_manager" | "rep" | "construction";

const CRM_ROLES: Role[] = ["admin", "director", "rep"];
const FIELD_ROLES: Role[] = ["admin", "director", "rep", "construction"];

type MobileNavItem = {
  to: string;
  icon: LucideIcon;
  label: string;
  external?: boolean;
  ariaLabel?: string;
  /** Mirrors the desktop sidebar's role gating; undefined => visible to every role. */
  roles?: Role[];
};

// Primary tabs: the core sales workflow, always one tap from the bottom bar.
// Deals + Leads were previously unreachable on mobile (the #1 mobile gap); they
// are now first-class tabs. Role gating mirrors the sidebar (sidebar.tsx) so the
// mobile bar never surfaces a destination the sidebar hides for that role.
const primaryNavItems: MobileNavItem[] = [
  { to: "/", icon: LayoutDashboard, label: "Home", roles: CRM_ROLES },
  { to: "/deals", icon: Handshake, label: "Deals", roles: CRM_ROLES },
  { to: "/leads", icon: ClipboardList, label: "Leads", roles: CRM_ROLES },
  { to: "/pipeline", icon: Kanban, label: "Pipeline", roles: CRM_ROLES },
];

// "More" sheet: the rest of the sidebar destinations, role-filtered to match it.
const moreNavItems: MobileNavItem[] = [
  { to: "/contacts", icon: Users, label: "Contacts", roles: CRM_ROLES },
  { to: "/companies", icon: Building2, label: "Companies", roles: CRM_ROLES },
  { to: "/properties", icon: Building2, label: "Properties", roles: CRM_ROLES },
  { to: "/tasks", icon: CheckSquare, label: "Tasks", roles: CRM_ROLES },
  { to: "/reports", icon: BarChart3, label: "Reports", roles: CRM_ROLES },
  { to: "/files", icon: FileImage, label: "Files", roles: CRM_ROLES },
  { to: "/email", icon: Mail, label: "Email", roles: CRM_ROLES },
  { to: "/photos/feed", icon: Image, label: "Feed", roles: FIELD_ROLES },
  { to: "/commissions", icon: DollarSign, label: "Commissions", roles: ["rep"] },
  { to: "/director", icon: Shield, label: "Director", roles: ["admin", "director"] },
  {
    to: "/director/commissions",
    icon: DollarSign,
    label: "Team Commissions",
    roles: ["admin", "director"],
  },
  {
    to: "https://trockcam.com",
    icon: Camera,
    label: "Capture",
    external: true,
    ariaLabel: "Open Capture in a new tab",
    roles: FIELD_ROLES,
  },
  {
    to: "https://support-hub-production.up.railway.app/",
    icon: Ticket,
    label: "Tickets",
    external: true,
    ariaLabel: "Open Tickets in a new tab",
    roles: FIELD_ROLES,
  },
];

function getNavItemKey(item: { label: string; to: string }) {
  return `${item.label}:${item.to}`;
}

function isVisibleToRole(item: MobileNavItem, role: Role | undefined) {
  if (!item.roles) return true;
  return role ? item.roles.includes(role) : false;
}

// 56px tall — comfortably above the 44px touch-target minimum.
const tabBaseClass =
  "flex flex-1 flex-col items-center justify-center gap-1 min-w-[3rem] min-h-[3.5rem] rounded-md transition-colors";

function MoreNavLink({ item, onNavigate }: { item: MobileNavItem; onNavigate: () => void }) {
  const className =
    "flex min-h-[4.5rem] flex-col items-center justify-center gap-1.5 rounded-xl p-2 text-center text-muted-foreground transition-colors hover:bg-slate-50";

  if (item.external) {
    return (
      <a
        href={item.to}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={item.ariaLabel}
        onClick={onNavigate}
        className={className}
      >
        <item.icon className="h-5 w-5" />
        <span className="text-[11px] font-medium leading-tight">{item.label}</span>
      </a>
    );
  }

  return (
    <NavLink
      to={item.to}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(className, isActive && "bg-brand-red/10 text-brand-red")
      }
    >
      <item.icon className="h-5 w-5" />
      <span className="text-[11px] font-medium leading-tight">{item.label}</span>
    </NavLink>
  );
}

/**
 * Presentational bottom nav. Takes the role directly so it can be previewed in the
 * dev harness without an auth session; `MobileNav` wires it to `useAuth`.
 */
export function MobileNavView({ role }: { role: Role | undefined }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const visiblePrimary = primaryNavItems.filter((item) => isVisibleToRole(item, role));
  const visibleMoreItems = moreNavItems.filter((item) => isVisibleToRole(item, role));
  const closeMore = () => setMoreOpen(false);

  useEffect(() => {
    if (!moreOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [moreOpen]);

  // Roles with no reachable destinations (e.g. sales_manager) get no bar, mirroring
  // their empty sidebar.
  if (visiblePrimary.length === 0 && visibleMoreItems.length === 0) return null;

  return (
    <>
      {moreOpen ? (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={closeMore}
            className="md:hidden fixed inset-0 z-40 bg-black/20"
          />
          <div
            role="dialog"
            aria-labelledby="mobile-more-heading"
            className="md:hidden fixed inset-x-0 bottom-16 z-50 max-h-[70vh] overflow-y-auto rounded-t-2xl border-t bg-white p-3 shadow-2xl"
          >
            <div className="mb-2 flex items-center justify-between px-1">
              <span id="mobile-more-heading" className="text-xs font-bold uppercase tracking-widest text-slate-500">
                More
              </span>
              <button
                type="button"
                aria-label="Close menu"
                onClick={closeMore}
                className="flex h-9 w-9 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-4 gap-1">
              {visibleMoreItems.map((item) => (
                <MoreNavLink key={getNavItemKey(item)} item={item} onNavigate={closeMore} />
              ))}
            </div>
          </div>
        </>
      ) : null}

      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t z-50">
        <div className="flex items-center justify-around h-16">
          {visiblePrimary.map((item) => (
            <NavLink
              key={getNavItemKey(item)}
              to={item.to}
              end={item.to === "/"}
              onClick={closeMore}
              className={({ isActive }) =>
                cn(tabBaseClass, isActive ? "text-brand-red" : "text-muted-foreground")
              }
            >
              <item.icon className="h-5 w-5" />
              <span className="text-[10px] font-medium">{item.label}</span>
            </NavLink>
          ))}
          {visibleMoreItems.length > 0 ? (
            <button
              type="button"
              aria-label="More navigation"
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((open) => !open)}
              className={cn(tabBaseClass, moreOpen ? "text-brand-red" : "text-muted-foreground")}
            >
              <Menu className="h-5 w-5" />
              <span className="text-[10px] font-medium">More</span>
            </button>
          ) : null}
        </div>
      </nav>
    </>
  );
}

export function MobileNav() {
  const { user } = useAuth();
  return <MobileNavView role={user?.role} />;
}
