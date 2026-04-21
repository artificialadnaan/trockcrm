import { Link } from "react-router-dom";
import { ArrowUpRight, ClipboardList } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { CleanupReasonSummary } from "@/hooks/use-dashboard";

interface MyCleanupCardProps {
  total: number;
  byReason: CleanupReasonSummary[];
}

export function MyCleanupCard({ total, byReason }: MyCleanupCardProps) {
  const hasCleanup = total > 0;

  return (
    <Card className={`overflow-hidden ${hasCleanup ? "border-amber-200 bg-amber-50/40" : ""}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="text-base">My Cleanup</CardTitle>
            <p className="text-sm text-muted-foreground">
              {hasCleanup
                ? `${total} ${total === 1 ? "record needs" : "records need"} enrichment`
                : "No cleanup items are currently assigned to you."}
            </p>
          </div>
          <div className="rounded-full bg-amber-100 p-2 text-amber-700">
            <ClipboardList className="h-4 w-4" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="bg-amber-100 text-amber-900 hover:bg-amber-100">
            {total.toLocaleString()} open
          </Badge>
          {byReason.slice(0, 3).map((reason) => (
            <Badge key={reason.reasonCode} variant="outline" className="border-amber-200 bg-white text-slate-700">
              {reason.reasonCode.replace(/_/g, " ")} · {reason.count}
            </Badge>
          ))}
        </div>
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            Review the active leads and deals that still need your attention.
          </p>
          <Link
            to="/pipeline/my-cleanup"
            className="inline-flex items-center gap-1 text-sm font-semibold text-amber-800 hover:text-amber-900"
          >
            Open queue
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
