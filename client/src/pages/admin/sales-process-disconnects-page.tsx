import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowUpRight, MailWarning, RefreshCcw, ShieldAlert, TimerReset, Workflow } from "lucide-react";
import {
  queueAiDisconnectDigest,
  queueAiDisconnectEscalationScan,
  trackSalesProcessDisconnectInteraction,
  useSalesProcessDisconnectDashboard,
} from "@/hooks/use-ai-ops";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const severityClasses: Record<string, string> = {
  critical: "bg-red-100 text-red-800 border-red-200",
  high: "bg-orange-100 text-orange-800 border-orange-200",
  medium: "bg-amber-100 text-amber-800 border-amber-200",
  low: "bg-slate-100 text-slate-700 border-slate-200",
};

function formatDate(value: string | null) {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return date.toLocaleString();
}

export function SalesProcessDisconnectsPage() {
  const { dashboard, loading, error, refetch } = useSalesProcessDisconnectDashboard(75);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [clusterFilter, setClusterFilter] = useState<string>("all");
  const [trendDimension, setTrendDimension] = useState<"reps" | "stages" | "companies">("reps");
  const [digestQueued, setDigestQueued] = useState(false);
  const [escalationQueued, setEscalationQueued] = useState(false);
  const didTrackView = useRef(false);

  useEffect(() => {
    if (!dashboard || didTrackView.current) return;
    didTrackView.current = true;
    void trackSalesProcessDisconnectInteraction({
      interactionType: "dashboard_view",
      targetValue: "sales_process_disconnect_dashboard",
      comment: `disconnects:${dashboard.summary.totalDisconnects}`,
    }).catch(() => {});
  }, [dashboard]);

  const filteredRows = useMemo(() => {
    if (!dashboard) return [];
    return dashboard.rows.filter((row) => {
      const clusterMatch =
        clusterFilter === "all" ||
        dashboard.clusters
          .find((cluster) => cluster.clusterKey === clusterFilter)
          ?.disconnectTypes.includes(row.disconnectType) === true;
      const typeMatch = typeFilter === "all" || row.disconnectType === typeFilter;
      return clusterMatch && typeMatch;
    });
  }, [clusterFilter, dashboard, typeFilter]);

  const handleFilter = (next: string) => {
    setTypeFilter(next);
    void trackSalesProcessDisconnectInteraction({
      interactionType: "type_filter",
      targetValue: next,
    }).catch(() => {});
  };

  const handleClusterFilter = (next: string) => {
    setClusterFilter(next);
    void trackSalesProcessDisconnectInteraction({
      interactionType: "cluster_filter",
      targetValue: next,
    }).catch(() => {});
  };

  const handleDealClick = (disconnectType: string, dealId: string) => {
    void trackSalesProcessDisconnectInteraction({
      interactionType: "deal_click",
      targetValue: disconnectType,
      comment: dealId,
    }).catch(() => {});
  };

  const handleTrendDimension = (next: "reps" | "stages" | "companies") => {
    setTrendDimension(next);
    void trackSalesProcessDisconnectInteraction({
      interactionType: "trend_focus",
      targetValue: next,
    }).catch(() => {});
  };

  const handleOutcomeFocus = (next: string) => {
    void trackSalesProcessDisconnectInteraction({
      interactionType: "outcome_focus",
      targetValue: next,
    }).catch(() => {});
  };

  const handlePlaybookFocus = (next: string) => {
    void trackSalesProcessDisconnectInteraction({
      interactionType: "outcome_focus",
      targetValue: `playbook:${next}`,
    }).catch(() => {});
  };

  const handleQueueDigest = async () => {
    await queueAiDisconnectDigest("manual");
    setDigestQueued(true);
    void trackSalesProcessDisconnectInteraction({
      interactionType: "outcome_focus",
      targetValue: "digest_queue",
    }).catch(() => {});
  };

  const handleQueueEscalation = async () => {
    await queueAiDisconnectEscalationScan("manual");
    setEscalationQueued(true);
    void trackSalesProcessDisconnectInteraction({
      interactionType: "outcome_focus",
      targetValue: "escalation_scan_queue",
    }).catch(() => {});
  };

  return (
    <div className="p-6 space-y-6 bg-gray-50 min-h-screen">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black tracking-tighter uppercase text-gray-900">Sales Process Disconnects</h1>
          <p className="text-[11px] uppercase tracking-widest text-gray-400 mt-1">
            Office and admin visibility into stalled follow-through, handoff gaps, and missing process steps
          </p>
        </div>
        <Button variant="outline" onClick={() => void refetch()} disabled={loading}>
          <RefreshCcw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
        <Button variant="default" onClick={() => void handleQueueDigest()} disabled={loading}>
          Queue Digest
        </Button>
        <Button variant="outline" onClick={() => void handleQueueEscalation()} disabled={loading}>
          Queue Escalation Scan
        </Button>
      </div>

      {digestQueued && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Disconnect digest queued for admin/director notifications.
        </div>
      )}
      {escalationQueued && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-800">
          Disconnect escalation scan queued for critical issue notifications.
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> Disconnect Volume</CardTitle>
            <CardDescription>Total process gaps across active deals</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-4xl font-black">{dashboard?.summary.totalDisconnects ?? 0}</div>
            <div className="text-sm text-muted-foreground">{dashboard?.summary.activeDeals ?? 0} active deals monitored</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><TimerReset className="h-4 w-4" /> Stalled Execution</CardTitle>
            <CardDescription>Deals losing momentum or lacking next steps</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div>{dashboard?.summary.staleStageCount ?? 0} stale stage disconnects</div>
            <div>{dashboard?.summary.missingNextTaskCount ?? 0} deals missing next tasks</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Workflow className="h-4 w-4" /> Handoff Gaps</CardTitle>
            <CardDescription>Sales, estimating, and customer-response disconnects</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div>{dashboard?.summary.revisionLoopCount ?? 0} revision loops</div>
            <div>{dashboard?.summary.estimatingGateGapCount ?? 0} estimating gate gaps</div>
            <div>{dashboard?.summary.inboundWithoutFollowupCount ?? 0} inbound emails with no follow-up</div>
            <div>{dashboard?.summary.procoreBidBoardDriftCount ?? 0} bid board sync drifts</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Root Cause Clusters</CardTitle>
          <CardDescription>
            Grouped disconnect patterns across CRM execution and Procore bid-board sync drift
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              variant={clusterFilter === "all" ? "default" : "outline"}
              size="sm"
              onClick={() => handleClusterFilter("all")}
            >
              All clusters
            </Button>
            {(dashboard?.clusters ?? []).map((cluster) => (
              <Button
                key={cluster.clusterKey}
                variant={clusterFilter === cluster.clusterKey ? "default" : "outline"}
                size="sm"
                onClick={() => handleClusterFilter(cluster.clusterKey)}
              >
                {cluster.title} ({cluster.dealCount})
              </Button>
            ))}
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {(dashboard?.clusters ?? []).map((cluster) => (
              <Card
                key={cluster.clusterKey}
                className={clusterFilter === cluster.clusterKey ? "border-brand-red/40 shadow-sm" : "border-border/80"}
              >
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className={severityClasses[cluster.severity] ?? severityClasses.low}>
                          {cluster.severity}
                        </Badge>
                        {cluster.includesProcoreBidBoard && (
                          <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">
                            Includes bid board sync
                          </Badge>
                        )}
                      </div>
                      <div className="text-base font-semibold">{cluster.title}</div>
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      <div>{cluster.dealCount} deals</div>
                      <div>{cluster.disconnectCount} disconnects</div>
                    </div>
                  </div>

                  <div className="text-sm text-muted-foreground leading-6">{cluster.summary}</div>

                  <div className="space-y-1 text-sm">
                    <div><span className="font-semibold text-foreground">Likely root cause:</span> {cluster.likelyRootCause}</div>
                    <div><span className="font-semibold text-foreground">Recommended action:</span> {cluster.recommendedAction}</div>
                  </div>

                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {cluster.stages.map((stage) => (
                      <Badge key={`${cluster.clusterKey}:stage:${stage}`} variant="secondary">{stage}</Badge>
                    ))}
                    {cluster.reps.map((rep) => (
                      <Badge key={`${cluster.clusterKey}:rep:${rep}`} variant="outline">{rep}</Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.8fr] gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Trend Hotspots</CardTitle>
            <CardDescription>
              Where disconnect clusters are concentrating by owner, stage, and company
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button variant={trendDimension === "reps" ? "default" : "outline"} size="sm" onClick={() => handleTrendDimension("reps")}>
                Reps
              </Button>
              <Button variant={trendDimension === "stages" ? "default" : "outline"} size="sm" onClick={() => handleTrendDimension("stages")}>
                Stages
              </Button>
              <Button variant={trendDimension === "companies" ? "default" : "outline"} size="sm" onClick={() => handleTrendDimension("companies")}>
                Companies
              </Button>
            </div>

            <div className="space-y-3">
              {(dashboard?.trends?.[trendDimension] ?? []).map((trend) => (
                <div key={`${trendDimension}:${trend.key}`} className="rounded-lg border border-border/80 bg-white px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="font-semibold text-sm">{trend.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {trend.dealCount} deals · {trend.disconnectCount} disconnects · {trend.criticalCount} critical
                      </div>
                    </div>
                    {trend.recentInterventionCount > 0 && (
                      <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                        {trend.recentInterventionCount} recent intervention{trend.recentInterventionCount === 1 ? "" : "s"}
                      </Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2 mt-3">
                    {trend.clusterKeys.map((clusterKey) => (
                      <Badge key={`${trend.key}:${clusterKey}`} variant="secondary">{clusterKey.split("_").join(" ")}</Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Intervention Outcomes</CardTitle>
            <CardDescription>
              Whether recent triage activity is actually reducing currently open disconnects
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <button
              type="button"
              onClick={() => handleOutcomeFocus("intervention_deals_30d")}
              className="w-full rounded-lg border border-border/80 bg-white px-4 py-3 text-left"
            >
              <div className="text-xs uppercase tracking-widest text-muted-foreground">Deals with interventions</div>
              <div className="text-2xl font-black">{dashboard?.outcomes.interventionDeals30d ?? 0}</div>
            </button>
            <button
              type="button"
              onClick={() => handleOutcomeFocus("clearance_rate_30d")}
              className="w-full rounded-lg border border-border/80 bg-white px-4 py-3 text-left"
            >
              <div className="text-xs uppercase tracking-widest text-muted-foreground">Clearance rate</div>
              <div className="text-2xl font-black">
                {dashboard?.outcomes.clearanceRate30d == null ? "N/A" : `${Math.round(dashboard.outcomes.clearanceRate30d * 100)}%`}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {dashboard?.outcomes.clearedAfterIntervention30d ?? 0} cleared / {dashboard?.outcomes.interventionDeals30d ?? 0} intervened
              </div>
            </button>
            <button
              type="button"
              onClick={() => handleOutcomeFocus("still_open_after_intervention")}
              className="w-full rounded-lg border border-border/80 bg-white px-4 py-3 text-left"
            >
              <div className="text-xs uppercase tracking-widest text-muted-foreground">Still open after intervention</div>
              <div className="text-2xl font-black">{dashboard?.outcomes.stillOpenAfterIntervention30d ?? 0}</div>
            </button>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-lg border border-border/80 bg-white px-4 py-3">
                <div className="text-xs uppercase tracking-widest text-muted-foreground">Escalations still open</div>
                <div className="text-xl font-black">{dashboard?.outcomes.unresolvedEscalationsOpen ?? 0}</div>
              </div>
              <div className="rounded-lg border border-border/80 bg-white px-4 py-3">
                <div className="text-xs uppercase tracking-widest text-muted-foreground">Repeat issue deals</div>
                <div className="text-xl font-black">{dashboard?.outcomes.repeatIssueDealsOpen ?? 0}</div>
              </div>
              <div className="rounded-lg border border-border/80 bg-white px-4 py-3">
                <div className="text-xs uppercase tracking-widest text-muted-foreground">Repeat cluster deals</div>
                <div className="text-xl font-black">{dashboard?.outcomes.repeatClusterDealsOpen ?? 0}</div>
              </div>
              <div className="rounded-lg border border-border/80 bg-white px-4 py-3">
                <div className="text-xs uppercase tracking-widest text-muted-foreground">Coverage on open deals</div>
                <div className="text-xl font-black">
                  {dashboard?.outcomes.interventionCoverageRate == null
                    ? "N/A"
                    : `${Math.round(dashboard.outcomes.interventionCoverageRate * 100)}%`}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[0.85fr_1.15fr] gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Action Scoreboard</CardTitle>
            <CardDescription>
              Which triage actions are currently correlating with clearance across admin intervention work
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
              <div className="text-xs uppercase tracking-widest text-emerald-700">Best overall action</div>
              <div className="text-2xl font-black text-emerald-900">
                {dashboard?.actionSummary.bestOverallAction ? dashboard.actionSummary.bestOverallAction.split("_").join(" ") : "N/A"}
              </div>
              <div className="text-xs text-emerald-700 mt-1">
                {dashboard?.actionSummary.bestOverallClearanceRate == null
                  ? "No recent outcome data yet"
                  : `${Math.round(dashboard.actionSummary.bestOverallClearanceRate * 100)}% clearance rate`}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-lg border border-border/80 bg-white px-4 py-3">
                <div className="text-xs uppercase tracking-widest text-muted-foreground">Mark reviewed</div>
                <div className="text-xl font-black">{dashboard?.actionSummary.markReviewed30d ?? 0}</div>
              </div>
              <div className="rounded-lg border border-border/80 bg-white px-4 py-3">
                <div className="text-xs uppercase tracking-widest text-muted-foreground">Resolve</div>
                <div className="text-xl font-black">{dashboard?.actionSummary.resolve30d ?? 0}</div>
              </div>
              <div className="rounded-lg border border-border/80 bg-white px-4 py-3">
                <div className="text-xs uppercase tracking-widest text-muted-foreground">Dismiss</div>
                <div className="text-xl font-black">{dashboard?.actionSummary.dismiss30d ?? 0}</div>
              </div>
              <div className="rounded-lg border border-border/80 bg-white px-4 py-3">
                <div className="text-xs uppercase tracking-widest text-muted-foreground">Escalate</div>
                <div className="text-xl font-black">{dashboard?.actionSummary.escalate30d ?? 0}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Intervention Playbooks</CardTitle>
            <CardDescription>
              Cluster-specific action guidance based on recent intervention outcomes and still-open disconnects
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {(dashboard?.playbooks ?? []).map((playbook) => (
              <div key={playbook.clusterKey} className="rounded-lg border border-border/80 bg-white px-4 py-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="font-semibold">{playbook.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {playbook.interventionDeals30d} intervened deals · {playbook.stillOpenDeals30d} still open
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => handlePlaybookFocus(playbook.clusterKey)}>
                    Focus
                  </Button>
                </div>

                <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm">
                  <span className="font-semibold text-emerald-900">Recommended action:</span>{" "}
                  <span className="text-emerald-800">
                    {playbook.recommendedAction ? playbook.recommendedAction.split("_").join(" ") : "No recommendation yet"}
                  </span>
                </div>

                <div className="space-y-2">
                  {playbook.actions.map((action) => (
                    <div key={`${playbook.clusterKey}:${action.action}`} className="flex items-center justify-between gap-4 rounded-md border border-border/70 px-3 py-2 text-sm">
                      <div>
                        <div className="font-medium">{action.action.split("_").join(" ")}</div>
                        <div className="text-xs text-muted-foreground">
                          {action.interventionDeals30d} interventions · {action.clearedDeals30d} cleared · {action.stillOpenDeals30d} still open
                        </div>
                      </div>
                      <Badge variant="outline">
                        {action.clearanceRate30d == null ? "N/A" : `${Math.round(action.clearanceRate30d * 100)}%`}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Disconnect Types</CardTitle>
          <CardDescription>Filter the dashboard to the process break you want to inspect</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant={typeFilter === "all" ? "default" : "outline"} size="sm" onClick={() => handleFilter("all")}>
            All
          </Button>
          {(dashboard?.byType ?? []).map((item) => (
            <Button
              key={item.disconnectType}
              variant={typeFilter === item.disconnectType ? "default" : "outline"}
              size="sm"
              onClick={() => handleFilter(item.disconnectType)}
            >
              {item.label} ({item.count})
            </Button>
          ))}
        </CardContent>
      </Card>

      {loading ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">Loading disconnect dashboard...</CardContent>
        </Card>
      ) : filteredRows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No disconnects match the current filter.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {filteredRows.map((row) => (
            <Card key={`${row.disconnectType}:${row.id}`} className="border-border/80">
              <CardContent className="p-5 space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-2 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className={severityClasses[row.disconnectSeverity] ?? severityClasses.low}>
                        {row.disconnectSeverity}
                      </Badge>
                      <Badge variant="outline">{row.disconnectLabel}</Badge>
                      {row.stageName && (
                        <span className="text-xs text-muted-foreground">Stage {row.stageName}</span>
                      )}
                      {row.estimatingSubstage && (
                        <span className="text-xs text-muted-foreground">Substage {row.estimatingSubstage}</span>
                      )}
                      {row.ageDays != null && (
                        <span className="text-xs text-muted-foreground">{row.ageDays} days</span>
                      )}
                    </div>

                    <div className="space-y-1">
                      <Link
                        to={`/deals/${row.id}`}
                        onClick={() => handleDealClick(row.disconnectType, row.id)}
                        className="text-sm font-semibold text-brand-red hover:underline inline-flex items-center gap-1"
                      >
                        {row.dealNumber} {row.dealName}
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </Link>
                      <div className="text-base font-semibold text-foreground">{row.disconnectSummary}</div>
                      {row.disconnectDetails && (
                        <div className="text-sm text-muted-foreground leading-6">{row.disconnectDetails}</div>
                      )}
                    </div>
                  </div>

                    <div className="grid gap-2 text-right text-sm text-muted-foreground">
                    <div>Rep: {row.assignedRepName ?? "Unassigned"}</div>
                    <div>Open tasks: {row.openTaskCount}</div>
                    <div>Inbound no follow-up: {row.inboundWithoutFollowupCount}</div>
                    <div>Last activity: {formatDate(row.lastActivityAt)}</div>
                    <div>Latest customer email: {formatDate(row.latestCustomerEmailAt)}</div>
                    {row.proposalStatus && <div>Proposal: {row.proposalStatus}</div>}
                    {row.procoreSyncStatus && <div>Procore sync: {row.procoreSyncStatus}</div>}
                  </div>
                </div>

                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {row.disconnectType === "inbound_without_followup" && <MailWarning className="h-3.5 w-3.5" />}
                  {row.disconnectType === "stale_stage" && <TimerReset className="h-3.5 w-3.5" />}
                  {row.disconnectType !== "inbound_without_followup" && row.disconnectType !== "stale_stage" && (
                    <AlertTriangle className="h-3.5 w-3.5" />
                  )}
                  {row.disconnectType === "procore_bid_board_drift"
                    ? "Bid board drift detected from Procore sync state. AI should help explain the pattern, not decide whether drift exists."
                    : "Deterministic CRM disconnect detected. AI should explain and prioritize this, not invent it."}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
