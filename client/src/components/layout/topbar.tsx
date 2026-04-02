import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { NotificationCenter } from "@/components/notifications/notification-center";
import { useAuth } from "@/lib/auth";

export function Topbar() {
  const { user } = useAuth();
  const initials = user?.displayName
    ?.split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase() ?? "?";

  return (
    <header className="h-14 border-b bg-white flex items-center justify-between px-4 md:px-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" className="text-muted-foreground">
          <Search className="h-4 w-4 mr-2" />
          <span className="hidden sm:inline">Search...</span>
          <kbd className="hidden md:inline-flex ml-2 text-xs bg-muted px-1.5 py-0.5 rounded">
            Cmd+K
          </kbd>
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <NotificationCenter />
        <Avatar className="h-8 w-8">
          <AvatarFallback className="bg-brand-purple text-white text-xs">
            {initials}
          </AvatarFallback>
        </Avatar>
      </div>
    </header>
  );
}
