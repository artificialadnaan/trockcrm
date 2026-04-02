import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  useDirectorDashboard,
  presetToDateRange,
  type DateRangePreset,
} from "@/hooks/use-director-dashboard";
import { DateRangeToggle } from "@/components/dashboard/date-range-toggle";
import { RepPerformanceCard } from "@/components/dashboard/rep-performance-card";
import { StaleDealList } from "@/components/dashboard/stale-deal-list";
import { StatCard } from "@/components/dashboard/stat-card";
import { PipelineBarChart } from "@/components/charts/pipeline-bar-chart";
import { WinRateTrendChart } from "@/components/charts/win-rate-trend-chart";
import { ActivityBarChart } from "@/components/charts/activity-bar-chart";
import { formatCurrency } from "@/components/charts/chart-colors";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, BarChart3 } from "lucide-react";

export function DirectorDashboardPage() {
  const navigate = useNavigate();
  const [preset, setPreset] = useState<DateRangePreset>("ytd");
  const dateRange = presetToDateRange(preset);
  const { data, loading, error } = useDirectorDashboard(dateRange);

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold">Director Dashboard</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-4 h-32" />
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold">Director Dashboard</h2>
        <Card>
          <CardContent className="p-6 text-center text-red-600">{error}</CardContent>
        </Card>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h2 className="text-2xl font-bold">Director Dashboard</h2>
        <DateRangeToggle value={preset} onChange={setPreset} />
      </div>

      {/* DD vs Pipeline Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          title="True Pipeline"
          value={formatCurrency(data.ddVsPipeline.pipelineValue)}
          subtitle={`${data.ddVsPipeline.pipelineCount} deals`}
          icon={<TrendingUp className="h-5 w-5" />}
        />
        <StatCard
          title="DD Pipeline"
          value={formatCurrency(data.ddVsPipeline.ddValue)}
          subtitle={`${data.ddVsPipeline.ddCount} deals`}
          icon={<BarChart3 className="h-5 w-5" />}
        />
        <StatCard
          title="Total Pipeline"
          value={formatCurrency(data.ddVsPipeline.totalValue)}
          subtitle={`${data.ddVsPipeline.totalCount} deals total`}
        />
      </div>

      {/* Rep Performance Cards */}
      <div>
        <h3 className="text-lg font-semibold mb-3">Sales Rep Overview</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {data.repCards.map((rep) => (
            <RepPerformanceCard
              key={rep.repId}
              rep={rep}
              onClick={() => navigate(`/director/rep/${rep.repId}`)}
            />
          ))}
          {data.repCards.length === 0 && (
            <p className="text-muted-foreground col-span-full text-center py-4">
              No active reps found.
            </p>
          )}
        </div>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Pipeline by Stage */}
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

        {/* Win Rate Trend */}
        <Card>
          <CardHeader>
            <CardTitle>Win Rate Trend</CardTitle>
          </CardHeader>
          <CardContent>
            {data.winRateTrend.length > 0 ? (
              <WinRateTrendChart data={data.winRateTrend} />
            ) : (
              <p className="text-muted-foreground text-center py-8">No closed deals yet.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Activity by Rep */}
      <Card>
        <CardHeader>
          <CardTitle>Activity by Rep</CardTitle>
        </CardHeader>
        <CardContent>
          {data.activityByRep.length > 0 ? (
            <ActivityBarChart data={data.activityByRep} />
          ) : (
            <p className="text-muted-foreground text-center py-8">No activity data.</p>
          )}
        </CardContent>
      </Card>

      {/* Stale Deal Watchlist */}
      <StaleDealList deals={data.staleDeals} />
    </div>
  );
}
