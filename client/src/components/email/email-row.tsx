import { ArrowDownLeft, ArrowUpRight, MoreHorizontal, Paperclip, RefreshCw, Unlink2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Email } from "@/hooks/use-emails";

interface EmailRowProps {
  email: Email;
  onClick?: (email: Email) => void;
  onReassign?: (email: Email) => void;
  onUnassign?: (email: Email) => void;
}

export function EmailRow({ email, onClick, onReassign, onUnassign }: EmailRowProps) {
  const isInbound = email.direction === "inbound";
  const date = new Date(email.sentAt);
  const isToday = new Date().toDateString() === date.toDateString();
  const timeStr = isToday
    ? date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  const displayAddress = isInbound
    ? email.fromAddress
    : email.toAddresses[0] ?? "Unknown";

  const showActions = Boolean(onReassign || onUnassign);

  return (
    <div
      className="flex items-start gap-3 p-3 border-b hover:bg-muted/50 cursor-pointer transition-colors"
      onClick={() => onClick?.(email)}
    >
      <div className="mt-1">
        {isInbound ? (
          <ArrowDownLeft className="h-4 w-4 text-blue-500" />
        ) : (
          <ArrowUpRight className="h-4 w-4 text-green-500" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{displayAddress}</span>
          {email.hasAttachments && (
            <Paperclip className="h-3 w-3 text-muted-foreground flex-shrink-0" />
          )}
          <span className="text-xs text-muted-foreground ml-auto flex-shrink-0">
            {timeStr}
          </span>
        </div>
        <p className="text-sm truncate">{email.subject ?? "(No Subject)"}</p>
        <p className="text-xs text-muted-foreground truncate">
          {email.bodyPreview ?? ""}
        </p>
      </div>

      <div className="flex flex-col items-end gap-1">
        <Badge
          variant="outline"
          className={`text-xs ${
            isInbound
              ? "border-blue-200 text-blue-700"
              : "border-green-200 text-green-700"
          }`}
        >
          {isInbound ? "In" : "Out"}
        </Badge>
      </div>

      {showActions && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 flex-shrink-0"
                aria-label="More email actions"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            {onReassign && (
              <DropdownMenuItem onClick={() => onReassign(email)}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Reassign to another deal…
              </DropdownMenuItem>
            )}
            {onUnassign && (
              <DropdownMenuItem onClick={() => onUnassign(email)}>
                <Unlink2 className="h-4 w-4 mr-2" />
                Unassign from this deal
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
