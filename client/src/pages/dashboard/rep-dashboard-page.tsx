import { useRepDashboard } from "@/hooks/use-dashboard";
import { useAuth } from "@/lib/auth";
import { useNavigate } from "react-router-dom";
import { StatCard } from "@/components/dashboard/stat-card";
import { PipelineBarChart } from "@/components/charts/pipeline-bar-chart";
import { formatCurrency } from "@/components/charts/chart-colors";
import { useTasks } from "@/hooks/use-tasks";
import { TaskSection } from "@/components/tasks/task-section";
import { getWorkflowRouteLabel } from "@/lib/pipeline-ownership";
import {
  Briefcase,
  CheckSquare,
  Activity,
  Target,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function formatPathLabel(route: "normal" | "service") {
  return `${getWorkflowRouteLabel(route)} path`;
}

function formatMirrorStatus(status: string | null | undefined) {
  if (!status) return "watch";
  return status.replace(/_/g, " ");
}

export function RepDashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data, loading, error } = useRepDashboard();
  const { tasks: overdueTasks, refetch: refetchOverdue } = useTasks({ section: "overdue" });
  const { tasks: todayTasks, refetch: refetchToday } = useTasks({ section: "today" });

  const refetchTasks = () => {
    refetchOverdue();
    refetchToday();
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold">Dashboard</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-4 h-24" />
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold">Dashboard</h2>
        <Card>
          <CardContent className="p-6 text-center text-red-600">
            {error}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data) return null;

  const taskTotal = data.tasksToday.overdue + data.tasksToday.today;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">
          Welcome back, {user?.displayName?.split(" ")[0]}
        </h2>
        <p className="text-muted-foreground text-sm mt-1">
          Here is your sales activity overview for {new Date().getFullYear()}.
        </p>
      </div>

      {/* Today's Tasks */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Today's Tasks</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {overdueTasks.length === 0 && todayTasks.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              No tasks today — you're clear!
            </p>
          ) : (
            <>
              {overdueTasks.length > 0 && (
                <TaskSection
                  title="Overdue"
                  tasks={overdueTasks}
                  count={overdueTasks.length}
                  variant="danger"
                  defaultOpen={true}
                  onUpdate={refetchTasks}
                />
              )}
              {todayTasks.length > 0 && (
                <TaskSection
                  title="Today"
                  tasks={todayTasks}
                  count={todayTasks.length}
                  variant="warning"
                  defaultOpen={true}
                  onUpdate={refetchTasks}
                />
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Active Deals"
          value={data.activeDeals.count}
          subtitle={formatCurrency(data.activeDeals.totalValue)}
          icon={<Briefcase className="h-5 w-5" />}
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
          className={data.tasksToday.overdue > 0 ? "border-red-200 bg-red-50/50" : ""}
          onClick={() => navigate("/tasks")}
        />
        <StatCard
          title="Activity This Week"
          value={data.activityThisWeek.total}
          subtitle={`${data.activityThisWeek.calls} calls, ${data.activityThisWeek.emails} emails`}
          icon={<Activity className="h-5 w-5" />}
        />
        <StatCard
          title="Follow-up Compliance"
          value={`${data.followUpCompliance.complianceRate}%`}
          subtitle={`${data.followUpCompliance.onTime} of ${data.followUpCompliance.total} on time`}
          icon={<Target className="h-5 w-5" />}
          className={
            data.followUpCompliance.complianceRate < 80
              ? "border-amber-200 bg-amber-50/50"
              : ""
          }
        />
      </div>

      {/* Pipeline Chart */}
      <Card
        className="cursor-pointer hover:shadow-md transition-shadow"
        onClick={() => navigate("/pipeline")}
      >
        <CardHeader>
          <CardTitle>My Pipeline</CardTitle>
        </CardHeader>
        <CardContent>
          {data.pipelineByStage.length > 0 ? (
            <PipelineBarChart data={data.pipelineByStage} />
          ) : (
            <p className="text-muted-foreground text-center py-8">
              No active deals in pipeline.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>CRM-Owned Progression</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(data.crmOwnedProgression ?? []).length > 0 ? (
              (data.crmOwnedProgression ?? []).map((row) => (
                <div
                  key={`${row.workflowBucket}-${row.workflowRoute}-${row.stageName}`}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div>
                    <p className="text-sm font-semibold">{row.stageName}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatPathLabel(row.workflowRoute)} - {row.workflowBucket === "opportunity" ? "Opportunity-owned" : "Lead-stage"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold">{row.itemCount}</p>
                    <p className="text-xs text-muted-foreground">{formatCurrency(row.totalValue)}</p>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No CRM-owned pipeline items in flight.</p>
            )}

            {data.staleLeads.leads.slice(0, 2).map((lead) => (
              <div key={lead.leadId} className="rounded-lg bg-amber-50/70 p-3">
                <p className="text-sm font-semibold">{lead.leadName}</p>
                <p className="text-xs text-muted-foreground">
                  {lead.stageName} - {formatPathLabel(lead.pipelineType ?? "normal")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {[lead.locationLabel, lead.estimatedValue ? formatCurrency(lead.estimatedValue) : null]
                    .filter(Boolean)
                    .join(" - ")}
                </p>
                <p className="text-xs text-amber-700">
                  {lead.daysInStage}d / {lead.staleThresholdDays ?? lead.daysInStage}d target
                </p>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Bid Board Bottlenecks</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(data.downstreamBottlenecks ?? []).length > 0 ? (
              (data.downstreamBottlenecks ?? []).map((deal) => (
                <div key={deal.dealId} className="flex items-center justify-between rounded-lg border p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{deal.dealName}</p>
                    <p className="text-xs text-muted-foreground">
                      {deal.stageName} - {formatMirrorStatus(deal.mirroredStageStatus)} - {formatPathLabel(deal.workflowRoute)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {deal.regionClassification} - {formatCurrency(deal.dealValue)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-amber-700">
                      {deal.daysInStage}d / {deal.staleThresholdDays}d target
                    </p>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No mirrored downstream bottlenecks right now.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Activity Breakdown */}
      <Card>
        <CardHeader>
          <CardTitle>Activity This Week</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="text-center p-3 rounded-lg bg-slate-50">
              <p className="text-2xl font-bold text-red-600">{data.activityThisWeek.calls}</p>
              <p className="text-xs text-muted-foreground mt-1">Calls</p>
            </div>
            <div className="text-center p-3 rounded-lg bg-slate-50">
              <p className="text-2xl font-bold text-cyan-600">{data.activityThisWeek.emails}</p>
              <p className="text-xs text-muted-foreground mt-1">Emails</p>
            </div>
            <div className="text-center p-3 rounded-lg bg-slate-50">
              <p className="text-2xl font-bold text-blue-600">{data.activityThisWeek.meetings}</p>
              <p className="text-xs text-muted-foreground mt-1">Meetings</p>
            </div>
            <div className="text-center p-3 rounded-lg bg-slate-50">
              <p className="text-2xl font-bold text-emerald-600">{data.activityThisWeek.notes}</p>
              <p className="text-xs text-muted-foreground mt-1">Notes</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
