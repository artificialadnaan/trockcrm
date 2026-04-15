import { Link } from "react-router-dom";
import { AlertTriangle, RefreshCcw, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BlindSpotCard } from "@/components/ai/blind-spot-card";
import { useCompanyCopilot } from "@/hooks/use-ai-copilot";

interface CompanyCopilotPanelProps {
  companyId: string;
}

function formatConfidence(value: number | null) {
  if (value == null || Number.isNaN(value)) return null;
  return `${Math.round(value * 100)}%`;
}

export function CompanyCopilotPanel({ companyId }: CompanyCopilotPanelProps) {
  const { data, loading, error, refetch } = useCompanyCopilot(companyId);

  if (loading) {
    return (
      <Card className="border-border/80">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            Account Copilot
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="h-4 rounded bg-muted animate-pulse" />
          <div className="h-4 w-5/6 rounded bg-muted animate-pulse" />
          <div className="h-16 rounded bg-muted animate-pulse" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="border-red-200">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-red-700 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Account Copilot
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-red-700">{error}</p>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/80">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              Account Copilot
            </CardTitle>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{data?.company.dealCount ?? 0} active deals</Badge>
              <Badge variant="outline">{data?.company.contactCount ?? 0} contacts</Badge>
              <Badge variant="secondary">{data?.blindSpotFlags.length ?? 0} blind spots</Badge>
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            <RefreshCcw className="mr-2 h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="rounded-lg border bg-background px-3 py-3 text-sm leading-6">
          {data?.summaryText ?? "No account copilot summary is available yet."}
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Related Deals
            </p>
            <Badge variant="secondary">{data?.relatedDeals.length ?? 0}</Badge>
          </div>
          {(data?.relatedDeals ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No active deals are linked to this account.</p>
          ) : (
            <div className="space-y-3">
              {(data?.relatedDeals ?? []).map((deal) => (
                <div key={deal.id} className="rounded-lg border bg-background px-3 py-3 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <Link to={`/deals/${deal.id}`} className="text-sm font-medium text-brand-red hover:underline">
                        {deal.dealNumber} {deal.name}
                      </Link>
                      {deal.latestPacketSummary && (
                        <p className="text-sm text-muted-foreground line-clamp-2">{deal.latestPacketSummary}</p>
                      )}
                    </div>
                    {formatConfidence(deal.latestPacketConfidence) && (
                      <Badge variant="outline">{formatConfidence(deal.latestPacketConfidence)}</Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Unresolved Suggested Tasks
            </p>
            <Badge variant="secondary">{data?.suggestedTasks.length ?? 0}</Badge>
          </div>
          {(data?.suggestedTasks ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No unresolved AI tasks are attached to this account.</p>
          ) : (
            <div className="space-y-3">
              {(data?.suggestedTasks ?? []).map((task) => (
                <div key={task.id} className="rounded-lg border bg-background px-3 py-3">
                  <p className="text-sm font-medium">{task.title}</p>
                  {task.description && (
                    <p className="mt-1 text-sm text-muted-foreground">{task.description}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Blind Spots
            </p>
            <Badge variant="secondary">{data?.blindSpotFlags.length ?? 0}</Badge>
          </div>
          {(data?.blindSpotFlags ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No open blind spots are attached to this account.</p>
          ) : (
            <div className="space-y-3">
              {(data?.blindSpotFlags ?? []).map((flag) => (
                <BlindSpotCard key={flag.id} flag={flag} />
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
