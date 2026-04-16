import { AlertTriangle, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useDirectorBlindSpots } from "@/hooks/use-ai-copilot";

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-red-100 text-red-800 border-red-200",
  high: "bg-orange-100 text-orange-800 border-orange-200",
  medium: "bg-amber-100 text-amber-800 border-amber-200",
  low: "bg-slate-100 text-slate-700 border-slate-200",
};

function formatCreatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString();
}

export function DirectorBlindSpotList() {
  const { blindSpots, loading, error, refetch } = useDirectorBlindSpots();

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-3">
        <div className="h-4 w-36 rounded bg-gray-100 animate-pulse" />
        <div className="h-16 rounded bg-gray-100 animate-pulse" />
        <div className="h-16 rounded bg-gray-100 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <h3 className="text-xs font-bold uppercase tracking-widest text-gray-500">
            AI Blind Spots
          </h3>
        </div>
        <Badge variant="secondary">{blindSpots.length}</Badge>
      </div>

      {error ? (
        <div className="space-y-3 rounded-lg border border-red-200 bg-red-50 px-3 py-3">
          <p className="text-sm text-red-700">{error}</p>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      ) : blindSpots.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No open blind spots are flagged right now.
        </p>
      ) : (
        <div className="space-y-3">
          {blindSpots.slice(0, 6).map((blindSpot) => {
            const severityClass = SEVERITY_STYLES[blindSpot.severity] ?? SEVERITY_STYLES.low;
            const createdAtLabel = formatCreatedAt(blindSpot.createdAt);
            const content = (
              <div className="rounded-lg border border-gray-200 px-3 py-3 transition-colors hover:bg-gray-50">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-gray-900">
                        {blindSpot.dealName ?? "Unlinked deal"}
                      </p>
                      {blindSpot.dealNumber && (
                        <span className="text-[11px] font-mono text-gray-400">
                          {blindSpot.dealNumber}
                        </span>
                      )}
                    </div>
                    <p className="text-sm font-medium text-gray-800">{blindSpot.title}</p>
                    {blindSpot.details && (
                      <p className="text-sm text-muted-foreground leading-5">{blindSpot.details}</p>
                    )}
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className={severityClass}>
                        {blindSpot.severity}
                      </Badge>
                      {createdAtLabel && (
                        <span className="text-[11px] uppercase tracking-wide text-gray-400">
                          Flagged {createdAtLabel}
                        </span>
                      )}
                    </div>
                  </div>
                  {blindSpot.dealId && (
                    <ChevronRight className="mt-0.5 h-4 w-4 text-gray-400" />
                  )}
                </div>
              </div>
            );

            return blindSpot.dealId ? (
              <Link key={blindSpot.id} to={`/deals/${blindSpot.dealId}`} className="block">
                {content}
              </Link>
            ) : (
              <div key={blindSpot.id}>{content}</div>
            );
          })}
        </div>
      )}
    </div>
  );
}
