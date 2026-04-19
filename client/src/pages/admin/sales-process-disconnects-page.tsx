import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, ArrowUpRight, MailWarning, RefreshCcw, ShieldAlert, TimerReset, Workflow } from "lucide-react";
import {
  queueAiDisconnectAdminTasks,
  queueAiDisconnectDigest,
  queueAiDisconnectEscalationScan,
  trackSalesProcessDisconnectInteraction,
  useSalesProcessDisconnectDashboard,
} from "@/hooks/use-ai-ops";
import { buildInterventionWorkspacePath } from "@/hooks/use-admin-interventions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button";
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

function buildPreservedRoute(path: string, searchParams: URLSearchParams) {
  const preserved = new URLSearchParams();
  const type = searchParams.get("type");
  const cluster = searchParams.get("cluster");
  const trend = searchParams.get("trend");

  if (type) preserved.set("type", type);
  if (cluster) preserved.set("cluster", cluster);
  if (trend) preserved.set("trend", trend);

  const query = preserved.toString();
  return query ? `${path}?${query}` : path;
}

function updatePreservedSearchParams(
  current: URLSearchParams,
  setSearchParams: ReturnType<typeof useSearchParams>[1],
  key: "type" | "cluster" | "trend",
  value: string,
  defaultValue: string
) {
  const nextParams = new URLSearchParams(current);
  if (value === defaultValue) {
    nextParams.delete(key);
  } else {
    nextParams.set(key, value);
  }
  setSearchParams(nextParams, { replace: true });
}

export function SalesProcessDisconnectsPage() {
  const { dashboard, loading, error, refetch } = useSalesProcessDisconnectDashboard(75);
  const [searchParams, setSearchParams] = useSearchParams();
  const [digestQueued, setDigestQueued] = useState(false);
  const [escalationQueued, setEscalationQueued] = useState(false);
  const [adminTasksQueued, setAdminTasksQueued] = useState(false);
  const didTrackView = useRef(false);
  const typeFilter = searchParams.get("type") || "all";
  const clusterFilter = searchParams.get("cluster") || "all";
  const trendParam = searchParams.get("trend");
  const trendDimension = trendParam === "stages" || trendParam === "companies" ? trendParam : "reps";
  const analyticsHref = buildPreservedRoute("/admin/intervention-analytics", searchParams);
  const workspaceHref = buildPreservedRoute("/admin/interventions", searchParams);

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
    updatePreservedSearchParams(searchParams, setSearchParams, "type", next, "all");
    void trackSalesProcessDisconnectInteraction({
      interactionType: "type_filter",
      targetValue: next,
    }).catch(() => {});
  };

  const handleClusterFilter = (next: string) => {
    updatePreservedSearchParams(searchParams, setSearchParams, "cluster", next, "all");
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
    updatePreservedSearchParams(searchParams, setSearchParams, "trend", next, "reps");
    void trackSalesProcessDisconnectInteraction({
      interactionType: "trend_focus",
      targetValue: next,
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

  const handleQueueAdminTasks = async () => {
    await queueAiDisconnectAdminTasks("manual");
    setAdminTasksQueued(true);
    void trackSalesProcessDisconnectInteraction({
      interactionType: "outcome_focus",
      targetValue: "admin_task_queue",
    }).catch(() => {});
  };

  return (
    <div className="p-6 space-y-6 bg-gray-50 min-h-screen">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black tracking-tighter uppercase text-gray-900">Sales Process Disconnects</h1>
          <p className="text-[11px] uppercase tracking-widest text-gray-400 mt-1">
            Source-side signal review for stalled follow-through, handoff gaps, and missing process steps
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to={analyticsHref} className={buttonVariants({ variant: "outline" })}>
            View Intervention Analytics
          </Link>
          <Link to={workspaceHref} className={buttonVariants({ variant: "outline" })}>
            Open Intervention Workspace
          </Link>
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
          <Button variant="outline" onClick={() => void handleQueueAdminTasks()} disabled={loading}>
            Queue Admin Tasks
          </Button>
        </div>
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
      {adminTasksQueued && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          Deterministic admin tasks queued for high-confidence disconnects.
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
          <CardTitle>Weekly Management Narrative</CardTitle>
          <CardDescription>
            Deterministic source signals summarized into a weekly review of what changed and where to look next
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 xl:grid-cols-[1.05fr_0.95fr] gap-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-4 space-y-3">
            <div className="text-xs uppercase tracking-widest text-amber-700">Headline</div>
            <div className="text-xl font-semibold text-amber-950">
              {dashboard?.narrative.headline ?? "Loading narrative..."}
            </div>
            <div className="text-sm leading-6 text-amber-900">
              {dashboard?.narrative.summary ?? "Summarizing current disconnect load..."}
            </div>
            <div className="rounded-md border border-amber-300/80 bg-white/70 px-3 py-3 text-sm text-amber-950">
              <span className="font-semibold">What changed:</span>{" "}
              {dashboard?.narrative.whatChanged ?? "Detecting current rep, stage, and company concentration..."}
            </div>
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-900">
              <span className="font-semibold">Admin focus:</span>{" "}
              {dashboard?.narrative.adminFocus ?? "Calculating the next best office/admin intervention..."}
            </div>
          </div>

          <div className="rounded-lg border border-border/80 bg-white px-4 py-4 space-y-3">
            <div>
              <div className="text-xs uppercase tracking-widest text-muted-foreground">Recommended interventions</div>
              <div className="text-lg font-semibold mt-1">Use these priorities in the digest and action queue</div>
            </div>
            <div className="space-y-2">
              {(dashboard?.narrative.recommendedActions ?? []).map((action) => (
                <div key={action} className="rounded-md border border-border/70 px-3 py-3 text-sm leading-6">
                  {action}
                </div>
              ))}
            </div>
            <div className="text-xs text-muted-foreground">
              This narrative is computed from current disconnect clusters, trend hotspots, and recent intervention outcomes.
              It explains the source signals; it does not replace the underlying deterministic data.
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Automation Status</CardTitle>
          <CardDescription>
            Live validation for digest, escalation, and deterministic admin-task automations
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 xl:grid-cols-[0.95fr_1.05fr] gap-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg border border-border/80 bg-white px-4 py-3">
              <div className="text-xs uppercase tracking-widest text-muted-foreground">Digests sent 7d</div>
              <div className="text-2xl font-black">{dashboard?.automation.digestNotifications7d ?? 0}</div>
              <div className="text-xs text-muted-foreground mt-1">Last: {formatDate(dashboard?.automation.latestDigestAt ?? null)}</div>
            </div>
            <div className="rounded-lg border border-border/80 bg-white px-4 py-3">
              <div className="text-xs uppercase tracking-widest text-muted-foreground">Escalations sent 7d</div>
              <div className="text-2xl font-black">{dashboard?.automation.escalationNotifications7d ?? 0}</div>
              <div className="text-xs text-muted-foreground mt-1">Last: {formatDate(dashboard?.automation.latestEscalationAt ?? null)}</div>
            </div>
            <div className="rounded-lg border border-border/80 bg-white px-4 py-3">
              <div className="text-xs uppercase tracking-widest text-muted-foreground">Admin tasks created 7d</div>
              <div className="text-2xl font-black">{dashboard?.automation.adminTasksCreated7d ?? 0}</div>
              <div className="text-xs text-muted-foreground mt-1">Last: {formatDate(dashboard?.automation.latestAdminTaskCreatedAt ?? null)}</div>
            </div>
            <div className="rounded-lg border border-border/80 bg-white px-4 py-3">
              <div className="text-xs uppercase tracking-widest text-muted-foreground">Open admin tasks</div>
              <div className="text-2xl font-black">{dashboard?.automation.adminTasksOpen ?? 0}</div>
              <div className="text-xs text-muted-foreground mt-1">Deterministic disconnect follow-through</div>
            </div>
          </div>

          <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-4 space-y-3">
            <div>
              <div className="text-xs uppercase tracking-widest text-blue-700">Scheduled cadence</div>
              <div className="text-lg font-semibold text-blue-950 mt-1">Production worker automation windows</div>
            </div>
            <div className="grid gap-2 text-sm text-blue-900">
              <div>Disconnect digest: weekdays at 7:15 AM CT</div>
              <div>Escalation scan: weekdays at 7:45 AM CT</div>
              <div>Admin task generation: weekdays at 7:30 AM CT</div>
            </div>
            <div className="text-xs text-blue-700">
              These counts come from real notifications and task records, so this section acts as live source-side validation after deploy.
            </div>
          </div>
        </CardContent>
      </Card>

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

                  <div className="flex items-center justify-end">
                    <Link
                      to={buildInterventionWorkspacePath({ view: "open", clusterKey: cluster.clusterKey })}
                      className={buttonVariants({ variant: "outline", size: "sm" })}
                    >
                      Open in workspace
                    </Link>
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
                {trend.clusterKeys[0] && (
                  <div className="mt-3">
                    <Link
                      to={buildInterventionWorkspacePath({ view: "aging", clusterKey: trend.clusterKeys[0] })}
                      className={buttonVariants({ variant: "outline", size: "sm" })}
                    >
                      Open hotspot in workspace
                    </Link>
                  </div>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Disconnect Types</CardTitle>
          <CardDescription>Filter the source signals to the process break you want to inspect</CardDescription>
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
          <CardContent className="py-12 text-center text-muted-foreground">Loading source signals...</CardContent>
        </Card>
      ) : filteredRows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No disconnects match the current signal filters.
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
                      <div className="pt-1">
                        <Link
                          to={buildInterventionWorkspacePath({
                            view: row.ageDays != null && row.ageDays >= 7 ? "aging" : "open",
                            clusterKey:
                              dashboard?.clusters.find((cluster) => cluster.disconnectTypes.includes(row.disconnectType))?.clusterKey ?? null,
                          })}
                          className={buttonVariants({ variant: "outline", size: "sm" })}
                        >
                          Open case queue
                        </Link>
                      </div>
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
