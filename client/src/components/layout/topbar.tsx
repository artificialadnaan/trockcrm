import { useState, useEffect } from "react";
import { Search } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { NotificationCenter } from "@/components/notifications/notification-center";
import { CommandPalette } from "@/components/search/command-palette";
import { useAuth } from "@/lib/auth";

export function Topbar() {
  const { user } = useAuth();
  const [searchOpen, setSearchOpen] = useState(false);
  const initials = user?.displayName
    ?.split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase() ?? "?";

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <header className="flex h-[3.5rem] items-center justify-between border-b border-slate-200 bg-white/95 px-4 md:h-[3.75rem] md:px-6">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setSearchOpen(true)}
          aria-label="Search"
          className="flex h-9 w-9 items-center justify-center rounded-md bg-slate-100 text-slate-500 md:w-auto md:min-w-[11rem] md:justify-start md:gap-2 md:px-3"
        >
          <Search className="h-4 w-4" />
          <span className="hidden md:inline">Search</span>
          <kbd className="hidden md:inline-flex h-5 items-center gap-0.5 rounded border border-gray-300 bg-white px-1 font-mono text-xs text-gray-500">
            {"\u2318"}K
          </kbd>
        </button>
      </div>

      <div className="flex items-center gap-3">
        <NotificationCenter />
        <Avatar className="h-9 w-9">
          <AvatarFallback className="bg-brand-red text-white text-xs">
            {initials}
          </AvatarFallback>
        </Avatar>
      </div>

      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </header>
  );
}
