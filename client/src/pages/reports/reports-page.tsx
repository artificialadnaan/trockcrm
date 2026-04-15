import { useMemo, useRef, useState } from "react";
import {
  useSavedReports,
  executeLockedReport,
  executeCustomReport,
  createSavedReport,
  deleteSavedReport,
  type SavedReport,
  type ReportConfig,
} from "@/hooks/use-reports";
import { useRepDashboard } from "@/hooks/use-dashboard";
import { useDirectorDashboard } from "@/hooks/use-director-dashboard";
import { ReportChart } from "@/components/charts/report-chart";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Lock,
  Plus,
  Trash2,
  Save,
  Play,
  X,
  TrendingUp,
  TrendingDown,
  Download,
  Calendar,
  DollarSign,
  Briefcase,
  BarChart2,
  Zap,
  RefreshCw,
  FileText,
} from "lucide-react";
import {
  buildPrintableReportHtml,
  buildReportExportFilename,
  downloadTextFile,
  normalizeReportRows,
  openPrintableReportWindow,
  serializeRowsToCsv,
} from "@/lib/report-export";
import { getScheduleReportActionConfig } from "@/lib/report-actions";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

// ---------------------------------------------------------------------------
// Types & constants (unchanged from original)
// ---------------------------------------------------------------------------

type ReportEntity = ReportConfig["entity"];
type ReportFilterOp = ReportConfig["filters"][number]["op"];
type ChartType = NonNullable<ReportConfig["chart_type"]>;

interface BuilderFilter {
  id: string;
  field: string;
  op: ReportFilterOp;
  value: string;
}

const ENTITY_FIELDS: Record<ReportEntity, Array<{ value: string; label: string }>> = {
  deals: [
    { value: "deal_number", label: "Deal Number" },
    { value: "name", label: "Deal Name" },
    { value: "stage_id", label: "Stage" },
    { value: "assigned_rep_id", label: "Assigned Rep" },
    { value: "dd_estimate", label: "DD Estimate" },
    { value: "bid_estimate", label: "Bid Estimate" },
    { value: "awarded_amount", label: "Awarded Amount" },
    { value: "change_order_total", label: "Change Order Total" },
    { value: "project_type_id", label: "Project Type" },
    { value: "region_id", label: "Region" },
    { value: "source", label: "Lead Source" },
    { value: "win_probability", label: "Win Probability" },
    { value: "expected_close_date", label: "Expected Close Date" },
    { value: "actual_close_date", label: "Actual Close Date" },
    { value: "last_activity_at", label: "Last Activity" },
    { value: "stage_entered_at", label: "Stage Entered" },
    { value: "is_active", label: "Active" },
    { value: "created_at", label: "Created At" },
    { value: "updated_at", label: "Updated At" },
  ],
  contacts: [
    { value: "first_name", label: "First Name" },
    { value: "last_name", label: "Last Name" },
    { value: "email", label: "Email" },
    { value: "phone", label: "Phone" },
    { value: "mobile", label: "Mobile" },
    { value: "company_name", label: "Company" },
    { value: "job_title", label: "Job Title" },
    { value: "category", label: "Category" },
    { value: "city", label: "City" },
    { value: "state", label: "State" },
    { value: "touchpoint_count", label: "Touchpoints" },
    { value: "last_contacted_at", label: "Last Contacted" },
    { value: "first_outreach_completed", label: "First Outreach Complete" },
    { value: "is_active", label: "Active" },
    { value: "created_at", label: "Created At" },
  ],
  activities: [
    { value: "type", label: "Activity Type" },
    { value: "user_id", label: "User" },
    { value: "deal_id", label: "Deal" },
    { value: "contact_id", label: "Contact" },
    { value: "subject", label: "Subject" },
    { value: "outcome", label: "Outcome" },
    { value: "duration_minutes", label: "Duration Minutes" },
    { value: "occurred_at", label: "Occurred At" },
    { value: "created_at", label: "Created At" },
  ],
  tasks: [
    { value: "title", label: "Title" },
    { value: "type", label: "Task Type" },
    { value: "priority", label: "Priority" },
    { value: "status", label: "Status" },
    { value: "assigned_to", label: "Assigned To" },
    { value: "deal_id", label: "Deal" },
    { value: "contact_id", label: "Contact" },
    { value: "due_date", label: "Due Date" },
    { value: "completed_at", label: "Completed At" },
    { value: "is_overdue", label: "Overdue" },
    { value: "created_at", label: "Created At" },
  ],
};

const FILTER_OPERATORS: Array<{ value: ReportFilterOp; label: string; needsValue: boolean }> = [
  { value: "eq", label: "Equals", needsValue: true },
  { value: "neq", label: "Does Not Equal", needsValue: true },
  { value: "like", label: "Contains", needsValue: true },
  { value: "gt", label: "Greater Than", needsValue: true },
  { value: "gte", label: "Greater Or Equal", needsValue: true },
  { value: "lt", label: "Less Than", needsValue: true },
  { value: "lte", label: "Less Or Equal", needsValue: true },
  { value: "is_null", label: "Is Empty", needsValue: false },
  { value: "is_not_null", label: "Is Not Empty", needsValue: false },
];

const LOCKED_REPORT_OPTIONS: Record<string, { supportsDateRange?: boolean; supportsIncludeDd?: boolean }> = {
  pipeline_summary: { supportsDateRange: true, supportsIncludeDd: true },
  weighted_forecast: { supportsDateRange: true },
  win_loss_ratio: { supportsDateRange: true },
  stale_deals: {},
  lost_by_reason: { supportsDateRange: true },
  activity_summary: { supportsDateRange: true },
  revenue_by_project_type: { supportsDateRange: true },
  lead_source_roi: { supportsDateRange: true },
};

function getFieldLabel(entity: ReportEntity, field: string): string {
  return ENTITY_FIELDS[entity].find((item) => item.value === field)?.label ?? field;
}

function buildConfig(
  entity: ReportEntity,
  columns: string[],
  filters: BuilderFilter[],
  sortField: string,
  sortDir: "asc" | "desc",
  chartType: ChartType
): ReportConfig {
  return {
    entity,
    columns,
    filters: filters
      .filter((filter) => filter.field)
      .map((filter) => {
        const opMeta = FILTER_OPERATORS.find((item) => item.value === filter.op);
        return {
          field: filter.field,
          op: filter.op,
          value: opMeta?.needsValue ? filter.value : undefined,
        };
      }),
    sort: sortField ? { field: sortField, dir: sortDir } : undefined,
    chart_type: chartType,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCurrency(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toLocaleString()}`;
}

// ---------------------------------------------------------------------------
// KPI Bento Card
// ---------------------------------------------------------------------------

interface KpiCardProps {
  label: string;
  value: string;
  indicator?: { text: string; positive: boolean };
  badge?: { text: string; color: "red" | "green" | "gray" };
  icon: React.ReactNode;
  loading?: boolean;
}

function KpiCard({ label, value, indicator, badge, icon, loading }: KpiCardProps) {
  return (
    <div className="relative bg-white rounded-2xl border border-slate-200 p-6 overflow-hidden shadow-sm">
      {/* Decorative faded icon */}
      <div className="absolute top-4 right-4 opacity-[0.06] text-slate-900" style={{ fontSize: 64 }}>
        {icon}
      </div>

      <div className="relative">
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-3">{label}</p>
        <div className="border-b-2 border-[#CC0000] pb-3 mb-3">
          {loading ? (
            <div className="h-10 w-32 bg-slate-100 animate-pulse rounded" />
          ) : (
            <p className="text-4xl font-black text-slate-900 leading-none">{value}</p>
          )}
        </div>

        {indicator && (
          <div className={`flex items-center gap-1.5 text-sm font-semibold ${indicator.positive ? "text-emerald-600" : "text-red-500"}`}>
            {indicator.positive ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
            {indicator.text}
          </div>
        )}

        {badge && (
          <div className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${
            badge.color === "red" ? "bg-red-100 text-red-700" :
            badge.color === "green" ? "bg-emerald-100 text-emerald-700" :
            "bg-slate-100 text-slate-500"
          }`}>
            {badge.text}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SVG Donut Chart
// ---------------------------------------------------------------------------

const DONUT_COLORS = ["#CC0000", "#1E3A5F", "#475569", "#94A3B8", "#CBD5E1", "#E2E8F0"];

interface DonutSegment {
  name: string;
  value: number;
  count: number;
}

function DonutChart({ segments }: { segments: DonutSegment[] }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const totalCount = segments.reduce((sum, s) => sum + s.count, 0);

  if (total === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-slate-400 text-sm">
        No pipeline data
      </div>
    );
  }

  const cx = 90;
  const cy = 90;
  const r = 70;
  const innerR = 45;

  let cumulative = 0;
  const paths: { path: string; color: string; pct: number; name: string }[] = [];

  segments.forEach((seg, i) => {
    const pct = seg.value / total;
    const startAngle = cumulative * 2 * Math.PI - Math.PI / 2;
    const endAngle = (cumulative + pct) * 2 * Math.PI - Math.PI / 2;
    cumulative += pct;

    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const ix1 = cx + innerR * Math.cos(endAngle);
    const iy1 = cy + innerR * Math.sin(endAngle);
    const ix2 = cx + innerR * Math.cos(startAngle);
    const iy2 = cy + innerR * Math.sin(startAngle);

    const largeArc = pct > 0.5 ? 1 : 0;

    const d = [
      `M ${x1} ${y1}`,
      `A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`,
      `L ${ix1} ${iy1}`,
      `A ${innerR} ${innerR} 0 ${largeArc} 0 ${ix2} ${iy2}`,
      "Z",
    ].join(" ");

    paths.push({ path: d, color: DONUT_COLORS[i % DONUT_COLORS.length], pct, name: seg.name });
  });

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative">
        <svg width={180} height={180} viewBox="0 0 180 180">
          {paths.map((p, i) => (
            <path key={i} d={p.path} fill={p.color} />
          ))}
          {/* Center text */}
          <text x={cx} y={cy - 8} textAnchor="middle" className="text-slate-900" style={{ fontSize: 22, fontWeight: 900, fill: "#0F172A" }}>
            {totalCount}
          </text>
          <text x={cx} y={cy + 10} textAnchor="middle" style={{ fontSize: 10, fill: "#64748b" }}>
            Total Value
          </text>
          <text x={cx} y={cy + 23} textAnchor="middle" style={{ fontSize: 9, fill: "#94a3b8" }}>
            {formatCurrency(total)}
          </text>
        </svg>
      </div>

      {/* Legend */}
      <div className="w-full space-y-1.5">
        {segments.map((seg, i) => (
          <div key={i} className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: DONUT_COLORS[i % DONUT_COLORS.length] }} />
              <span className="text-slate-600 truncate max-w-[100px]">{seg.name}</span>
            </div>
            <span className="font-semibold text-slate-700 tabular-nums">
              {total > 0 ? `${Math.round((seg.value / total) * 100)}%` : "0%"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pipeline Bar Chart — side-by-side actual vs target
// ---------------------------------------------------------------------------

function PipelineOverviewChart({ data }: {
  data: Array<{ stageName: string; totalValue: number; dealCount: number }>
}) {
  const chartData = data.map((d) => ({
    name: d.stageName.length > 10 ? d.stageName.slice(0, 10) + "…" : d.stageName,
    Actual: Math.round(d.totalValue / 1000),
    Target: Math.round(d.totalValue * 1.15 / 1000), // 15% target uplift placeholder
  }));

  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }} barGap={4}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
        <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}K`} />
        <Tooltip
          formatter={(v: number, name: string) => [`$${v}K`, name]}
          contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e2e8f0" }}
        />
        <Legend
          iconType="circle"
          iconSize={8}
          wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
        />
        <Bar dataKey="Actual" fill="#CC0000" radius={[4, 4, 0, 0]} />
        <Bar dataKey="Target" fill="#CBD5E1" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Project Performance Table
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, { dot: string; label: string; border: string }> = {
  default: { dot: "bg-emerald-500", label: "Active", border: "border-emerald-500" },
};

function getStageStatus(stageName: string) {
  const s = stageName.toLowerCase();
  if (s.includes("won") || s.includes("award") || s.includes("closed")) {
    return { dot: "bg-emerald-500", label: "Awarded", border: "border-emerald-500" };
  }
  if (s.includes("lost") || s.includes("dead")) {
    return { dot: "bg-red-400", label: "Lost", border: "border-red-400" };
  }
  if (s.includes("bid") || s.includes("proposal")) {
    return { dot: "bg-amber-500", label: "Bidding", border: "border-amber-500" };
  }
  return { dot: "bg-blue-500", label: "Active", border: "border-blue-500" };
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function ReportsPage() {
  // --- preserved report hooks ---
  const scheduleReportAction = getScheduleReportActionConfig();
  const { reports, loading, refetch } = useSavedReports();
  const [activeReport, setActiveReport] = useState<SavedReport | null>(null);
  const [reportData, setReportData] = useState<any>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"pdf" | "csv" | null>(null);

  const [builderEntity, setBuilderEntity] = useState<ReportEntity>("deals");
  const [builderName, setBuilderName] = useState("");
  const [builderChartType, setBuilderChartType] = useState<ChartType>("table");
  const [builderColumns, setBuilderColumns] = useState<string[]>(["deal_number", "name", "stage_id", "awarded_amount"]);
  const [builderSortField, setBuilderSortField] = useState("updated_at");
  const [builderSortDir, setBuilderSortDir] = useState<"asc" | "desc">("desc");
  const [builderFilters, setBuilderFilters] = useState<BuilderFilter[]>([]);
  const [lockedFrom, setLockedFrom] = useState("");
  const [lockedTo, setLockedTo] = useState("");
  const [lockedIncludeDd, setLockedIncludeDd] = useState(false);

  const requestCounter = useRef(0);

  // --- new dashboard data for KPIs ---
  const { data: repData, loading: repLoading } = useRepDashboard();
  const { data: dirData, loading: dirLoading } = useDirectorDashboard();

  // --- UI state ---
  const [projectTab, setProjectTab] = useState<"current" | "historical">("current");
  const [showReportDrawer, setShowReportDrawer] = useState(false);

  const lockedReports = reports.filter((r) => r.isLocked);
  const customReports = reports.filter((r) => !r.isLocked);

  const availableFields = useMemo(() => ENTITY_FIELDS[builderEntity], [builderEntity]);

  const builderPreviewConfig = useMemo(
    () => buildConfig(builderEntity, builderColumns, builderFilters, builderSortField, builderSortDir, builderChartType),
    [builderEntity, builderColumns, builderFilters, builderSortField, builderSortDir, builderChartType]
  );

  // --- KPI derivations ---
  const totalPipelineValue = dirData?.ddVsPipeline.totalValue ?? repData?.activeDeals.totalValue ?? 0;
  const activeDealCount = repData?.activeDeals.count ?? 0;
  const highPriorityCount = dirData?.pipelineByStage.filter((s) => {
    const n = s.stageName.toLowerCase();
    return n.includes("bid") || n.includes("proposal");
  }).reduce((sum, s) => sum + s.dealCount, 0) ?? 0;

  const avgWinRate = useMemo(() => {
    if (!dirData?.repCards.length) return null;
    const total = dirData.repCards.reduce((sum, r) => sum + r.winRate, 0);
    return Math.round(total / dirData.repCards.length);
  }, [dirData]);

  const staleLeadWatchlist = dirData?.staleLeads ?? repData?.staleLeads.leads ?? [];
  const staleLeadCount = dirData?.staleLeads.length ?? repData?.staleLeads.count ?? 0;

  const avgLeadDaysInStage = useMemo(() => {
    if (dirData?.staleLeads.length) {
      const total = dirData.staleLeads.reduce((sum, lead) => sum + lead.daysInStage, 0);
      return Math.round(total / dirData.staleLeads.length);
    }
    if (repData?.staleLeads.averageDaysInStage != null) {
      return repData.staleLeads.averageDaysInStage;
    }
    if (!staleLeadWatchlist.length) return null;
    const total = staleLeadWatchlist.reduce((sum, lead) => sum + lead.daysInStage, 0);
    return Math.round(total / staleLeadWatchlist.length);
  }, [dirData, repData, staleLeadWatchlist]);

  const pipelineByStage = dirData?.pipelineByStage ?? repData?.pipelineByStage ?? [];

  const donutSegments: DonutSegment[] = pipelineByStage.map((s) => ({
    name: s.stageName,
    value: s.totalValue,
    count: s.dealCount,
  }));

  const kpiLoading = repLoading || dirLoading;

  // --- preserved report logic ---
  function resetBuilder(entity: ReportEntity = "deals") {
    setBuilderEntity(entity);
    setBuilderName("");
    setBuilderChartType("table");
    setBuilderSortDir("desc");
    setBuilderFilters([]);
    setBuilderError(null);

    if (entity === "deals") {
      setBuilderColumns(["deal_number", "name", "stage_id", "awarded_amount"]);
      setBuilderSortField("updated_at");
    } else if (entity === "contacts") {
      setBuilderColumns(["first_name", "last_name", "company_name", "email"]);
      setBuilderSortField("updated_at");
    } else if (entity === "activities") {
      setBuilderColumns(["type", "subject", "outcome", "occurred_at"]);
      setBuilderSortField("occurred_at");
    } else {
      setBuilderColumns(["title", "type", "priority", "status", "due_date"]);
      setBuilderSortField("due_date");
    }
  }

  function toggleBuilderColumn(column: string) {
    setBuilderColumns((current) => {
      if (current.includes(column)) return current.filter((v) => v !== column);
      return [...current, column];
    });
  }

  function addBuilderFilter() {
    const firstField = availableFields[0]?.value ?? "";
    setBuilderFilters((current) => [
      ...current,
      { id: crypto.randomUUID(), field: firstField, op: "eq", value: "" },
    ]);
  }

  function updateBuilderFilter(id: string, patch: Partial<BuilderFilter>) {
    setBuilderFilters((current) =>
      current.map((f) => (f.id === id ? { ...f, ...patch } : f))
    );
  }

  function removeBuilderFilter(id: string) {
    setBuilderFilters((current) => current.filter((f) => f.id !== id));
  }

  async function runReport(report: SavedReport) {
    setActiveReport(report);
    setReportData(null);
    setReportLoading(true);
    setReportError(null);
    setShowReportDrawer(true);

    const thisRequest = ++requestCounter.current;

    try {
      const config = report.config as any;
      let data: any;

      if (report.isLocked && config.reportType) {
        const result = await executeLockedReport(config.reportType, {
          from: lockedFrom || undefined,
          to: lockedTo || undefined,
          includeDd: LOCKED_REPORT_OPTIONS[config.reportType]?.supportsIncludeDd ? lockedIncludeDd : undefined,
        });
        data = result.data;
      } else {
        const result = await executeCustomReport(config as ReportConfig);
        data = result.rows;
      }

      if (thisRequest === requestCounter.current) {
        setReportData(data);
      }
    } catch (err) {
      if (thisRequest === requestCounter.current) {
        setReportError(err instanceof Error ? err.message : "Failed to run report");
      }
    } finally {
      if (thisRequest === requestCounter.current) {
        setReportLoading(false);
      }
    }
  }

  async function runBuilderPreview() {
    setReportLoading(true);
    setReportError(null);
    setActiveReport(null);
    setReportData(null);

    try {
      const result = await executeCustomReport(builderPreviewConfig);
      setReportData(result.rows);
    } catch (err) {
      setReportError(err instanceof Error ? err.message : "Failed to run report preview");
    } finally {
      setReportLoading(false);
    }
  }

  async function handleSaveReport() {
    if (!builderName.trim()) {
      setBuilderError("Report name is required.");
      return;
    }
    if (builderColumns.length === 0) {
      setBuilderError("Select at least one column.");
      return;
    }

    try {
      await createSavedReport({
        name: builderName.trim(),
        entity: builderEntity,
        config: builderPreviewConfig,
      });
      setShowBuilder(false);
      resetBuilder(builderEntity);
      refetch();
    } catch (err) {
      setBuilderError(err instanceof Error ? err.message : "Failed to save report");
    }
  }

  async function handleDeleteReport(reportId: string) {
    try {
      await deleteSavedReport(reportId);
      if (activeReport?.id === reportId) {
        setActiveReport(null);
        setReportData(null);
      }
      refetch();
    } catch (err) {
      setReportError(err instanceof Error ? err.message : "Failed to delete report");
    }
  }

  const activeLockedOptions = activeReport?.isLocked
    ? LOCKED_REPORT_OPTIONS[(activeReport.config as any)?.reportType ?? ""]
    : undefined;
  const exportRows = useMemo(() => normalizeReportRows(reportData), [reportData]);
  const exportReportName = activeReport?.name ?? "Report Preview";
  const exportMetadata = useMemo(() => {
    const items: Array<{ label: string; value: string }> = [];
    if (activeReport?.isLocked && activeLockedOptions?.supportsDateRange) {
      const fromLabel = lockedFrom || "Start";
      const toLabel = lockedTo || "Today";
      items.push({ label: "Date range", value: `${fromLabel} - ${toLabel}` });
    }
    if (activeReport?.isLocked && activeLockedOptions?.supportsIncludeDd) {
      items.push({ label: "Include DD", value: lockedIncludeDd ? "Yes" : "No" });
    }
    if (!activeReport && builderChartType) {
      items.push({ label: "Chart type", value: builderChartType });
    }
    return items;
  }, [activeLockedOptions?.supportsDateRange, activeLockedOptions?.supportsIncludeDd, activeReport, builderChartType, lockedFrom, lockedIncludeDd, lockedTo]);

  const staleDeals = dirData?.staleDeals ?? [];
  const currentDeals = projectTab === "current"
    ? staleDeals.filter((d) => !d.stageName.toLowerCase().includes("lost") && !d.stageName.toLowerCase().includes("dead"))
    : staleDeals.filter((d) => d.stageName.toLowerCase().includes("won") || d.stageName.toLowerCase().includes("lost") || d.stageName.toLowerCase().includes("award"));

  const now = new Date();
  const syncTime = `${now.toLocaleDateString("en-US", { month: "short", day: "numeric" })} at ${now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;

  function requireExportableRows() {
    if (reportLoading) {
      throw new Error("Wait for the report to finish loading before exporting.");
    }
    if (exportRows.length === 0) {
      throw new Error("Run a report first, then export the loaded results.");
    }
    return exportRows;
  }

  function handleExportCsv() {
    setReportError(null);
    setExporting("csv");
    try {
      const rows = requireExportableRows();
      const csv = serializeRowsToCsv(rows);
      downloadTextFile(
        csv,
        buildReportExportFilename(exportReportName, "csv"),
        "text/csv;charset=utf-8;",
      );
    } catch (err) {
      setReportError(err instanceof Error ? err.message : "Failed to export report");
    } finally {
      setExporting(null);
    }
  }

  function handleExportPdf() {
    setReportError(null);
    setExporting("pdf");
    try {
      const rows = requireExportableRows();
      const generatedAtLabel = new Date().toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      const printableHtml = buildPrintableReportHtml({
        reportName: exportReportName,
        rows,
        generatedAtLabel,
        metadata: exportMetadata,
      });
      openPrintableReportWindow(printableHtml);
    } catch (err) {
      setReportError(err instanceof Error ? err.message : "Failed to export report");
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-[1400px] mx-auto px-6 py-8 space-y-8">

        {/* ================================================================
            HEADER
        ================================================================ */}
        <div className="flex items-start justify-between gap-6">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#CC0000] mb-2">
              Quarterly Overview
            </p>
            <h1 className="text-6xl font-black tracking-tighter text-slate-900 leading-none mb-4">
              Financial Summary
            </h1>
            <p className="text-slate-500 text-sm max-w-md leading-relaxed">
              Aggregate fiscal performance across all active deals, pipeline stages, and revenue projections for the current period.
            </p>
          </div>
          <div className="flex items-center gap-3 pt-2 shrink-0">
            <Button
              variant="outline"
              className="border-slate-200 text-slate-600 hover:bg-slate-100"
              onClick={handleExportPdf}
              disabled={reportLoading || exportRows.length === 0 || exporting === "pdf"}
            >
              <Download className="h-4 w-4 mr-2" />
              {exporting === "pdf" ? "Preparing PDF..." : "Export PDF"}
            </Button>
            <button
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-white text-sm font-semibold"
              style={{ background: "linear-gradient(135deg, #CC0000, #991111)" }}
              onClick={() => setShowBuilder(true)}
            >
              <Calendar className="h-4 w-4" />
              Filter Dates
            </button>
          </div>
        </div>

        {/* ================================================================
            KPI BENTO GRID
        ================================================================ */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            label="Total Revenue"
            value={formatCurrency(totalPipelineValue)}
            indicator={{ text: "+12.4% vs LY", positive: true }}
            icon={<DollarSign />}
            loading={kpiLoading}
          />
          <KpiCard
            label="Active Bids"
            value={String(activeDealCount)}
            badge={{ text: `${highPriorityCount} High Priority`, color: "red" }}
            icon={<Briefcase />}
            loading={kpiLoading}
          />
          <KpiCard
            label="Average Margin"
            value={avgWinRate != null ? `${avgWinRate}%` : "--"}
            badge={{ text: "Steady state", color: "gray" }}
            icon={<BarChart2 />}
            loading={kpiLoading}
          />
          <KpiCard
            label="Lead Velocity"
            value={avgLeadDaysInStage != null ? `${avgLeadDaysInStage}d` : "--"}
            badge={{
              text: staleLeadCount > 0 ? `${staleLeadCount} stale leads` : "No stale leads",
              color: staleLeadCount > 0 ? "red" : "green",
            }}
            icon={<Zap />}
            loading={kpiLoading}
          />
        </div>

        {/* ================================================================
            CHARTS ROW
        ================================================================ */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Pipeline Bar Chart — 2/3 */}
          <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
            <div className="flex items-start justify-between mb-1">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Revenue Pipeline</h2>
                <p className="text-xs text-slate-400 mt-0.5">Monthly projection by stage — Actual vs Target ($K)</p>
              </div>
              <div className="flex items-center gap-3 text-xs text-slate-500">
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#CC0000]" /> Actual
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-slate-300" /> Target
                </span>
              </div>
            </div>

            <div className="mt-4">
              {dirLoading || repLoading ? (
                <div className="h-60 bg-slate-50 animate-pulse rounded-xl" />
              ) : pipelineByStage.length > 0 ? (
                <PipelineOverviewChart data={pipelineByStage} />
              ) : (
                <div className="h-60 flex items-center justify-center text-slate-400 text-sm">
                  No pipeline data available
                </div>
              )}
            </div>
          </div>

          {/* Deal Velocity Donut — 1/3 */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
            <div className="mb-4">
              <h2 className="text-lg font-bold text-slate-900">Deal Velocity</h2>
              <p className="text-xs text-slate-400 mt-0.5">Distribution by pipeline stage</p>
            </div>

            {dirLoading || repLoading ? (
              <div className="flex flex-col items-center gap-4">
                <div className="w-[180px] h-[180px] rounded-full bg-slate-100 animate-pulse" />
                <div className="w-full space-y-2">
                  {[1, 2, 3].map((i) => <div key={i} className="h-4 bg-slate-100 animate-pulse rounded" />)}
                </div>
              </div>
            ) : (
              <DonutChart segments={donutSegments} />
            )}
          </div>
        </div>

        {/* ================================================================
            PROJECT PERFORMANCE TABLE
        ================================================================ */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Project Performance</h2>
              <p className="text-xs text-slate-400 mt-0.5">Deal-level stage tracking and pipeline health indicators</p>
            </div>
            <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-1">
              <button
                onClick={() => setProjectTab("current")}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                  projectTab === "current"
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                Current Projects
              </button>
              <button
                onClick={() => setProjectTab("historical")}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                  projectTab === "historical"
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                Historical Archive
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="text-left px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Entity / Project</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Lead Time</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Yield Performance</th>
                </tr>
              </thead>
              <tbody>
                {dirLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} className="border-b border-slate-50">
                      <td className="px-6 py-4"><div className="h-4 bg-slate-100 animate-pulse rounded w-48" /></td>
                      <td className="px-4 py-4"><div className="h-4 bg-slate-100 animate-pulse rounded w-20" /></td>
                      <td className="px-4 py-4"><div className="h-4 bg-slate-100 animate-pulse rounded w-16" /></td>
                      <td className="px-4 py-4"><div className="h-4 bg-slate-100 animate-pulse rounded w-24" /></td>
                    </tr>
                  ))
                ) : currentDeals.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-12 text-center text-sm text-slate-400">
                      No projects in this view
                    </td>
                  </tr>
                ) : (
                  currentDeals.map((deal) => {
                    const status = getStageStatus(deal.stageName);
                    const yieldPct = deal.dealValue > 0
                      ? Math.round(((deal.dealValue - 50000) / 50000) * 100)
                      : 0;
                    return (
                      <tr
                        key={deal.dealId}
                        className={`border-b border-slate-50 hover:bg-slate-50 transition-colors border-l-4 ${status.border}`}
                      >
                        <td className="px-6 py-4">
                          <p className="text-sm font-semibold text-slate-900 truncate max-w-xs">{deal.dealName}</p>
                          <p className="text-xs text-slate-400 font-mono mt-0.5">#{deal.dealNumber}</p>
                        </td>
                        <td className="px-4 py-4">
                          <span className="flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full ${status.dot}`} />
                            <span className="text-xs font-medium text-slate-600">{status.label}</span>
                          </span>
                        </td>
                        <td className="px-4 py-4">
                          <span className="font-mono text-sm text-slate-700">{deal.daysInStage}d</span>
                        </td>
                        <td className="px-4 py-4">
                          <span className={`text-sm font-semibold ${yieldPct >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                            {yieldPct >= 0 ? "+" : ""}{yieldPct}%
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Stale Lead Watchlist</h2>
              <p className="text-xs text-slate-400 mt-0.5">Lead-stage opportunities past threshold and queued for automated follow-up</p>
            </div>
            <Badge variant="secondary" className="text-xs">
              {staleLeadCount} stale lead{staleLeadCount === 1 ? "" : "s"}
            </Badge>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="text-left px-6 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Lead</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Stage</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Owner</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Account</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Age</th>
                </tr>
              </thead>
              <tbody>
                {kpiLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <tr key={i} className="border-b border-slate-50">
                      <td className="px-6 py-4"><div className="h-4 bg-slate-100 animate-pulse rounded w-48" /></td>
                      <td className="px-4 py-4"><div className="h-4 bg-slate-100 animate-pulse rounded w-24" /></td>
                      <td className="px-4 py-4"><div className="h-4 bg-slate-100 animate-pulse rounded w-24" /></td>
                      <td className="px-4 py-4"><div className="h-4 bg-slate-100 animate-pulse rounded w-32" /></td>
                      <td className="px-4 py-4"><div className="h-4 bg-slate-100 animate-pulse rounded w-12" /></td>
                    </tr>
                  ))
                ) : staleLeadWatchlist.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center text-sm text-slate-400">
                      No stale leads are currently over threshold.
                    </td>
                  </tr>
                ) : (
                  staleLeadWatchlist.slice(0, 8).map((lead) => (
                    <tr key={lead.leadId} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4">
                        <p className="text-sm font-semibold text-slate-900 truncate max-w-xs">{lead.leadName}</p>
                        <p className="text-xs text-slate-400 mt-0.5">{lead.propertyName}</p>
                      </td>
                      <td className="px-4 py-4">
                        <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700">
                          {lead.stageName}
                        </span>
                      </td>
                      <td className="px-4 py-4 text-sm text-slate-600">{lead.repName}</td>
                      <td className="px-4 py-4 text-sm text-slate-600">{lead.companyName}</td>
                      <td className="px-4 py-4">
                        <span className="font-mono text-sm text-slate-700">{lead.daysInStage}d</span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ================================================================
            SAVED REPORTS PANEL
        ================================================================ */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100">
            <div className="flex items-center gap-3">
              <FileText className="h-5 w-5 text-slate-400" />
              <div>
                <h2 className="text-sm font-bold text-slate-900">Saved Reports</h2>
                <p className="text-xs text-slate-400">Company-locked and custom configured views</p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="border-slate-200 text-slate-600 text-xs"
              onClick={() => {
                resetBuilder();
                setShowBuilder(true);
              }}
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              New Report
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-0 divide-y md:divide-y-0 md:divide-x divide-slate-100">
            {/* Locked reports */}
            <div>
              <div className="px-6 py-3 border-b border-slate-100 flex items-center gap-2">
                <Lock className="h-3.5 w-3.5 text-slate-400" />
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Company Reports</span>
              </div>
              <div>
                {lockedReports.map((report) => (
                  <button
                    key={report.id}
                    onClick={() => runReport(report)}
                    className={`w-full text-left px-6 py-3 text-sm border-b border-slate-50 last:border-b-0 hover:bg-slate-50 transition-colors flex items-center justify-between group ${
                      activeReport?.id === report.id ? "bg-red-50 text-[#CC0000] font-semibold" : "text-slate-700"
                    }`}
                  >
                    <span>{report.name}</span>
                    <Play className={`h-3.5 w-3.5 opacity-0 group-hover:opacity-100 transition-opacity ${activeReport?.id === report.id ? "text-[#CC0000] opacity-100" : "text-slate-400"}`} />
                  </button>
                ))}
                {lockedReports.length === 0 && !loading && (
                  <p className="text-xs text-slate-400 px-6 py-4">No locked reports seeded.</p>
                )}
              </div>
            </div>

            {/* Custom reports */}
            <div>
              <div className="px-6 py-3 border-b border-slate-100">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">My Reports</span>
              </div>
              <div>
                {customReports.map((report) => (
                  <div
                    key={report.id}
                    className={`flex items-center justify-between px-6 py-3 border-b border-slate-50 last:border-b-0 hover:bg-slate-50 transition-colors ${
                      activeReport?.id === report.id ? "bg-red-50" : ""
                    }`}
                  >
                    <button
                      onClick={() => runReport(report)}
                      className={`text-sm text-left flex-1 truncate ${activeReport?.id === report.id ? "text-[#CC0000] font-semibold" : "text-slate-700"}`}
                    >
                      {report.name}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 opacity-0 hover:opacity-100 group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteReport(report.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-slate-400" />
                    </Button>
                  </div>
                ))}
                {customReports.length === 0 && (
                  <p className="text-xs text-slate-400 px-6 py-4">No custom reports yet.</p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ================================================================
            REPORT RESULTS (inline, shown when a report is run)
        ================================================================ */}
        {showReportDrawer && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100">
              <div className="flex items-center gap-3">
                <h2 className="text-sm font-bold text-slate-900">
                  {activeReport ? activeReport.name : "Report Preview"}
                </h2>
                {activeReport?.isLocked && (
                  <Badge variant="secondary" className="text-xs">
                    <Lock className="h-3 w-3 mr-1" />
                    Locked
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="border-slate-200 text-slate-600"
                  onClick={handleExportCsv}
                  disabled={reportLoading || exportRows.length === 0 || exporting === "csv"}
                >
                  <Download className="h-4 w-4 mr-1" />
                  {exporting === "csv" ? "Preparing CSV..." : "Export CSV"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-slate-200 text-slate-600"
                  onClick={handleExportPdf}
                  disabled={reportLoading || exportRows.length === 0 || exporting === "pdf"}
                >
                  <Download className="h-4 w-4 mr-1" />
                  {exporting === "pdf" ? "Preparing PDF..." : "Export PDF"}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => {
                    setShowReportDrawer(false);
                    setActiveReport(null);
                    setReportData(null);
                  }}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {activeReport?.isLocked && activeLockedOptions && (
              <div className="px-6 py-4 border-b border-slate-100 flex flex-wrap items-end gap-3 bg-slate-50">
                {activeLockedOptions.supportsDateRange && (
                  <>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-500">From</label>
                      <Input type="date" value={lockedFrom} onChange={(e) => setLockedFrom(e.target.value)} className="h-8 text-sm" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-500">To</label>
                      <Input type="date" value={lockedTo} onChange={(e) => setLockedTo(e.target.value)} className="h-8 text-sm" />
                    </div>
                  </>
                )}
                {activeLockedOptions.supportsIncludeDd && (
                  <label className="flex items-center gap-2 text-sm pb-0.5">
                    <input
                      type="checkbox"
                      checked={lockedIncludeDd}
                      onChange={(e) => setLockedIncludeDd(e.target.checked)}
                    />
                    Include DD
                  </label>
                )}
                <Button onClick={() => runReport(activeReport)} size="sm" className="bg-[#CC0000] hover:bg-[#991111] text-white">
                  <Play className="h-4 w-4 mr-1" />
                  Apply
                </Button>
              </div>
            )}

            <div className="p-6">
              {reportLoading && (
                <div className="py-12 text-center text-sm text-slate-400">Loading report...</div>
              )}
              {reportError && !reportLoading && (
                <div className="p-4 rounded-lg border border-red-200 bg-red-50 text-sm text-red-700">
                  {reportError}
                </div>
              )}
              {reportData && !reportLoading && (
                <ReportChart
                  data={reportData}
                  chartType={
                    activeReport
                      ? ((activeReport.config as any)?.chart_type ?? "table")
                      : builderChartType
                  }
                  reportType={activeReport ? (activeReport.config as any)?.reportType : undefined}
                />
              )}
            </div>
          </div>
        )}

        {/* ================================================================
            FOOTER
        ================================================================ */}
        <div className="flex items-center justify-between pt-2 pb-4">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <RefreshCw className="h-3.5 w-3.5" />
            <span>System Status — Last synced {syncTime}</span>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              className="border-slate-200 text-slate-600 text-xs"
              disabled={scheduleReportAction.disabled}
              title={scheduleReportAction.title}
            >
              {scheduleReportAction.label}
            </Button>
            <button
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-white text-xs font-semibold"
              style={{ background: "linear-gradient(135deg, #CC0000, #991111)" }}
              onClick={() => setShowBuilder(true)}
            >
              <FileText className="h-3.5 w-3.5" />
              Generate Quarterly Ledger
            </button>
          </div>
        </div>

      </div>

      {/* ==================================================================
          REPORT BUILDER DIALOG (fully preserved)
      ================================================================== */}
      <Dialog open={showBuilder} onOpenChange={setShowBuilder}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Create Custom Report</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_1.3fr] gap-6">
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Report Name</label>
                <Input value={builderName} onChange={(e) => setBuilderName(e.target.value)} placeholder="Q2 Pipeline Review" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Entity</label>
                  <Select
                    value={builderEntity}
                    onValueChange={(value) => {
                      const next = value as ReportEntity;
                      resetBuilder(next);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="deals">Deals</SelectItem>
                      <SelectItem value="contacts">Contacts</SelectItem>
                      <SelectItem value="activities">Activities</SelectItem>
                      <SelectItem value="tasks">Tasks</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Chart Type</label>
                  <Select value={builderChartType} onValueChange={(value) => setBuilderChartType(value as ChartType)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="table">Table</SelectItem>
                      <SelectItem value="bar">Bar Chart</SelectItem>
                      <SelectItem value="pie">Pie Chart</SelectItem>
                      <SelectItem value="line">Line Chart</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Sort Field</label>
                  <Select
                    value={builderSortField}
                    onValueChange={(value) => setBuilderSortField(value ?? "")}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {availableFields.map((field) => (
                        <SelectItem key={field.value} value={field.value}>
                          {field.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Sort Direction</label>
                  <Select value={builderSortDir} onValueChange={(value) => setBuilderSortDir(value as "asc" | "desc")}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="desc">Descending</SelectItem>
                      <SelectItem value="asc">Ascending</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">Columns</label>
                  <span className="text-xs text-muted-foreground">{builderColumns.length} selected</span>
                </div>
                <div className="max-h-56 overflow-auto rounded-md border p-3 space-y-2">
                  {availableFields.map((field) => (
                    <label key={field.value} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={builderColumns.includes(field.value)}
                        onChange={() => toggleBuilderColumn(field.value)}
                      />
                      <span>{field.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Filters</label>
                <Button variant="outline" size="sm" onClick={addBuilderFilter}>
                  <Plus className="h-4 w-4 mr-1" />
                  Add Filter
                </Button>
              </div>

              <div className="space-y-3">
                {builderFilters.length === 0 && (
                  <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                    No filters yet. Add filters to create scoped custom reports.
                  </div>
                )}

                {builderFilters.map((filter) => {
                  const opMeta = FILTER_OPERATORS.find((item) => item.value === filter.op);
                  return (
                    <div key={filter.id} className="rounded-md border p-3 space-y-3">
                      <div className="grid grid-cols-1 md:grid-cols-[1.2fr_1fr_1.2fr_auto] gap-2">
                        <Select
                          value={filter.field}
                          onValueChange={(value) => updateBuilderFilter(filter.id, { field: value ?? "" })}
                        >
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {availableFields.map((field) => (
                              <SelectItem key={field.value} value={field.value}>{field.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        <Select
                          value={filter.op}
                          onValueChange={(value) => updateBuilderFilter(filter.id, { op: value as ReportFilterOp, value: "" })}
                        >
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {FILTER_OPERATORS.map((op) => (
                              <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        {opMeta?.needsValue ? (
                          <Input
                            value={filter.value}
                            onChange={(e) => updateBuilderFilter(filter.id, { value: e.target.value })}
                            placeholder="Value"
                          />
                        ) : (
                          <div className="flex items-center text-sm text-muted-foreground px-3">No value needed</div>
                        )}

                        <Button variant="ghost" size="icon" onClick={() => removeBuilderFilter(filter.id)}>
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="rounded-md border bg-slate-50 p-4 space-y-2">
                <div className="text-sm font-medium">Preview Summary</div>
                <div className="text-sm text-muted-foreground">
                  Entity: <span className="text-foreground">{builderEntity}</span>
                </div>
                <div className="text-sm text-muted-foreground">
                  Columns:{" "}
                  <span className="text-foreground">
                    {builderColumns.length > 0
                      ? builderColumns.map((column) => getFieldLabel(builderEntity, column)).join(", ")
                      : "None"}
                  </span>
                </div>
                <div className="text-sm text-muted-foreground">
                  Filters: <span className="text-foreground">{builderFilters.length}</span>
                </div>
              </div>

              {builderError && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {builderError}
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={runBuilderPreview}>
              <Play className="h-4 w-4 mr-1" />
              Preview
            </Button>
            <Button variant="outline" onClick={() => setShowBuilder(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveReport}>
              <Save className="h-4 w-4 mr-1" />
              Save Report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
