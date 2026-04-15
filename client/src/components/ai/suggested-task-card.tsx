import { CalendarClock, CheckSquare2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AiTaskSuggestion } from "@/hooks/use-ai-copilot";

interface SuggestedTaskCardProps {
  suggestion: AiTaskSuggestion;
  busy: boolean;
  onAccept: () => Promise<void>;
  onDismiss: () => Promise<void>;
}

const PRIORITY_STYLES: Record<string, string> = {
  urgent: "bg-red-100 text-red-800 border-red-200",
  high: "bg-orange-100 text-orange-800 border-orange-200",
  normal: "bg-blue-100 text-blue-800 border-blue-200",
  low: "bg-slate-100 text-slate-700 border-slate-200",
};

function formatDueAt(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

export function SuggestedTaskCard({
  suggestion,
  busy,
  onAccept,
  onDismiss,
}: SuggestedTaskCardProps) {
  const priorityClass = PRIORITY_STYLES[suggestion.priority] ?? PRIORITY_STYLES.normal;
  const dueLabel = formatDueAt(suggestion.suggestedDueAt);

  return (
    <div className="rounded-lg border border-border/80 bg-background px-3 py-3 space-y-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-full bg-brand-red/10 p-1.5 text-brand-red">
          <CheckSquare2 className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium leading-5">{suggestion.title}</p>
            <Badge variant="outline" className={priorityClass}>
              {suggestion.priority}
            </Badge>
          </div>
          {suggestion.description && (
            <p className="text-sm text-muted-foreground leading-5">{suggestion.description}</p>
          )}
          {dueLabel && (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <CalendarClock className="h-3.5 w-3.5" />
              Suggested due {dueLabel}
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void onAccept()}>
          Accept Task
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void onDismiss()}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
