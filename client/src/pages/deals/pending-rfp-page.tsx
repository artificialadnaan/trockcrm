import { Hourglass, RefreshCw } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { usePendingRfp } from "@/hooks/use-deals";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const PENDING_RFP_STALE_DAYS = 2;

function computeAgeDays(triggeredAt: string | null): number | null {
  if (!triggeredAt) return null;
  const ms = Date.now() - new Date(triggeredAt).getTime();
  return Math.floor(ms / 86400000);
}

function formatAgeDays(days: number | null): string {
  if (days === null) return "—";
  return `${days}d`;
}

function subStateLabel(subState: "awaiting" | "attention", rfpApprovalStatus: string): string {
  if (subState === "awaiting") return "Awaiting approval";
  switch (rfpApprovalStatus) {
    case "declined":
      return "Declined";
    case "conflict":
      return "Conflict";
    case "send_failed":
      return "Send failed";
    default:
      return "Needs attention";
  }
}

export function PendingRfpPage() {
  const { deals, loading, error, refetch } = usePendingRfp();
  const location = useLocation();

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Hourglass className="h-5 w-5 text-amber-700" />
            <h1 className="text-2xl font-semibold">Pending RFP</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Deals awaiting RFP approval — visible to everyone in your office.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { void refetch().catch(() => undefined); }} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-red-700">{error}</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Queue</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <p className="p-4 text-sm text-muted-foreground">Loading pending RFPs...</p>
          ) : !error && deals && deals.length > 0 ? (
            // Suppress rows when the latest fetch errored: the hook keeps the prior `deals` (so a transient
            // blip doesn't blank the list), but rendering them under an error banner could show stale rows
            // from a previous ?officeId after a failed office switch. Error banner above stands alone.
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-3">Deal</th>
                    <th className="px-4 py-3">Rep</th>
                    <th className="px-4 py-3">Route</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Triggered by</th>
                    <th className="px-4 py-3">Waiting since</th>
                    <th className="px-4 py-3">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {deals.map((deal) => {
                    const ageDays = computeAgeDays(deal.triggeredAt);
                    const isStale = ageDays !== null && ageDays >= PENDING_RFP_STALE_DAYS;
                    const displayNumber = deal.projectNumber ?? deal.dealNumber;

                    return (
                      <tr
                        key={deal.id}
                        data-testid={`pending-rfp-row-${deal.id}`}
                        data-stale={isStale ? "true" : "false"}
                        className={`border-b transition-colors last:border-b-0 ${
                          isStale
                            ? "bg-red-50/60 hover:bg-red-50"
                            : "hover:bg-slate-50"
                        }`}
                      >
                        <td className="px-4 py-3">
                          <Link
                            to={`/deals/${deal.id}${location.search}`}
                            className="font-semibold text-slate-900 hover:text-brand-red hover:underline"
                          >
                            {deal.name}
                          </Link>
                          {displayNumber && (
                            <p className="text-xs text-muted-foreground">{displayNumber}</p>
                          )}
                        </td>
                        <td className="px-4 py-3 text-slate-700">
                          {deal.assignedRepName ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-slate-700 capitalize">
                          {deal.workflowRoute}
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            className={
                              deal.subState === "attention"
                                ? "bg-amber-100 text-amber-800 hover:bg-amber-100"
                                : "bg-slate-100 text-slate-700 hover:bg-slate-100"
                            }
                          >
                            {subStateLabel(deal.subState, deal.rfpApprovalStatus)}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-slate-700">
                          {deal.triggeredByName ?? "—"}
                        </td>
                        <td
                          className={`px-4 py-3 font-mono text-xs ${
                            isStale ? "font-bold text-red-700" : "text-slate-700"
                          }`}
                        >
                          {formatAgeDays(ageDays)}
                        </td>
                        <td className="px-4 py-3 text-slate-500">
                          {deal.reason ?? ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : !error ? (
            <p className="p-4 text-sm text-muted-foreground">
              No deals are currently awaiting RFP approval.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
