import { RepDashboardBoardShell } from "@/components/dashboard/rep-dashboard-board-shell";
import { useRepDashboard } from "@/hooks/use-dashboard";
import { useAuth } from "@/lib/auth";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/layout/page-header";
import { PipelineBarChart } from "@/components/charts/pipeline-bar-chart";
import { formatCurrency } from "@/components/charts/chart-colors";
import { useTasks } from "@/hooks/use-tasks";
import { TaskSection } from "@/components/tasks/task-section";
import { FunnelBucketRow } from "@/components/dashboard/funnel-bucket-row";
import { changeDealStage, useDealBoard } from "@/hooks/use-deals";
import { transitionLeadStage, useLeadBoard } from "@/hooks/use-leads";
import { usePipelineBoardState } from "@/hooks/use-pipeline-board-state";
import { getWorkflowRouteLabel } from "@/lib/pipeline-ownership";
import { usePipelineStages } from "@/hooks/use-pipeline-config";
import { buildCanonicalDealBoardColumns } from "@/lib/canonical-deal-board";
import { toast } from "sonner";
import { useEffect, useMemo, useState } from "react";
import { ActivityRangeSelect } from "@/components/dashboard/activity-range-select";
import { DEFAULT_ACTIVITY_RANGE, type ActivityRange } from "@trock-crm/shared/types";
import { ArrowUpRight, FileSignature, FilePen, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const EYEBROW = "text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground";

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function formatRelativeTime(date: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return formatShortDate(date.toISOString());
}

function useFreshness(fetchedAt: Date | null): string | null {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  if (!fetchedAt) return null;
  return formatRelativeTime(fetchedAt, now);
}

function KpiCell({
  label,
  value,
  subtitle,
  emphasis = "neutral",
  onClick,
}: {
  label: string;
  value: string | number;
  subtitle?: string;
  emphasis?: "neutral" | "danger" | "warning";
  onClick?: () => void;
}) {
  const valueClass =
    emphasis === "danger"
      ? "text-brand-red"
      : emphasis === "warning"
        ? "text-amber-700"
        : "text-slate-950";
  const baseClass = "flex flex-col items-start gap-1 text-left";
  const body = (
    <>
      <p className={EYEBROW}>{label}</p>
      <p className={`text-2xl font-bold leading-none ${valueClass}`}>{value}</p>
      {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`${baseClass} cursor-pointer transition-opacity hover:opacity-70`}
      >
        {body}
      </button>
    );
  }
  return <div className={baseClass}>{body}</div>;
}

function SnapshotCard({
  title,
  emptyLabel,
  actionLabel,
  onAction,
  onOpen,
  rows,
}: {
  title: string;
  emptyLabel: string;
  actionLabel: string;
  onAction: () => void;
  onOpen: (href: string) => void;
  rows: Array<{
    id: string;
    name: string;
    metaPrimary: string;
    metaSecondary: string;
    badge: string;
    rightLabel: string;
    href: string;
  }>;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b pb-3">
        <div className="flex items-start justify-between gap-4">
          <CardTitle className="text-lg text-slate-950">{title}</CardTitle>
          <Button variant="outline" size="sm" onClick={onAction}>
            {actionLabel}
            <ArrowUpRight className="ml-1 h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div className="px-6 py-8 text-sm text-muted-foreground">{emptyLabel}</div>
        ) : (
          <div className="divide-y">
            {rows.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => onOpen(row.href)}
                className="flex w-full items-start justify-between gap-4 px-6 py-4 text-left transition-colors hover:bg-slate-50"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold text-slate-950">{row.name}</p>
                    <Badge variant="outline">{row.badge}</Badge>
                  </div>
                  <p className="mt-1 truncate text-sm text-slate-600">{row.metaPrimary}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{row.metaSecondary}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-medium text-slate-900">{row.rightLabel}</p>
                  <p className="mt-1 text-xs text-muted-foreground">Open record</p>
                </div>
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function RepDashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const boardState = usePipelineBoardState("deals");
  const [activityRange, setActivityRange] = useState<ActivityRange>(DEFAULT_ACTIVITY_RANGE);
  const { data, loading, error, fetchedAt, refetch } = useRepDashboard({ range: activityRange });
  const freshness = useFreshness(fetchedAt);
  const {
    board: dealBoard,
    loading: dealBoardLoading,
    error: dealBoardError,
    refetch: refetchDealBoard,
  } = useDealBoard("mine", true);
  const {
    board: leadBoard,
    loading: leadBoardLoading,
    error: leadBoardError,
    refetch: refetchLeadBoard,
  } = useLeadBoard("mine");
  const { stages } = usePipelineStages();
  const { tasks: overdueTasks, refetch: refetchOverdue } = useTasks({ section: "overdue", limit: 50 });
  const { tasks: todayTasks, refetch: refetchToday } = useTasks({ section: "today", limit: 50 });
  const firstName = user?.displayName?.split(" ")[0] ?? "there";

  const refetchTasks = () => {
    refetchOverdue();
    refetchToday();
  };
  const refreshAll = () => {
    refetch();
    refetchDealBoard();
    refetchLeadBoard();
    refetchTasks();
  };
  const visibleLeadColumns = leadBoard?.columns ?? [];
  const canonicalDealBoard = useMemo(
    () =>
      dealBoard == null
        ? null
        : {
            ...dealBoard,
            columns: buildCanonicalDealBoardColumns(dealBoard.columns, stages),
          },
    [dealBoard, stages]
  );

  const handleBoardMove = async (input: {
    activeId: string;
    targetStageId: string;
    targetStageSlug: string;
    entity: "deal" | "lead";
  }) => {
    if (input.entity === "deal") {
      try {
        await changeDealStage(input.activeId, input.targetStageId);
        await refetchDealBoard();
      } catch (moveError) {
        toast.error(moveError instanceof Error ? moveError.message : "Failed to move deal");
      }
      return;
    }

    const nextStageById = new Map(
      visibleLeadColumns.map((column, index, columns) => [
        column.stage.id,
        columns[index + 1]?.stage.id ?? null,
      ])
    );
    const sourceColumn = visibleLeadColumns.find((column) =>
      column.cards.some((card) => card.id === input.activeId)
    );

    if (!sourceColumn) {
      return;
    }

    if (nextStageById.get(sourceColumn.stage.id) !== input.targetStageId) {
      toast.error("Leads can only move one stage forward at a time.");
      return;
    }

    try {
      const result = await transitionLeadStage(input.activeId, { targetStageId: input.targetStageId });
      if (!result.ok) {
        toast.error(result.missing.map((field) => field.label).join(", "));
        return;
      }
      await refetchLeadBoard();
    } catch (moveError) {
      toast.error(moveError instanceof Error ? moveError.message : "Failed to move lead");
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title={`Welcome back, ${firstName}`} description="Loading today's signal..." />
        <section aria-label="My Board">
          <RepDashboardBoardShell
            activeEntity={boardState.activeEntity}
            onEntityChange={boardState.setActiveEntity}
            dealBoard={canonicalDealBoard}
            leadBoard={leadBoard}
            loading={boardState.activeEntity === "deals" ? dealBoardLoading : leadBoardLoading}
            error={boardState.activeEntity === "deals" ? dealBoardError : leadBoardError}
            onMove={handleBoardMove}
          />
        </section>
        <Card className="animate-pulse">
          <CardContent className="h-24 p-4" />
        </Card>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="h-32 p-4" />
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title={`Welcome back, ${firstName}`} />
        <Card>
          <CardContent className="space-y-3 p-6 text-center">
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button variant="outline" onClick={refreshAll}>
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data) return null;

  const cleanupCount = data.myCleanup.total;
  const ownershipCount = data.myCleanup.byReason
    .filter((reason) => reason.reasonCode.includes("owner"))
    .reduce((sum, reason) => sum + reason.count, 0);
  const headerSummary = [
    data.tasksToday.overdue > 0 ? `${data.tasksToday.overdue} overdue` : null,
    cleanupCount > 0 ? `${cleanupCount} to fix` : null,
    `${data.activeDeals.count} open deals`,
  ]
    .filter(Boolean)
    .join(" • ");
  const leadsSnapshot = data.leadSnapshot.map((lead) => ({
    id: lead.leadId,
    name: lead.leadName,
    metaPrimary: [lead.companyName, lead.propertyName].filter(Boolean).join(" • ") || "No company or property linked",
    metaSecondary: `Updated ${formatShortDate(lead.updatedAt)}`,
    badge: lead.stageName,
    rightLabel: `${lead.daysInStage}d in stage`,
    href: `/leads/${lead.leadId}`,
  }));
  const dealsSnapshot = data.dealSnapshot.map((deal) => ({
    id: deal.dealId,
    name: deal.dealName,
    metaPrimary: [deal.companyName, deal.propertyName].filter(Boolean).join(" • ") || "No company or property linked",
    metaSecondary: `Updated ${formatShortDate(deal.updatedAt)}`,
    badge: deal.stageName,
    rightLabel: formatCurrency(deal.totalValue),
    href: `/deals/${deal.dealId}`,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome back, ${firstName}`}
        description={headerSummary || "All clear."}
        meta={freshness ? `Synced ${freshness}` : undefined}
        actions={{
          secondaryAction: (
            <Button variant="outline" size="sm" onClick={refreshAll} disabled={loading}>
              <RefreshCw className="mr-1 h-4 w-4" />
              Refresh
            </Button>
          ),
        }}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card
          className="cursor-pointer transition-colors hover:bg-slate-50"
          onClick={() => navigate("/dashboard/contracts-signed?period=ytd")}
        >
          <CardContent className="flex items-start justify-between gap-3 p-4">
            <div>
              <p className={EYEBROW}>Contracts signed YTD</p>
              <p className="mt-2 text-2xl font-bold text-slate-950">{data.contractsSignedYtd.count}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatCurrency(data.contractsSignedYtd.totalValue)}
              </p>
            </div>
            <FileSignature className="h-5 w-5 text-muted-foreground" />
          </CardContent>
        </Card>
        <Card
          className="cursor-pointer transition-colors hover:bg-slate-50"
          onClick={() => navigate("/dashboard/contracts-signed?period=mtd")}
        >
          <CardContent className="flex items-start justify-between gap-3 p-4">
            <div>
              <p className={EYEBROW}>Contracts signed MTD</p>
              <p className="mt-2 text-2xl font-bold text-slate-950">{data.contractsSignedMtd.count}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatCurrency(data.contractsSignedMtd.totalValue)}
              </p>
            </div>
            <FilePen className="h-5 w-5 text-muted-foreground" />
          </CardContent>
        </Card>
      </div>

      <RepDashboardBoardShell
        activeEntity={boardState.activeEntity}
        onEntityChange={boardState.setActiveEntity}
        dealBoard={canonicalDealBoard}
        leadBoard={leadBoard}
        loading={boardState.activeEntity === "deals" ? dealBoardLoading : leadBoardLoading}
        error={boardState.activeEntity === "deals" ? dealBoardError : leadBoardError}
        onMove={handleBoardMove}
      />

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 pb-3">
          <CardTitle className="text-lg text-slate-950">My cleanup</CardTitle>
          <Button size="sm" onClick={() => navigate("/pipeline/my-cleanup")}>
            Open cleanup
            <ArrowUpRight className="ml-1 h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Records to fix</p>
              <p className="mt-1 text-3xl font-bold text-slate-950">{cleanupCount}</p>
            </div>
            {ownershipCount > 0 ? (
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Ownership gaps</p>
                <p className="mt-1 text-3xl font-bold text-slate-950">{ownershipCount}</p>
              </div>
            ) : (
              <div className="hidden sm:block" />
            )}
            <p className="text-sm text-muted-foreground">
              Forecast, next step, decision maker, budget. Keep them current.
            </p>
          </div>
        </CardContent>
      </Card>

      <FunnelBucketRow buckets={data.funnelBuckets} />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg text-slate-950">Bid Board (synced)</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {data.downstreamBottlenecks && data.downstreamBottlenecks.length > 0 ? (
            <div className="divide-y border-t">
              {data.downstreamBottlenecks.slice(0, 6).map((deal) => (
                <button
                  key={deal.dealId}
                  type="button"
                  onClick={() => navigate(`/deals/${deal.dealId}`)}
                  className="flex w-full items-start justify-between gap-3 px-6 py-3 text-left transition-colors hover:bg-slate-50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-950">{deal.dealName}</p>
                    <p className="mt-1 truncate text-sm text-slate-600">{deal.stageName}</p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {getWorkflowRouteLabel(deal.workflowRoute)} • {deal.regionClassification} •{" "}
                      {deal.mirroredStageStatus ?? "Synced"}
                    </p>
                  </div>
                  <div className="shrink-0 text-right tabular-nums">
                    <p className="text-sm font-semibold text-slate-950">{deal.daysInStage}d</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatCurrency(deal.dealValue)} • SLA {deal.staleThresholdDays}d
                    </p>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <p className="px-6 py-8 text-sm text-muted-foreground">Nothing in Bid Board today.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
          <CardTitle className="text-lg text-slate-950">My numbers</CardTitle>
          <ActivityRangeSelect
            value={activityRange}
            onChange={setActivityRange}
            className="h-8 w-[140px] text-xs"
          />
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t pt-4 sm:grid-cols-4">
            <KpiCell
              label="Active leads"
              value={data.activeLeads.count}
              subtitle={`${data.staleLeads.count} stale`}
              onClick={() => navigate("/leads")}
            />
            <KpiCell
              label="Active deals"
              value={data.activeDeals.count}
              subtitle={formatCurrency(data.activeDeals.totalValue)}
              onClick={() => navigate("/deals")}
            />
            <KpiCell
              label="Follow-up"
              value={`${data.followUpCompliance.complianceRate}%`}
              subtitle={`${data.followUpCompliance.onTime}/${data.followUpCompliance.total} on time`}
              emphasis={data.followUpCompliance.complianceRate < 80 ? "warning" : "neutral"}
            />
            <KpiCell
              label="Commission"
              value={formatCurrency(data.commissionSummary.totalEarnedCommission)}
              subtitle={`${formatCurrency(data.commissionSummary.directEarnedCommission)} direct`}
              onClick={() => navigate("/commissions")}
            />
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t pt-4 sm:grid-cols-4">
            <KpiCell label="Calls" value={data.activityThisWeek.calls} />
            <KpiCell label="Emails" value={data.activityThisWeek.emails} />
            <KpiCell label="Meetings" value={data.activityThisWeek.meetings} />
            <KpiCell label="Notes" value={data.activityThisWeek.notes} />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.9fr)]">
        <Card className="overflow-hidden">
          <CardHeader className="border-b pb-3">
            <div className="flex items-start justify-between gap-3">
              <CardTitle className="text-lg">Today&apos;s tasks</CardTitle>
              <Badge variant="outline">Top 10</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 p-4">
            {overdueTasks.length === 0 && todayTasks.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">Queue clear.</p>
            ) : (
              <>
                {overdueTasks.length > 0 ? (
                  <TaskSection
                    title="Overdue"
                    tasks={overdueTasks}
                    count={overdueTasks.length}
                    variant="danger"
                    defaultOpen={true}
                    onUpdate={refetchTasks}
                    pageSize={10}
                  />
                ) : null}
                {todayTasks.length > 0 ? (
                  <TaskSection
                    title="Today"
                    tasks={todayTasks}
                    count={todayTasks.length}
                    variant="warning"
                    defaultOpen={true}
                    onUpdate={refetchTasks}
                    pageSize={10}
                  />
                ) : null}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-lg">My pipeline</CardTitle>
          </CardHeader>
          <CardContent>
            {data.pipelineByStage.length > 0 ? (
              <button
                type="button"
                onClick={() => navigate("/pipeline")}
                className="block w-full cursor-pointer text-left transition-opacity hover:opacity-80"
              >
                <PipelineBarChart data={data.pipelineByStage} />
              </button>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">No active deals.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <SnapshotCard
          title="Active leads"
          emptyLabel="No active leads."
          actionLabel="Open leads"
          onAction={() => navigate("/leads")}
          onOpen={(href) => navigate(href)}
          rows={leadsSnapshot}
        />
        <SnapshotCard
          title="Active deals"
          emptyLabel="No active deals."
          actionLabel="Open deals"
          onAction={() => navigate("/deals")}
          onOpen={(href) => navigate(href)}
          rows={dealsSnapshot}
        />
      </div>
    </div>
  );
}
