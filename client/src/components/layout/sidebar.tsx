import { useEffect, useMemo, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import {
  LayoutDashboard,
  Kanban,
  Handshake,
  ClipboardList,
  Users,
  Mail,
  CheckSquare,
  FileImage,
  BarChart3,
  Building2,
  Settings,
  Shield,
  LogOut,
  GitMerge,
  Zap,
  ArrowRightLeft,
  BookOpen,
  HelpCircle,
  Globe,
  Camera,
  Image,
  Sparkles,
  ShieldAlert,
  Radar,
  ClipboardCheck,
  BellRing,
  ChevronDown,
  DollarSign,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";

type Role = "admin" | "director" | "sales_manager" | "rep" | "construction";

export type NavItem = {
  to: string;
  icon: LucideIcon;
  label: string;
  roles: Role[];
};

export type AdminGroup = {
  id: "operations" | "ai" | "system";
  label: string;
  defaultExpanded: boolean;
  items: NavItem[];
};

const navItems: NavItem[] = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard", roles: ["admin", "director", "rep"] },
  { to: "/deals", icon: Handshake, label: "Deals", roles: ["admin", "director", "rep"] },
  { to: "/leads", icon: ClipboardList, label: "Leads", roles: ["admin", "director", "rep"] },
  { to: "/properties", icon: Building2, label: "Properties", roles: ["admin", "director", "rep"] },
  { to: "/deals", icon: Kanban, label: "Pipeline", roles: ["admin", "director", "rep"] },
  { to: "/contacts", icon: Users, label: "Contacts", roles: ["admin", "director", "rep"] },
  { to: "/companies", icon: Building2, label: "Companies", roles: ["admin", "director", "rep"] },
  { to: "/email", icon: Mail, label: "Email", roles: ["admin", "director", "rep"] },
  { to: "/tasks", icon: CheckSquare, label: "Tasks", roles: ["admin", "director", "rep"] },
  { to: "/files", icon: FileImage, label: "Files", roles: ["admin", "director", "rep"] },
  { to: "/photos/capture", icon: Camera, label: "Capture", roles: ["admin", "director", "rep"] },
  { to: "/photos/feed", icon: Image, label: "Feed", roles: ["admin", "director", "rep"] },
  { to: "/reports", icon: BarChart3, label: "Reports", roles: ["admin", "director", "rep"] },
  { to: "/commissions", icon: DollarSign, label: "Commissions", roles: ["rep"] },
  { to: "/projects", icon: Building2, label: "Projects", roles: ["admin", "director", "rep"] },
];

const directorItems: NavItem[] = [
  { to: "/director", icon: Shield, label: "Director", roles: ["admin", "director"] },
  { to: "/director/commissions", icon: DollarSign, label: "Team Commissions", roles: ["admin", "director"] },
];

const adminGroups: AdminGroup[] = [
  {
    id: "operations",
    label: "Operations",
    defaultExpanded: true,
    items: [
      { to: "/admin/sales-process-disconnects", icon: Radar, label: "Process Disconnects", roles: ["admin", "director"] },
      { to: "/admin/interventions", icon: ClipboardCheck, label: "Interventions", roles: ["admin", "director"] },
      { to: "/admin/intervention-analytics", icon: BarChart3, label: "Intervention Analytics", roles: ["admin", "director"] },
      { to: "/admin/lead-due-diligence-queue", icon: Shield, label: "Lead DD Queue", roles: ["admin", "director"] },
      { to: "/admin/merge-queue", icon: GitMerge, label: "Merge Queue", roles: ["admin", "director"] },
      { to: "/admin/directory-merge-queue", icon: Building2, label: "Directory Merge Queue", roles: ["admin", "director"] },
      { to: "/admin/notification-recipients", icon: BellRing, label: "Notification Recipients", roles: ["admin"] },
    ],
  },
  {
    id: "ai",
    label: "AI",
    defaultExpanded: false,
    items: [
      { to: "/admin/ai-actions", icon: ShieldAlert, label: "AI Actions", roles: ["admin", "director"] },
      { to: "/admin/ai-ops", icon: Sparkles, label: "AI Ops", roles: ["admin", "director"] },
    ],
  },
  {
    id: "system",
    label: "System",
    defaultExpanded: false,
    items: [
      { to: "/admin/offices", icon: Building2, label: "Offices", roles: ["admin"] },
      { to: "/admin/users", icon: Users, label: "Users", roles: ["admin"] },
      { to: "/admin/field-users", icon: Users, label: "Field Users", roles: ["admin"] },
      { to: "/admin/pipeline", icon: Settings, label: "Pipeline Config", roles: ["admin"] },
      { to: "/admin/commissions", icon: DollarSign, label: "Global Commissions", roles: ["admin"] },
      { to: "/admin/procore", icon: Zap, label: "Procore Sync", roles: ["admin"] },
      { to: "/admin/data-scrub", icon: ClipboardList, label: "Data Scrub", roles: ["admin", "director"] },
      { to: "/admin/audit", icon: ClipboardList, label: "Audit Log", roles: ["admin", "director"] },
      { to: "/admin/cross-office-reports", icon: Globe, label: "Cross-Office Reports", roles: ["admin", "director"] },
      { to: "/admin/migration", icon: ArrowRightLeft, label: "Migration", roles: ["admin", "director"] },
    ],
  },
];

const helpItems: NavItem[] = [
  { to: "/help/user-guide", icon: BookOpen, label: "User Guide", roles: ["admin", "director", "rep"] },
  { to: "/help/admin-guide", icon: HelpCircle, label: "Admin Guide", roles: ["admin"] },
];

function filterByRole(items: NavItem[], role: Role | undefined) {
  if (!role) return [];
  return items.filter((item) => item.roles.includes(role));
}

export function getVisibleDirectorItems(role: Role | undefined) {
  return filterByRole(directorItems, role);
}

function getNavItemKey(item: NavItem) {
  return `${item.to}:${item.label}`;
}

export function getVisibleAdminGroups(role: Role | undefined) {
  return adminGroups
    .map((group) => ({
      ...group,
      items: filterByRole(group.items, role),
    }))
    .filter((group) => group.items.length > 0);
}

export function isAdminGroupActive(items: NavItem[], pathname: string) {
  return items.some((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
}

export function getNextExpandedGroups(
  current: Record<string, boolean>,
  groups: Array<AdminGroup & { items: NavItem[] }>,
  pathname: string,
  toggledGroupId?: string,
) {
  const next = { ...current };

  for (const group of groups) {
    if (isAdminGroupActive(group.items, pathname)) {
      next[group.id] = true;
      continue;
    }

    if (!(group.id in next)) {
      next[group.id] = group.defaultExpanded;
    }

    if (group.id === toggledGroupId) {
      next[group.id] = !next[group.id];
    }
  }

  return next;
}

function mapsEqual(left: Record<string, boolean>, right: Record<string, boolean>) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

export function Sidebar() {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const role = user?.role;
  const visibleNavItems = useMemo(() => filterByRole(navItems, role), [role]);
  const visibleDirectorItems = useMemo(() => getVisibleDirectorItems(role), [role]);
  const visibleAdminGroups = useMemo(() => getVisibleAdminGroups(role), [role]);
  const visibleHelpItems = useMemo(() => filterByRole(helpItems, role), [role]);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(() =>
    getNextExpandedGroups({}, getVisibleAdminGroups(role), pathname),
  );

  useEffect(() => {
    setExpandedGroups((current) => {
      const next = getNextExpandedGroups(current, visibleAdminGroups, pathname);
      return mapsEqual(next, current) ? current : next;
    });
  }, [pathname, visibleAdminGroups]);

  const isExpanded = (group: AdminGroup & { items: NavItem[] }) =>
    isAdminGroupActive(group.items, pathname) || expandedGroups[group.id] || false;

  const toggleGroup = (group: AdminGroup & { items: NavItem[] }) => {
    setExpandedGroups((current) => getNextExpandedGroups(current, visibleAdminGroups, pathname, group.id));
  };

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 px-3 py-2 rounded-md text-sm font-semibold transition-colors ${
      isActive
        ? "bg-brand-red/10 text-brand-red ring-1 ring-brand-red/15"
        : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"
    }`;

  return (
    <aside className="hidden min-h-screen w-60 flex-col border-r border-slate-200 bg-white text-slate-950 md:flex">
      <div className="flex min-h-14 items-center gap-3 px-4 py-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-slate-900">
          <img src="/logo.png" alt="T Rock" className="h-8 w-8 object-contain" />
        </div>
        <div className="flex flex-col justify-center leading-tight">
          <span className="text-sm font-bold tracking-[0.18em] text-slate-950">T ROCK</span>
          <span className="text-[10px] font-semibold tracking-[0.28em] text-slate-500">
            CRM
          </span>
        </div>
      </div>

      <nav className="flex-1 px-2 space-y-1">
        {visibleNavItems.map((item) => (
          <NavLink
            key={getNavItemKey(item)}
            to={item.to}
            end={item.to === "/"}
            className={navLinkClass}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}

        {visibleDirectorItems.length > 0 && (
          <div className="mt-4 space-y-1 border-t border-slate-200 pt-3">
            <p className="mb-1 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">
              Director
            </p>
            {visibleDirectorItems.map((item) => (
              <NavLink
                key={getNavItemKey(item)}
                to={item.to}
                className={navLinkClass}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </NavLink>
            ))}
          </div>
        )}

        {visibleAdminGroups.length > 0 && (
          <div className="mt-4 space-y-1 border-t border-slate-200 pt-3">
            <p className="mb-1 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">
              Admin
            </p>
            {visibleAdminGroups.map((group) => (
              <div key={group.id} className="space-y-1">
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-3 py-2 text-xs font-bold uppercase tracking-wider text-slate-500 hover:text-slate-950"
                  aria-expanded={isExpanded(group)}
                  onClick={() => toggleGroup(group)}
                >
                  <span>{group.label}</span>
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${isExpanded(group) ? "rotate-0" : "-rotate-90"}`}
                  />
                </button>
                {isExpanded(group) ? (
                  <div className="space-y-1">
                    {group.items.map((item) => (
                      <NavLink key={getNavItemKey(item)} to={item.to} className={navLinkClass}>
                        <item.icon className="h-4 w-4" />
                        {item.label}
                      </NavLink>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {visibleHelpItems.length > 0 && (
          <div className="mt-4 space-y-1 border-t border-slate-200 pt-3">
            <p className="mb-1 px-3 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">
              Help
            </p>
            {visibleHelpItems.map((item) => (
              <NavLink
                key={getNavItemKey(item)}
                to={item.to}
                className={navLinkClass}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </NavLink>
            ))}
          </div>
        )}
      </nav>

      <div className="border-t border-slate-200 p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm">
            <p className="truncate font-medium text-slate-950">{user?.displayName}</p>
            <p className="text-xs capitalize text-slate-500">{user?.role}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="text-slate-500 hover:bg-slate-100 hover:text-slate-950"
            onClick={logout}
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </aside>
  );
}
