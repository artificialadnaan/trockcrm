import { Clock } from "lucide-react";

interface DealTimelineTabProps {
  dealId: string;
}

/**
 * Activity timeline for the deal. Will be fully implemented in Plan 3 (Activities).
 * For now, shows a placeholder that signals where the feed will go.
 */
export function DealTimelineTab({ _dealId }: { _dealId: string }) {
  return (
    <div className="text-center py-12 text-muted-foreground">
      <Clock className="h-12 w-12 mx-auto mb-3 opacity-30" />
      <p className="text-lg font-medium">Activity Timeline</p>
      <p className="text-sm">
        Call logs, emails, notes, and meetings for this deal will appear here.
      </p>
      <p className="text-xs mt-2">Coming in Plan 3: Activities & Contacts</p>
    </div>
  );
}

export type { DealTimelineTabProps };
