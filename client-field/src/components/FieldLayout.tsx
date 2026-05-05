import { Camera, FolderKanban, UserCircle } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { Button } from "./ui";

const navItems = [
  { label: "Projects", icon: FolderKanban, to: "/projects" },
  { label: "Capture", icon: Camera, to: "/projects" },
  { label: "Profile", icon: UserCircle, to: "/profile" },
] as const;

export function FieldLayout() {
  const { user, logout } = useAuth();
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.email || "Field user";

  return (
    <div className="min-h-screen bg-background pb-24">
      <header className="sticky top-0 z-10 border-b border-border bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold uppercase tracking-wide text-primary">T Rock Field</p>
            <p className="truncate text-lg font-semibold">{name}</p>
          </div>
          <Button variant="ghost" onClick={() => void logout()} aria-label="Log out">Log out</Button>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">
        <Outlet />
      </main>
      <nav className="fixed inset-x-0 bottom-0 border-t border-border bg-white px-3 pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto grid max-w-3xl grid-cols-3 gap-2 py-2">
          {navItems.map((item) => (
            <NavLink
              key={item.label}
              to={item.to}
              className={({ isActive }) => `flex min-h-14 flex-col items-center justify-center rounded-md text-sm font-semibold ${isActive ? "bg-muted text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
            >
              <item.icon className="h-5 w-5" aria-hidden="true" />
              {item.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
