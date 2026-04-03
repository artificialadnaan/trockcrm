import { NavLink } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import {
  LayoutDashboard,
  Kanban,
  Handshake,
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
  ClipboardList,
  BookOpen,
  HelpCircle,
  Globe,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard", roles: ["admin", "director", "rep"] },
  { to: "/deals", icon: Handshake, label: "Deals", roles: ["admin", "director", "rep"] },
  { to: "/pipeline", icon: Kanban, label: "Pipeline", roles: ["admin", "director", "rep"] },
  { to: "/contacts", icon: Users, label: "Contacts", roles: ["admin", "director", "rep"] },
  { to: "/companies", icon: Building2, label: "Companies", roles: ["admin", "director", "rep"] },
  { to: "/email", icon: Mail, label: "Email", roles: ["admin", "director", "rep"] },
  { to: "/tasks", icon: CheckSquare, label: "Tasks", roles: ["admin", "director", "rep"] },
  { to: "/files", icon: FileImage, label: "Files", roles: ["admin", "director", "rep"] },
  { to: "/reports", icon: BarChart3, label: "Reports", roles: ["admin", "director", "rep"] },
  { to: "/projects", icon: Building2, label: "Projects", roles: ["admin", "director", "rep"] },
];

const directorItems = [
  { to: "/director", icon: Shield, label: "Director", roles: ["admin", "director"] },
  { to: "/admin/merge-queue", icon: GitMerge, label: "Merge Queue", roles: ["admin", "director"] },
];

const adminItems = [
  { to: "/admin/offices", icon: Building2, label: "Offices", roles: ["admin"] },
  { to: "/admin/users", icon: Users, label: "Users", roles: ["admin"] },
  { to: "/admin/pipeline", icon: Settings, label: "Pipeline Config", roles: ["admin"] },
  { to: "/admin/procore", icon: Zap, label: "Procore Sync", roles: ["admin"] },
  { to: "/admin/audit", icon: ClipboardList, label: "Audit Log", roles: ["admin", "director"] },
  { to: "/admin/cross-office-reports", icon: Globe, label: "Cross-Office Reports", roles: ["admin", "director"] },
  { to: "/admin/migration", icon: ArrowRightLeft, label: "Migration", roles: ["admin"] },
];

const helpItems = [
  { to: "/help/user-guide", icon: BookOpen, label: "User Guide", roles: ["admin", "director", "rep"] },
  { to: "/help/admin-guide", icon: HelpCircle, label: "Admin Guide", roles: ["admin"] },
];

export function Sidebar() {
  const { user, logout } = useAuth();

  const filterByRole = (items: typeof navItems) =>
    items.filter((item) => user && item.roles.includes(user.role));

  return (
    <aside className="hidden md:flex flex-col w-60 bg-sidebar-bg text-white min-h-screen">
      <div className="p-4 flex items-center gap-3">
        <div className="flex-shrink-0 h-9 w-9 overflow-hidden rounded">
          <img
            src="/logo.png"
            alt="T Rock"
            className="h-[180%] w-[180%] object-cover object-[center_15%]"
          />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-bold tracking-wide text-white">T ROCK</span>
          <span className="text-[10px] font-semibold tracking-widest text-gray-400">CRM</span>
        </div>
      </div>

      <nav className="flex-1 px-2 space-y-1">
        {filterByRole(navItems).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                isActive
                  ? "bg-sidebar-active border-l-2 border-brand-red text-white"
                  : "text-slate-400 hover:bg-sidebar-hover hover:text-white"
              }`
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}

        {filterByRole(directorItems).length > 0 && (
          <>
            <Separator className="my-3 bg-slate-700" />
            <p className="px-3 text-xs text-slate-500 uppercase tracking-wider">Director</p>
            {filterByRole(directorItems).map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                    isActive
                      ? "bg-sidebar-active border-l-2 border-brand-red text-white"
                      : "text-slate-400 hover:bg-sidebar-hover hover:text-white"
                  }`
                }
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </NavLink>
            ))}
          </>
        )}

        {filterByRole(adminItems).length > 0 && (
          <>
            <Separator className="my-3 bg-slate-700" />
            <p className="px-3 text-xs text-slate-500 uppercase tracking-wider">Admin</p>
            {filterByRole(adminItems).map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                    isActive
                      ? "bg-sidebar-active border-l-2 border-brand-red text-white"
                      : "text-slate-400 hover:bg-sidebar-hover hover:text-white"
                  }`
                }
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </NavLink>
            ))}
          </>
        )}

        {filterByRole(helpItems).length > 0 && (
          <>
            <Separator className="my-3 bg-slate-700" />
            <p className="px-3 text-xs text-slate-500 uppercase tracking-wider">Help</p>
            {filterByRole(helpItems).map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                    isActive
                      ? "bg-sidebar-active border-l-2 border-brand-red text-white"
                      : "text-slate-400 hover:bg-sidebar-hover hover:text-white"
                  }`
                }
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </NavLink>
            ))}
          </>
        )}
      </nav>

      <div className="p-4 border-t border-slate-700">
        <div className="flex items-center justify-between">
          <div className="text-sm">
            <p className="text-white font-medium truncate">{user?.displayName}</p>
            <p className="text-slate-400 text-xs capitalize">{user?.role}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="text-slate-400 hover:text-white"
            onClick={logout}
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </aside>
  );
}
