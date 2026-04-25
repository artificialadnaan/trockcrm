import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useNotificationStream, useNotifications } from "@/hooks/use-notifications";
import type { Notification } from "@/hooks/use-notifications";

const typeColors: Record<string, string> = {
  stale_deal: "bg-amber-500",
  inbound_email: "bg-blue-500",
  task_assigned: "bg-red-500",
  approval_needed: "bg-orange-500",
  activity_drop: "bg-red-500",
  deal_won: "bg-green-500",
  deal_lost: "bg-red-500",
  stage_change: "bg-cyan-500",
  system: "bg-gray-500",
};

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function NotificationCenter() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const { unreadCount, markAsRead, markAllAsRead } = useNotificationStream(open);
  const { notifications, refetch } = useNotifications(20, open);

  const handleNotificationClick = async (notification: Notification) => {
    if (!notification.isRead) {
      await markAsRead(notification.id);
    }
    if (notification.link) {
      navigate(notification.link);
    }
    setOpen(false);
    refetch();
  };

  const handleMarkAllRead = async () => {
    await markAllAsRead();
    refetch();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="icon" className="relative">
            <Bell className="h-4 w-4" />
            {unreadCount > 0 && (
              <Badge
                className="absolute -top-1 -right-1 h-5 min-w-[20px] px-1 flex items-center justify-center bg-red-500 text-white text-xs rounded-full border-2 border-white"
              >
                {unreadCount > 99 ? "99+" : unreadCount}
              </Badge>
            )}
          </Button>
        }
      />
      <PopoverContent className="w-80 p-0" align="end">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="text-sm font-semibold">Notifications</h3>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-7"
              onClick={handleMarkAllRead}
            >
              <CheckCheck className="h-3 w-3 mr-1" />
              Mark all read
            </Button>
          )}
        </div>

        {/* Notification List */}
        <div className="max-h-[400px] overflow-y-auto">
          {notifications.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No notifications yet.
            </div>
          ) : (
            notifications.map((notification) => (
              <button
                key={notification.id}
                className={`w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors border-b last:border-b-0 ${
                  !notification.isRead ? "bg-blue-50/50" : ""
                }`}
                onClick={() => handleNotificationClick(notification)}
              >
                <div className="flex items-start gap-2.5">
                  <span
                    className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${
                      typeColors[notification.type] ?? "bg-gray-400"
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm truncate ${!notification.isRead ? "font-medium" : ""}`}>
                      {notification.title}
                    </p>
                    {notification.body && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {notification.body}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">
                      {timeAgo(notification.createdAt)}
                    </p>
                  </div>
                  {!notification.isRead && (
                    <span className="mt-1 h-2 w-2 rounded-full bg-blue-500 shrink-0" />
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
