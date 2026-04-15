import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  useRepDetail,
  presetToDateRange,
  type DateRangePreset,
} from "@/hooks/use-director-dashboard";
import { DateRangeToggle } from "@/components/dashboard/date-range-toggle";
import { StatCard } from "@/components/dashboard/stat-card";
import { StaleDealList } from "@/components/dashboard/stale-deal-list";
import { StaleLeadList } from "@/components/dashboard/stale-lead-list";
import { PipelineBarChart } from "@/components/charts/pipeline-bar-chart";
import { WinRateTrendChart } from "@/components/charts/win-rate-trend-chart";
import { formatCurrency } from "@/components/charts/chart-colors";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Briefcase,
  CheckSquare,
  Activity,
  Target,
  Trophy,
  ArrowLeft,
} from "lucide-react";

export function DirectorRepDetail() {
  const { repId } = useParams<{ repId: string }>();
  const [preset, setPreset] = useState<DateRangePreset>("ytd");
  const dateRange = presetToDateRange(preset);
  const { data, loading, error } = useRepDetail(repId, dateRange);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse h-8 bg-slate-200 rounded w-48" />
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
        <Link to="/director">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
        </Link>
        <Card>
          <CardContent className="p-6 text-center text-red-600">{error}</CardContent>
        </Card>
      </div>
    );
  }

  if (!data) return null;

  const taskTotal = data.tasksToday.overdue + data.tasksToday.today;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link to="/director">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-1" /> Back
            </Button>
          </Link>
          <h2 className="text-2xl font-bold">{data.winLoss.repName || "Rep Detail"}</h2>
        </div>
        <DateRangeToggle value={preset} onChange={setPreset} />
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard
          title="Active Deals"
          value={data.activeDeals.count}
          subtitle={formatCurrency(data.activeDeals.totalValue)}
          icon={<Briefcase className="h-5 w-5" />}
        />
        <StatCard
          title="Tasks Today"
          value={taskTotal}
          subtitle={data.tasksToday.overdue > 0 ? `${data.tasksToday.overdue} overdue` : "On track"}
          icon={<CheckSquare className="h-5 w-5" />}
        />
        <StatCard
          title="Activity This Week"
          value={data.activityThisWeek.total}
          subtitle={`${data.activityThisWeek.calls} calls`}
          icon={<Activity className="h-5 w-5" />}
        />
        <StatCard
          title="Win Rate"
          value={`${data.winLoss.winRate}%`}
          subtitle={`${data.winLoss.wins}W / ${data.winLoss.losses}L`}
          icon={<Trophy className="h-5 w-5" />}
        />
        <StatCard
          title="Follow-up Compliance"
          value={`${data.followUpCompliance.complianceRate}%`}
          subtitle={`${data.followUpCompliance.onTime}/${data.followUpCompliance.total}`}
          icon={<Target className="h-5 w-5" />}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Pipeline by Stage</CardTitle>
          </CardHeader>
          <CardContent>
            {data.pipelineByStage.length > 0 ? (
              <PipelineBarChart data={data.pipelineByStage} />
            ) : (
              <p className="text-muted-foreground text-center py-8">No pipeline data.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Win Rate Trend</CardTitle>
          </CardHeader>
          <CardContent>
            {data.winRateTrend.length > 0 ? (
              <WinRateTrendChart data={data.winRateTrend} />
            ) : (
              <p className="text-muted-foreground text-center py-8">No data yet.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Stale Deals */}
      <StaleDealList deals={data.staleDeals} />

      {/* Stale Leads */}
      <StaleLeadList leads={data.staleLeads} />
    </div>
  );
}
