import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Kanban,
  Camera,
  Users,
  CheckSquare,
  DollarSign,
  Ticket,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "@/lib/auth";

type MobileNavItem = {
  to: string;
  icon: LucideIcon;
  label: string;
  external?: boolean;
  ariaLabel?: string;
};

const mobileNavItems: MobileNavItem[] = [
  { to: "/", icon: LayoutDashboard, label: "Home" },
  { to: "/pipeline", icon: Kanban, label: "Pipeline" },
  { to: "https://trockcam.com", icon: Camera, label: "Capture", external: true, ariaLabel: "Open Capture in a new tab" },
  { to: "/contacts", icon: Users, label: "Contacts" },
  { to: "/tasks", icon: CheckSquare, label: "Tasks" },
  {
    to: "https://support-hub-production.up.railway.app/",
    icon: Ticket,
    label: "Tickets",
    external: true,
    ariaLabel: "Open Tickets in a new tab",
  },
];

function getNavItemKey(item: { label: string; to: string }) {
  return `${item.label}:${item.to}`;
}

export function MobileNav() {
  const { user } = useAuth();
  const navItems = user?.role === "rep"
    ? [...mobileNavItems, { to: "/commissions", icon: DollarSign, label: "Commissions" } satisfies MobileNavItem]
    : mobileNavItems;

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t z-50">
      <div className="flex items-center justify-around h-16">
        {navItems.map((item) => (
          item.external ? (
            <a
              key={getNavItemKey(item)}
              href={item.to}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={item.ariaLabel}
              className="flex flex-col items-center justify-center gap-1 min-w-[3rem] min-h-[2.75rem] rounded-md transition-colors text-muted-foreground"
            >
              <item.icon className="h-5 w-5" />
              <span className="text-[10px] font-medium">{item.label}</span>
            </a>
          ) : (
            <NavLink
              key={getNavItemKey(item)}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                `flex flex-col items-center justify-center gap-1 min-w-[3rem] min-h-[2.75rem] rounded-md transition-colors ${
                  isActive
                    ? "text-brand-red"
                    : "text-muted-foreground"
                }`
              }
            >
              <item.icon className="h-5 w-5" />
              <span className="text-[10px] font-medium">{item.label}</span>
            </NavLink>
          )
        ))}
      </div>
    </nav>
  );
}
