import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Kanban,
  Users,
  CheckSquare,
  BarChart3,
} from "lucide-react";

const mobileNavItems = [
  { to: "/", icon: LayoutDashboard, label: "Home" },
  { to: "/pipeline", icon: Kanban, label: "Pipeline" },
  { to: "/contacts", icon: Users, label: "Contacts" },
  { to: "/tasks", icon: CheckSquare, label: "Tasks" },
  { to: "/reports", icon: BarChart3, label: "Reports" },
];

export function MobileNav() {
  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t z-50">
      <div className="flex items-center justify-around h-16">
        {mobileNavItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center gap-1 min-w-[3rem] min-h-[2.75rem] rounded-md transition-colors ${
                isActive
                  ? "text-brand-purple"
                  : "text-muted-foreground"
              }`
            }
          >
            <item.icon className="h-5 w-5" />
            <span className="text-[10px] font-medium">{item.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
