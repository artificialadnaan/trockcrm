import { useRepDashboard } from "@/hooks/use-dashboard";
import { useAuth } from "@/lib/auth";
import { useNavigate } from "react-router-dom";
import { StatCard } from "@/components/dashboard/stat-card";
import { PipelineBarChart } from "@/components/charts/pipeline-bar-chart";
import { formatCurrency } from "@/components/charts/chart-colors";
import { useTasks } from "@/hooks/use-tasks";
import { TaskSection } from "@/components/tasks/task-section";
import {
  Briefcase,
  CheckSquare,
  Activity,
  Target,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MyCleanupCard } from "../../components/dashboard/my-cleanup-card";

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

      <MyCleanupCard total={data.myCleanup.total} byReason={data.myCleanup.byReason} />

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
