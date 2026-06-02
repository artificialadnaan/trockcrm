import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  useRepDetail,
  presetToDateRange,
  type DateRangePreset,
} from "@/hooks/use-director-dashboard";
import { useLeads, formatLeadPropertyLine } from "@/hooks/use-leads";
import { usePipelineStages, useRegions, useProjectTypes } from "@/hooks/use-pipeline-config";
import { toDatePresetRange } from "@/lib/pipeline-terminal-filters";
import { DateRangeToggle } from "@/components/dashboard/date-range-toggle";
import { StatCard } from "@/components/dashboard/stat-card";
import { StaleDealList } from "@/components/dashboard/stale-deal-list";
import { StaleLeadList } from "@/components/dashboard/stale-lead-list";
import { PipelineBarChart } from "@/components/charts/pipeline-bar-chart";
import { WinRateTrendChart } from "@/components/charts/win-rate-trend-chart";
import { formatCurrency } from "@/components/charts/chart-colors";
import {
  DealsListSection,
  buildDealStageFilterOptions,
  getVisibleListTerminalStageIds,
  type DealListSortState,
} from "@/components/deals/deals-list-section";
import {
  DEAL_LIST_SORT_OPTIONS,
  DRILLDOWN_FILTERBAR_PARAM_PREFIX,
  getDrilldownFilterBarDimensions,
} from "@/components/deals/deals-filterbar-adapter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  Activity,
  ArrowLeft,
  Briefcase,
  CalendarDays,
  CheckSquare,
  DollarSign,
  Search,
  Target,
  Trophy,
} from "lucide-react";

const PRESET_LABELS: Record<DateRangePreset, string> = {
  mtd: "MTD",
  qtd: "QTD",
  ytd: "YTD",
  last_month: "Last month",
  last_quarter: "Last quarter",
  last_year: "Last year",
  custom: "Custom range",
};

const PRESET_ACTIVITY_LABELS: Record<DateRangePreset, string> = {
  mtd: "this month",
  qtd: "this quarter",
  ytd: "this year",
  last_month: "last month",
  last_quarter: "last quarter",
  last_year: "last year",
  custom: "the selected period",
};

// D-15: sort by the outcome DISPLAY date (Won->won-close, Lost->lost, open->stage-entry)
// — the SAME expression the list filters + displays — so Won/Lost/open rows are each
// ordered by their shown date, not one raw column (Codex #564: sort == display).
const DEAL_LIST_INITIAL_SORT = { key: "display_date", dir: "desc" } satisfies DealListSortState;
const LEAD_STATUS_OPTIONS = ["all", "open", "converted", "disqualified"] as const;
const LIST_RANGE_OPTIONS = ["dashboard", "7d", "wtd", "mtd", "qtd", "ytd"] as const;

type LeadStatusFilter = (typeof LEAD_STATUS_OPTIONS)[number];
type RepDetailListRange = (typeof LIST_RANGE_OPTIONS)[number];

function isDateRangePreset(value: string | null): value is DateRangePreset {
  return value !== null && value in PRESET_LABELS;
}

function isRepDetailListRange(value: string | null): value is RepDetailListRange {
  return value !== null && LIST_RANGE_OPTIONS.includes(value as RepDetailListRange);
}

function daysBack(referenceDate: Date, days: number) {
  const result = new Date(referenceDate);
  result.setUTCDate(result.getUTCDate() - days);
  return formatUtcDateInput(result);
}

function formatUtcDateInput(value: Date) {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getRepDetailListDateRange(
  range: RepDetailListRange,
  preset: DateRangePreset,
  dashboardDateRange: { from: string; to: string }
) {
  // mtd/qtd/ytd keep the same UTC day boundaries as presetToDateRange() so the rep-detail
  // lists and dashboard cards share semantics; wtd uses the ONE shared platform-wide
  // (Sunday-anchored) WTD definition (D-7).
  if (range === "dashboard") {
    return dashboardDateRange;
  }

  if (range === "mtd" || range === "qtd" || range === "ytd") {
    return presetToDateRange(range);
  }

  if (range === "wtd") {
    // D-7: use the ONE shared, platform-wide WTD definition (Sunday-anchored).
    return toDatePresetRange("wtd");
  }

  const today = formatUtcDateInput(new Date());
  return { from: daysBack(new Date(), 6), to: today };
}

function getRepDetailListRangeLabel(range: RepDetailListRange, preset: DateRangePreset) {
  switch (range) {
    case "dashboard":
      return `Dashboard (${PRESET_LABELS[preset]})`;
    case "7d":
      return "7D";
    case "wtd":
      return "WTD";
    case "mtd":
      return "MTD";
    case "qtd":
      return "QTD";
    case "ytd":
      return "YTD";
  }
}

function formatCompactUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function leadValue(lead: { forecastRevenue: string | null; qualificationBudgetAmount: string | null }) {
  const numericValue = Number(lead.forecastRevenue ?? lead.qualificationBudgetAmount ?? 0);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

function sourceLabel(source: string | null | undefined) {
  return source?.trim() || "Unknown";
}

function getLeadStatusLabel(status: LeadStatusFilter) {
  if (status === "all") return "All statuses";
  if (status === "open") return "Open";
  if (status === "converted") return "Converted";
  return "Disqualified";
}

function sortByNewestFirst<T extends { createdAt: string }>(rows: T[]) {
  return [...rows].sort((left, right) => {
    const leftTime = new Date(left.createdAt).getTime();
    const rightTime = new Date(right.createdAt).getTime();
    return rightTime - leftTime;
  });
}

function renderLeadStageChip(label: string) {
  return (
    <span className="inline-flex max-w-full items-center rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.12em] text-slate-600">
      <span className="block truncate whitespace-nowrap">{label}</span>
    </span>
  );
}

function DirectorRepLeadsListSection({
  repId,
  repName,
  dateRange,
}: {
  repId: string;
  repName: string;
  dateRange: { from: string; to: string };
}) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<LeadStatusFilter>("all");
  const [selectedStageIds, setSelectedStageIds] = useState<string[]>([]);
  const { stages } = usePipelineStages("lead");
  const stageNameById = useMemo(
    () => new Map(stages.map((stage) => [stage.id, stage.name])),
    [stages]
  );
  const visibleStages = useMemo(
    () => stages.filter((stage) => stage.isActivePipeline !== false),
    [stages]
  );
  const { leads, loading, error } = useLeads({
    assignedRepId: repId,
    stageIds: selectedStageIds.length > 0 ? selectedStageIds : undefined,
    status: status === "all" ? undefined : status,
    isActive: "all",
    createdFrom: dateRange.from,
    createdTo: dateRange.to,
    search: search.trim() || undefined,
    sortBy: "created_at",
    sortDir: "desc",
    scope: "all",
  });

  const sortedLeads = useMemo(() => sortByNewestFirst(leads), [leads]);
  const totalValue = useMemo(
    () => sortedLeads.reduce((sum, lead) => sum + leadValue(lead), 0),
    [sortedLeads]
  );

  const toggleStage = (stageId: string) => {
    setSelectedStageIds((current) =>
      current.includes(stageId)
        ? current.filter((value) => value !== stageId)
        : [...current, stageId]
    );
  };

  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <div className="flex flex-col gap-4 border-b border-gray-200 p-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.18em] text-brand-red">
            Leads
          </p>
          <h3 className="mt-1 text-xl font-black uppercase text-slate-950">Lead records</h3>
          <p className="mt-1 text-sm font-medium text-slate-500">
            Open, converted, or disqualified leads assigned to {repName}, filtered by created date.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">Visible leads</p>
            <p className="mt-1 text-lg font-black text-slate-950">{sortedLeads.length}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">Status</p>
            <p className="mt-1 text-lg font-black text-slate-950">{getLeadStatusLabel(status)}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">Forecast value</p>
            <p className="mt-1 text-lg font-black text-slate-950">{formatCompactUsd(totalValue)}</p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 border-b border-gray-200 bg-[#f7f8fb] p-4 lg:grid-cols-[minmax(18rem,1fr)_220px]">
        <label className="space-y-2">
          <span className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Search</span>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Lead name, company, property"
              className="pl-9"
            />
          </div>
        </label>

        <label className="space-y-2">
          <span className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">Status</span>
          <Select value={status} onValueChange={(value) => setStatus(value as LeadStatusFilter)}>
            <SelectTrigger>
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              {LEAD_STATUS_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {getLeadStatusLabel(option)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>

      <div className="flex flex-wrap gap-2 border-b border-gray-200 px-4 py-3">
        <button
          type="button"
          aria-pressed={selectedStageIds.length === 0}
          onClick={() => setSelectedStageIds([])}
          className={cn(
            "rounded-full border px-3 py-1.5 text-xs font-black uppercase tracking-[0.12em]",
            selectedStageIds.length === 0
              ? "border-brand-red bg-brand-red text-white"
              : "border-slate-200 bg-white text-slate-600 hover:border-brand-red/40 hover:text-brand-red"
          )}
        >
          All stages
        </button>
        {visibleStages.map((stage) => {
          const isActive = selectedStageIds.includes(stage.id);
          return (
            <button
              key={stage.id}
              type="button"
              aria-pressed={isActive}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-black uppercase tracking-[0.12em]",
                isActive
                  ? "border-brand-red bg-brand-red text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:border-brand-red/40 hover:text-brand-red"
              )}
              onClick={() => toggleStage(stage.id)}
            >
              {stage.name}
            </button>
          );
        })}
      </div>

      <div className="p-4">
        {error ? (
          <div className="rounded-lg border border-brand-red/20 bg-brand-red/5 p-4 text-sm font-semibold text-brand-red">
            {error}
          </div>
        ) : loading ? (
          <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-500">
            Loading leads...
          </div>
        ) : sortedLeads.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm font-semibold text-slate-500">
            No leads match the current rep, timeline, and stage filters.
          </div>
        ) : (
          <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {sortedLeads.map((lead) => (
              <button
                key={lead.id}
                type="button"
                onClick={() => navigate(`/leads/${lead.id}`)}
                aria-label={`Open lead ${lead.name}`}
                className="grid w-full gap-3 px-4 py-4 text-left transition-colors hover:bg-slate-50 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_160px_160px_140px]"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-black text-slate-950">{lead.name}</p>
                  <p className="mt-1 truncate text-xs font-semibold text-slate-500">
                    {lead.companyName ?? "Company pending"}
                  </p>
                  <p className="mt-1 truncate text-xs text-slate-400">
                    {formatLeadPropertyLine(lead) || "Property pending"}
                  </p>
                </div>

                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {renderLeadStageChip(lead.projectType?.name ?? "Lead")}
                    {renderLeadStageChip(stageNameById.get(lead.stageId) ?? "Stage")}
                  </div>
                  <p className="mt-2 truncate text-xs font-medium text-slate-500" title={lead.description ?? ""}>
                    {lead.description?.trim() || "No description"}
                  </p>
                </div>

                <div className="text-sm font-black tabular-nums text-slate-950">
                  {formatCompactUsd(leadValue(lead))}
                </div>

                <div className="space-y-1 text-sm text-slate-600">
                  <p className="font-semibold text-slate-950">{sourceLabel(lead.source)}</p>
                  <p className="text-xs font-medium uppercase tracking-[0.12em] text-slate-500">
                    {getLeadStatusLabel(lead.status as LeadStatusFilter)}
                  </p>
                </div>

                <div className="text-right text-xs font-medium text-slate-500">
                  <p className="font-black uppercase tracking-[0.12em] text-slate-950">Created</p>
                  <p className="mt-1">
                    {new Date(lead.createdAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function DirectorRepDetail() {
  const navigate = useNavigate();
  const { repId } = useParams<{ repId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [preset, setPreset] = useState<DateRangePreset>(() => {
    const requestedPreset = searchParams.get("preset");
    return isDateRangePreset(requestedPreset) ? requestedPreset : "ytd";
  });
  const [listRange, setListRange] = useState<RepDetailListRange>(() => {
    const requestedListRange = searchParams.get("listRange");
    return isRepDetailListRange(requestedListRange) ? requestedListRange : "dashboard";
  });
  const listRangeFromUrl = isRepDetailListRange(searchParams.get("listRange"))
    ? (searchParams.get("listRange") as RepDetailListRange)
    : "dashboard";
  const dateRange = presetToDateRange(preset);
  const listDateRange = useMemo(
    () => getRepDetailListDateRange(listRange, preset, dateRange),
    [dateRange, listRange, preset]
  );
  const { data, loading, error } = useRepDetail(repId, dateRange);
  const periodLabel = PRESET_LABELS[preset];
  const activityPeriodLabel = PRESET_ACTIVITY_LABELS[preset];

  // Shared FilterBar config for the rep-scoped deal records list (#3). The stage options + terminal
  // ids are built with the SAME helpers the legacy list used internally (active-pipeline stages,
  // terminal subset), so the migrated list shows the SAME deals — including Won/Lost by default.
  const { stages: dealStages } = usePipelineStages("deal");
  const { regions } = useRegions();
  const { projectTypes } = useProjectTypes();
  const repStageOptions = useMemo(
    () => buildDealStageFilterOptions(dealStages.filter((stage) => stage.isActivePipeline !== false)),
    [dealStages]
  );
  const repTerminalStageIds = useMemo(
    () => getVisibleListTerminalStageIds(dealStages, repStageOptions),
    [dealStages, repStageOptions]
  );

  const handlePresetChange = (nextPreset: DateRangePreset) => {
    setPreset(nextPreset);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("preset", nextPreset);
    setSearchParams(nextParams, { replace: true });
  };

  const handleListRangeChange = (nextRange: RepDetailListRange) => {
    setListRange(nextRange);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("listRange", nextRange);
    setSearchParams(nextParams, { replace: true });
  };

  useEffect(() => {
    setListRange((current) => (current === listRangeFromUrl ? current : listRangeFromUrl));
  }, [listRangeFromUrl]);

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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
            <ArrowLeft className="mr-1 h-4 w-4" /> Back
          </Button>
        </Link>
        <Card>
          <CardContent className="p-6 text-center text-red-600">{error}</CardContent>
        </Card>
      </div>
    );
  }

  if (!data || !repId) return null;

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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Link to="/director">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="mr-1 h-4 w-4" /> Back
            </Button>
          </Link>
          <h2 className="text-2xl font-bold">{data.winLoss.repName || "Rep Detail"}</h2>
        </div>
        <DateRangeToggle value={preset} onChange={handlePresetChange} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6">
        <StatCard
          title="Earned Commission (Rolling 12M)"
          value={formatCurrency(data.commissionSummary.totalEarnedCommission)}
          subtitle={
            data.commissionSummary.overrideEarnedCommission > 0
              ? `${formatCurrency(data.commissionSummary.overrideEarnedCommission)} override`
              : `${Math.round(data.commissionSummary.newCustomerShare * 100)}% new-customer mix`
          }
          icon={<DollarSign className="h-5 w-5" />}
        />
        <StatCard
          title="Active Deals (Current)"
          value={data.activeDeals.count}
          subtitle={`${formatCurrency(data.activeDeals.totalValue)} open now`}
          icon={<Briefcase className="h-5 w-5" />}
        />
        <StatCard
          title="Tasks Today"
          value={taskTotal}
          subtitle={data.tasksToday.overdue > 0 ? `${data.tasksToday.overdue} overdue` : "On track"}
          icon={<CheckSquare className="h-5 w-5" />}
        />
        <StatCard
          title={`Activity · ${periodLabel}`}
          value={data.activityThisWeek.total}
          subtitle={`${data.activityThisWeek.calls} calls in ${activityPeriodLabel}`}
          icon={<Activity className="h-5 w-5" />}
        />
        <StatCard
          title={`Win Rate · ${periodLabel}`}
          value={`${data.winLoss.winRate}%`}
          subtitle={`${data.winLoss.wins}W / ${data.winLoss.losses}L`}
          icon={<Trophy className="h-5 w-5" />}
        />
        <StatCard
          title={`Follow-up Compliance · ${periodLabel}`}
          value={`${data.followUpCompliance.complianceRate}%`}
          subtitle={`${data.followUpCompliance.onTime}/${data.followUpCompliance.total} on time`}
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
                Logged in {activityPeriodLabel} across calls, emails, meetings, and notes.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-xl border border-gray-200 bg-white px-3 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
                    Tasks today
                  </p>
                  <p className="mt-1 text-lg font-bold text-gray-900">{taskTotal}</p>
                </div>
                <div className="rounded-xl border border-gray-200 bg-white px-3 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
                    Follow-up compliance
                  </p>
                  <p className="mt-1 text-lg font-bold text-gray-900">
                    {data.followUpCompliance.complianceRate}%
                  </p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {activityBreakdown.map((item) => (
                <div key={item.label} className={`rounded-2xl border px-4 py-4 ${item.tone}`}>
                  <p className="text-[10px] font-bold uppercase tracking-widest opacity-70">{item.label}</p>
                  <p className="mt-3 text-3xl font-black">{item.value}</p>
                  <p className="mt-1 text-xs opacity-80">
                    {item.value === 1
                      ? `${item.label.slice(0, -1)} logged in ${activityPeriodLabel}`
                      : `${item.label} logged in ${activityPeriodLabel}`}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-brand-red">
                Rep workflow records
              </p>
              <CardTitle className="mt-1">Deals and Leads</CardTitle>
              <p className="mt-1 text-sm font-medium text-slate-500">
                This section is fixed to {data.winLoss.repName}. The list filter defaults to the
                director dashboard preset and can be tightened to a created-date window on page.
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              <div className="flex items-center gap-2 font-semibold text-slate-950">
                <CalendarDays className="h-4 w-4 text-brand-red" />
                Current list window
              </div>
              <p className="mt-1">
                {listDateRange.from} to {listDateRange.to}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {LIST_RANGE_OPTIONS.map((option) => {
              const active = listRange === option;
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={active}
                  onClick={() => handleListRangeChange(option)}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-black uppercase tracking-[0.12em]",
                    active
                      ? "border-brand-red bg-brand-red text-white"
                      : "border-slate-200 bg-white text-slate-600 hover:border-brand-red/40 hover:text-brand-red"
                  )}
                >
                  {getRepDetailListRangeLabel(option, preset)}
                </button>
              );
            })}
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <DealsListSection
            scope="all"
            eyebrow="Deals"
            title="Deal records"
            subtitle={`Deals assigned to ${data.winLoss.repName} in the selected window, on the outcome date axis (won/lost/stage-entry) — matching the KPIs above.`}
            pageSize={10}
            enableExport
            showValueTotal
            dateField="outcome"
            searchPlaceholder="Deal name, number, company, address"
            baseFilters={{
              // Rep lock (#3): pin the rep server-side; the bar OMITS the Rep dimension so a stray
              // fb_assignedRepId can never override it. The page's listRange window (which also drives
              // the KPIs above) is the date FLOOR — the bar's Date can only narrow WITHIN it.
              assignedRepId: repId,
              dateFrom: listDateRange.from,
              dateTo: listDateRange.to,
            }}
            filterBar={{
              // Every shared control EXCEPT Rep (locked above) and Scope (the page owns scope="all").
              dimensions: getDrilldownFilterBarDimensions(),
              options: {
                regions: regions.map((region) => ({ value: region.id, label: region.name })),
                projectTypes: projectTypes.map((type) => ({ value: type.id, label: type.name })),
                stages: repStageOptions.map((stage) => ({ value: stage.ids[0], label: stage.name })),
                sortOptions: DEAL_LIST_SORT_OPTIONS,
              },
              stageEntryDateEnabled: true,
              // No defaultStageIds: the rep list isn't board-scoped, so with no stage pick it shows
              // every stage (active + terminal) like the legacy list. terminalStageIds lets Won/Lost
              // through by default (Q1) unless the user picks an explicit Status.
              terminalStageIds: repTerminalStageIds,
              paramPrefix: DRILLDOWN_FILTERBAR_PARAM_PREFIX,
              // Default to the outcome display-date axis (matches the legacy rep list's initial sort).
              defaultSort: DEAL_LIST_INITIAL_SORT,
            }}
          />

          <DirectorRepLeadsListSection
            repId={repId}
            repName={data.winLoss.repName || "this rep"}
            dateRange={listDateRange}
          />
        </CardContent>
      </Card>

      <StaleDealList deals={data.staleDeals} />
      <StaleLeadList leads={data.staleLeads} dateRange={dateRange} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Pipeline by Stage</CardTitle>
          </CardHeader>
          <CardContent>
            {data.pipelineByStage.length > 0 ? (
              <PipelineBarChart data={data.pipelineByStage} />
            ) : (
              <p className="py-8 text-center text-muted-foreground">No pipeline data.</p>
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
              <p className="py-8 text-center text-muted-foreground">No data yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
