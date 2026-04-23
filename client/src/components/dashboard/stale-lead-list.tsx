import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle } from "lucide-react";
import { type StaleLeadViewRow } from "@/lib/stale-lead-dashboard";
import { formatCurrency } from "@/components/charts/chart-colors";

function formatRouteLabel(route: "normal" | "service" | undefined) {
  return route === "service" ? "Service path" : "Normal path";
}

interface StaleLeadListProps {
  leads: StaleLeadViewRow[];
  dateRange?: { from?: string; to?: string };
}

export function StaleLeadList({ leads, dateRange }: StaleLeadListProps) {
  void dateRange;
  const meta = {
    label: "Current-state lead watchlist",
    detail: "Snapshot as of today. Not filtered by the selected reporting period.",
  };

  if (leads.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            {meta.label}
          </CardTitle>
          <p className="text-sm text-muted-foreground">{meta.detail}</p>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm text-center py-4">
            No stale leads. Lead-stage opportunities are progressing on time.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          {meta.label}
          <Badge variant="secondary" className="ml-auto">{leads.length}</Badge>
        </CardTitle>
        <p className="text-sm text-muted-foreground">{meta.detail}</p>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {leads.slice(0, 10).map((lead) => (
            <div
              key={lead.leadId}
              className="flex items-center justify-between rounded-md p-2 hover:bg-slate-50 transition-colors"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{lead.leadName}</p>
                <p className="text-xs text-muted-foreground">
                  {lead.repName} - {lead.stageName} - {formatRouteLabel(lead.pipelineType)}
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {lead.companyName} - {lead.propertyName}
                </p>
                {(lead.locationLabel || lead.estimatedValue || lead.staleThresholdDays) && (
                  <p className="text-xs text-muted-foreground truncate">
                    {lead.locationLabel ? `${lead.locationLabel} - ` : ""}
                    {lead.estimatedValue ? `${formatCurrency(lead.estimatedValue)} - ` : ""}
                    {lead.staleThresholdDays ? `${lead.daysInStage}d / ${lead.staleThresholdDays}d target` : `${lead.daysInStage}d`}
                  </p>
                )}
              </div>
              <div className="ml-3 shrink-0 text-right">
                <p className="text-sm font-medium text-amber-600">{lead.daysInStage}d</p>
                {typeof lead.daysPastDue === "number" && lead.daysPastDue > 0 ? (
                  <p className="text-[11px] text-muted-foreground">+{lead.daysPastDue}d past due</p>
                ) : null}
              </div>
            </div>
          ))}
          {leads.length > 10 && (
            <p className="text-xs text-muted-foreground text-center pt-2">
              +{leads.length - 10} more stale leads
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
