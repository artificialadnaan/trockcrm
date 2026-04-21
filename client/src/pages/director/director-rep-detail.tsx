import { useEffect, useState } from "react";
import { useParams, Link, useSearchParams } from "react-router-dom";
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
  DollarSign,
  Target,
  Trophy,
  ArrowLeft,
} from "lucide-react";

export function DirectorRepDetail() {
  const { repId } = useParams<{ repId: string }>();
  const [searchParams] = useSearchParams();
  const [preset, setPreset] = useState<DateRangePreset>("ytd");
  const dateRange = presetToDateRange(preset);
  const { data, loading, error } = useRepDetail(repId, dateRange);

  useEffect(() => {
    if (searchParams.get("focus") !== "activity") {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      document.getElementById("rep-activity-summary")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [searchParams]);

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
  const activityBreakdown = [
    {
      label: "Calls",
      value: data.activityThisWeek.calls,
      tone: "bg-rose-50 text-rose-700 border-rose-100",
    },
    {
      label: "Emails",
      value: data.activityThisWeek.emails,
      tone: "bg-sky-50 text-sky-700 border-sky-100",
    },
    {
      label: "Meetings",
      value: data.activityThisWeek.meetings,
      tone: "bg-indigo-50 text-indigo-700 border-indigo-100",
    },
    {
      label: "Notes",
      value: data.activityThisWeek.notes,
      tone: "bg-emerald-50 text-emerald-700 border-emerald-100",
    },
  ];

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
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
        <StatCard
          title="Earned Commission (12M)"
          value={formatCurrency(data.commissionSummary.totalEarnedCommission)}
          subtitle={
            data.commissionSummary.overrideEarnedCommission > 0
              ? `${formatCurrency(data.commissionSummary.overrideEarnedCommission)} override`
              : `${Math.round(data.commissionSummary.newCustomerShare * 100)}% new-customer mix`
          }
          icon={<DollarSign className="h-5 w-5" />}
        />
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

      <Card id="rep-activity-summary" className="scroll-mt-24">
        <CardHeader>
          <CardTitle>Activity Summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.2fr,2fr]">
            <div className="rounded-2xl border border-gray-200 bg-gray-50 p-5">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400">
                Current activity signal
              </p>
              <p className="mt-3 text-4xl font-black text-gray-900">
                {data.activityThisWeek.total}
              </p>
              <p className="mt-2 text-sm text-gray-500">
                Logged this week across calls, emails, meetings, and notes.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-xl border border-gray-200 bg-white px-3 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Tasks today</p>
                  <p className="mt-1 text-lg font-bold text-gray-900">{taskTotal}</p>
                </div>
                <div className="rounded-xl border border-gray-200 bg-white px-3 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Follow-up compliance</p>
                  <p className="mt-1 text-lg font-bold text-gray-900">{data.followUpCompliance.complianceRate}%</p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {activityBreakdown.map((item) => (
                <div key={item.label} className={`rounded-2xl border px-4 py-4 ${item.tone}`}>
                  <p className="text-[10px] font-bold uppercase tracking-widest opacity-70">{item.label}</p>
                  <p className="mt-3 text-3xl font-black">{item.value}</p>
                  <p className="mt-1 text-xs opacity-80">
                    {item.value === 1 ? `${item.label.slice(0, -1)} logged` : `${item.label} logged`}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

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
      <StaleLeadList leads={data.staleLeads} dateRange={dateRange} />
    </div>
  );
}
