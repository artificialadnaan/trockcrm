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
    <header className="h-14 border-b bg-white flex items-center justify-between px-4 md:px-6">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setSearchOpen(true)}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-500 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors"
        >
          <Search className="h-4 w-4" />
          <span className="hidden sm:inline">Search</span>
          <kbd className="hidden sm:inline-flex h-5 items-center gap-0.5 rounded border border-gray-300 bg-white px-1 text-xs text-gray-500 font-mono">
            {"\u2318"}K
          </kbd>
        </button>
      </div>

      <div className="flex items-center gap-3">
        <NotificationCenter />
        <Avatar className="h-8 w-8">
          <AvatarFallback className="bg-brand-red text-white text-xs">
            {initials}
          </AvatarFallback>
        </Avatar>
      </div>

      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </header>
  );
}
