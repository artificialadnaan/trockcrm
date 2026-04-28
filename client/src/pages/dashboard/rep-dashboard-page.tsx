import { RepDashboardBoardShell } from "@/components/dashboard/rep-dashboard-board-shell";
import { useRepDashboard } from "@/hooks/use-dashboard";
import { useAuth } from "@/lib/auth";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "@/components/layout/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
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
import { useMemo, useState } from "react";
import { ActivityRangeSelect } from "@/components/dashboard/activity-range-select";
import {
  ACTIVITY_RANGE_LABELS,
  DEFAULT_ACTIVITY_RANGE,
  type ActivityRange,
} from "@trock-crm/shared/types";
import {
  ArrowUpRight,
  Briefcase,
  CheckSquare,
  ClipboardList,
  Activity,
  Target,
  TrendingUp,
  DollarSign,
  FileSignature,
  FilePen,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function SnapshotCard({
  title,
  eyebrow,
  emptyLabel,
  actionLabel,
  onAction,
  onOpen,
  rows,
}: {
  title: string;
  eyebrow: string;
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
    <Card className="overflow-hidden border-slate-200">
      <CardHeader className="border-b border-slate-100 bg-slate-50/70 pb-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">
              {eyebrow}
            </p>
            <CardTitle className="mt-2 text-lg text-slate-950">{title}</CardTitle>
          </div>
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
          <div className="divide-y divide-slate-100">
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
                    <Badge variant="outline" className="border-slate-200 text-slate-600">
                      {row.badge}
                    </Badge>
                  </div>
                  <p className="mt-1 truncate text-sm text-slate-600">{row.metaPrimary}</p>
                  <p className="mt-1 text-xs text-slate-500">{row.metaSecondary}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-medium text-slate-900">{row.rightLabel}</p>
                  <p className="mt-1 text-xs text-slate-500">Open record</p>
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
  const { data, loading, error } = useRepDashboard({ range: activityRange });
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
  const currentYear = new Date().getFullYear();

  const refetchTasks = () => {
    refetchOverdue();
    refetchToday();
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
        <PageHeader
          title={`Welcome back, ${firstName}`}
          description={`Here is your sales activity overview for ${currentYear}.`}
        />
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
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
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
        <PageHeader
          title={`Welcome back, ${firstName}`}
          description={`Here is your sales activity overview for ${currentYear}.`}
        />
        <Card>
          <CardContent className="p-6 text-center text-red-600">{error}</CardContent>
        </Card>
      </div>
    );
  }

  if (!data) return null;

  const taskTotal = data.tasksToday.overdue + data.tasksToday.today;
  const cleanupCount = data.myCleanup.total;
  const ownershipCount = data.myCleanup.byReason
    .filter((reason) => reason.reasonCode.includes("owner"))
    .reduce((sum, reason) => sum + reason.count, 0);
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
        description={`Here is your live sales cockpit for ${currentYear}.`}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard
          title="Contracts Signed YTD"
          value={data.contractsSignedYtd.count}
          subtitle={formatCurrency(data.contractsSignedYtd.totalValue)}
          icon={<FileSignature className="h-5 w-5" />}
          className="border-indigo-200 bg-indigo-50/70"
          onClick={() => navigate("/dashboard/contracts-signed?period=ytd")}
        />
        <StatCard
          title="Contracts Signed MTD"
          value={data.contractsSignedMtd.count}
          subtitle={formatCurrency(data.contractsSignedMtd.totalValue)}
          icon={<FilePen className="h-5 w-5" />}
          className="border-indigo-200 bg-indigo-50/70"
          onClick={() => navigate("/dashboard/contracts-signed?period=mtd")}
        />
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

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.9fr)]">
        <Card className="overflow-hidden border-slate-200 bg-[linear-gradient(135deg,#0f172a_0%,#1e293b_55%,#334155_100%)] text-white">
          <CardContent className="p-6">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-2xl space-y-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-slate-300">
                  Today At A Glance
                </p>
                <h2 className="text-3xl font-semibold tracking-tight">
                  Your book is live. Work the queue, protect follow-ups, and keep forecast fields current.
                </h2>
                <p className="max-w-xl text-sm leading-relaxed text-slate-300">
                  This view blends board movement, task pressure, cleanup pressure, and current pipeline movement into one place so you can move from triage into selling without hunting through pages.
                </p>
              </div>
              <div className="grid min-w-[260px] gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-white/10 bg-white/8 p-4 backdrop-blur-sm">
                  <p className="text-xs uppercase tracking-wide text-slate-300">Open Tasks</p>
                  <p className="mt-2 text-3xl font-semibold">{taskTotal}</p>
                  <p className="mt-1 text-sm text-slate-300">
                    {data.tasksToday.overdue > 0 ? `${data.tasksToday.overdue} overdue` : "Nothing overdue"}
                  </p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/8 p-4 backdrop-blur-sm">
                  <p className="text-xs uppercase tracking-wide text-slate-300">Cleanup Pressure</p>
                  <p className="mt-2 text-3xl font-semibold">{cleanupCount}</p>
                  <p className="mt-1 text-sm text-slate-300">
                    {ownershipCount > 0 ? `${ownershipCount} owner gaps` : "No ownership gaps flagged"}
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-amber-200 bg-[linear-gradient(180deg,rgba(251,191,36,0.13),rgba(255,255,255,1))]">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-amber-700">
                  Cleanup Queue
                </p>
                <CardTitle className="mt-2 text-xl text-slate-950">My Cleanup</CardTitle>
              </div>
              <ClipboardList className="h-5 w-5 text-amber-700" />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-amber-200 bg-white p-4">
                <p className="text-xs uppercase tracking-wide text-amber-700">Records To Fix</p>
                <p className="mt-2 text-3xl font-semibold text-slate-950">{cleanupCount}</p>
              </div>
              <div className="rounded-xl border border-amber-200 bg-white p-4">
                <p className="text-xs uppercase tracking-wide text-amber-700">Ownership Issues</p>
                <p className="mt-2 text-3xl font-semibold text-slate-950">{ownershipCount}</p>
              </div>
            </div>
            <p className="text-sm leading-relaxed text-slate-700">
              Keep forecast, next step, decision maker, and budget details current so leadership can trust what is in your book.
            </p>
            <Button onClick={() => navigate("/pipeline/my-cleanup")} className="w-full">
              Open My Cleanup
              <ArrowUpRight className="ml-1 h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      </div>

      <FunnelBucketRow buckets={data.funnelBuckets} />

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="border-slate-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg text-slate-950">CRM-Owned Progression</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.crmOwnedProgression && data.crmOwnedProgression.length > 0 ? (
              data.crmOwnedProgression.map((entry) => (
                <div key={`${entry.workflowBucket}-${entry.workflowRoute}-${entry.stageName}`} className="rounded-xl border border-slate-200 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-950">{entry.stageName}</p>
                      <p className="mt-1 text-xs uppercase tracking-wide text-slate-500">
                        {entry.workflowBucket === "lead" ? "Lead" : "Opportunity"} • {getWorkflowRouteLabel(entry.workflowRoute)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-semibold text-slate-950">{entry.itemCount}</p>
                      <p className="text-xs text-slate-500">{formatCurrency(entry.totalValue)}</p>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No CRM-owned progression pressure right now.</p>
            )}
          </CardContent>
        </Card>

        <Card className="border-slate-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg text-slate-950">Bid Board Pressure</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.downstreamBottlenecks && data.downstreamBottlenecks.length > 0 ? (
              data.downstreamBottlenecks.slice(0, 6).map((deal) => (
                <button
                  key={deal.dealId}
                  type="button"
                  onClick={() => navigate(`/deals/${deal.dealId}`)}
                  className="flex w-full items-start justify-between gap-3 rounded-xl border border-slate-200 p-4 text-left transition-colors hover:bg-slate-50"
                >
                  <div>
                    <p className="text-sm font-semibold text-slate-950">{deal.dealName}</p>
                    <p className="mt-1 text-sm text-slate-600">{deal.stageName}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {getWorkflowRouteLabel(deal.workflowRoute)} • {deal.regionClassification} • {deal.mirroredStageStatus ?? "Synced"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-slate-950">{deal.daysInStage}d</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {formatCurrency(deal.dealValue)} • SLA {deal.staleThresholdDays}d
                    </p>
                  </div>
                </button>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No synced Bid Board pressure right now.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-6">
        <StatCard
          title="Active Leads"
          value={data.activeLeads.count}
          subtitle={`${data.staleLeads.count} stale lead${data.staleLeads.count === 1 ? "" : "s"}`}
          icon={<ClipboardList className="h-5 w-5" />}
          className="border-sky-200 bg-sky-50/70"
          onClick={() => navigate("/leads")}
        />
        <StatCard
          title="Active Deals"
          value={data.activeDeals.count}
          subtitle={formatCurrency(data.activeDeals.totalValue)}
          icon={<Briefcase className="h-5 w-5" />}
          className="border-emerald-200 bg-emerald-50/70"
          onClick={() => navigate("/deals")}
        />
        <StatCard
          title="Tasks Today"
          value={taskTotal}
          subtitle={
            data.tasksToday.overdue > 0
              ? `${data.tasksToday.overdue} overdue`
              : "All caught up"
          }
          icon={<CheckSquare className="h-5 w-5" />}
          className={data.tasksToday.overdue > 0 ? "border-red-200 bg-red-50/60" : "border-slate-200 bg-white"}
          onClick={() => navigate("/tasks")}
        />
        <StatCard
          title="Activity"
          value={data.activityThisWeek.total}
          subtitle={`${data.activityThisWeek.calls} calls, ${data.activityThisWeek.emails} emails`}
          icon={<Activity className="h-5 w-5" />}
          className="border-violet-200 bg-violet-50/60"
        />
        <StatCard
          title="Follow-up Compliance"
          value={`${data.followUpCompliance.complianceRate}%`}
          subtitle={`${data.followUpCompliance.onTime} of ${data.followUpCompliance.total} on time`}
          icon={<Target className="h-5 w-5" />}
          className={
            data.followUpCompliance.complianceRate < 80
              ? "border-amber-200 bg-amber-50/60"
              : "border-slate-200 bg-white"
          }
        />
        <StatCard
          title="Commission Earned"
          value={formatCurrency(data.commissionSummary.totalEarnedCommission)}
          subtitle={`${formatCurrency(data.commissionSummary.directEarnedCommission)} direct`}
          icon={<DollarSign className="h-5 w-5" />}
          className="border-amber-200 bg-amber-50/70"
          onClick={() => navigate("/commissions")}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.9fr)]">
        <Card className="overflow-hidden border-slate-200">
          <CardHeader className="border-b border-slate-100 bg-slate-50/70">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">
                  Execution Queue
                </p>
                <CardTitle className="mt-2 text-lg">Today&apos;s Tasks</CardTitle>
              </div>
              <Badge variant="outline" className="border-slate-200 text-slate-600">
                10 at a time
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 p-4">
            {overdueTasks.length === 0 && todayTasks.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">No tasks today. Your queue is clear.</p>
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

        <div className="space-y-4">
          <Card className="border-slate-200">
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">
                    Pipeline Pulse
                  </p>
                  <CardTitle className="mt-2 text-lg">My Pipeline</CardTitle>
                </div>
                <TrendingUp className="h-5 w-5 text-slate-400" />
              </div>
            </CardHeader>
            <CardContent>
              {data.pipelineByStage.length > 0 ? (
                <div className="cursor-pointer" onClick={() => navigate("/pipeline")}>
                  <PipelineBarChart data={data.pipelineByStage} />
                </div>
              ) : (
                <p className="py-8 text-center text-muted-foreground">No active deals in pipeline.</p>
              )}
            </CardContent>
          </Card>

          <Card className="border-slate-200">
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">
                    Activity Mix
                  </p>
                  <CardTitle className="mt-2 text-lg">{ACTIVITY_RANGE_LABELS[activityRange]}</CardTitle>
                </div>
                <ActivityRangeSelect
                  value={activityRange}
                  onChange={setActivityRange}
                  className="h-8 w-[140px] text-xs"
                />
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-red-50 p-4 text-center">
                  <p className="text-2xl font-semibold text-red-700">{data.activityThisWeek.calls}</p>
                  <p className="mt-1 text-xs uppercase tracking-wide text-red-600">Calls</p>
                </div>
                <div className="rounded-xl bg-cyan-50 p-4 text-center">
                  <p className="text-2xl font-semibold text-cyan-700">{data.activityThisWeek.emails}</p>
                  <p className="mt-1 text-xs uppercase tracking-wide text-cyan-600">Emails</p>
                </div>
                <div className="rounded-xl bg-blue-50 p-4 text-center">
                  <p className="text-2xl font-semibold text-blue-700">{data.activityThisWeek.meetings}</p>
                  <p className="mt-1 text-xs uppercase tracking-wide text-blue-600">Meetings</p>
                </div>
                <div className="rounded-xl bg-emerald-50 p-4 text-center">
                  <p className="text-2xl font-semibold text-emerald-700">{data.activityThisWeek.notes}</p>
                  <p className="mt-1 text-xs uppercase tracking-wide text-emerald-600">Notes</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <SnapshotCard
          eyebrow="Leads Snapshot"
          title="Active Leads"
          emptyLabel="No active leads yet."
          actionLabel="Open leads"
          onAction={() => navigate("/leads")}
          onOpen={(href) => navigate(href)}
          rows={leadsSnapshot}
        />
        <SnapshotCard
          eyebrow="Deals Snapshot"
          title="Active Deals"
          emptyLabel="No active deals yet."
          actionLabel="Open deals"
          onAction={() => navigate("/deals")}
          onOpen={(href) => navigate(href)}
          rows={dealsSnapshot}
        />
      </div>
    </div>
  );
}
