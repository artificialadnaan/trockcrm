import { useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import {
  useSavedReports,
  executeLockedReport,
  executeCustomReport,
  createSavedReport,
  deleteSavedReport,
  useUnifiedWorkflowOverview,
  useDataMiningOverview,
  useRegionalOwnershipOverview,
  type SavedReport,
  type ReportConfig,
  type UnifiedWorkflowOverview,
} from "@/hooks/use-reports";
import { ReportChart } from "@/components/charts/report-chart";
import { SourcePerformanceSection } from "@/components/reports/source-performance-section";
import { ForecastVarianceSection } from "@/components/reports/forecast-variance-section";
import { DataMiningSection } from "@/components/reports/data-mining-section";
import { RegionalOwnershipSection } from "@/components/reports/regional-ownership-section";
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
  RefreshCw,
  FileText,
  Building2,
  ClipboardList,
  Clock3,
  Activity,
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
  workflow_overview: {},
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

export function canViewDataMiningSection(role?: string | null): boolean {
  return role === "director";
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
// Workflow Overview
// ---------------------------------------------------------------------------

function formatWorkflowRoute(route: "estimating" | "service") {
  return route === "service" ? "Service" : "Standard";
}

function formatWorkflowStatus(status: string) {
  return status
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

interface WorkflowTableColumn<T> {
  key: string;
  label: string;
  align?: "left" | "right";
  render: (row: T) => React.ReactNode;
}

function WorkflowTableSection<T extends object>({
  title,
  subtitle,
  rows,
  columns,
  emptyMessage,
}: {
  title: string;
  subtitle: string;
  rows: T[];
  columns: WorkflowTableColumn<T>[];
  emptyMessage: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-6 py-5 border-b border-slate-100">
        <h2 className="text-lg font-bold text-slate-900">{title}</h2>
        <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-100">
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={`px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400 ${column.align === "right" ? "text-right" : "text-left"}`}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-6 py-10 text-center text-sm text-slate-400">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr key={index} className="border-b border-slate-50 last:border-b-0 hover:bg-slate-50 transition-colors">
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={`px-4 py-4 text-sm text-slate-700 ${column.align === "right" ? "text-right tabular-nums" : ""}`}
                    >
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WorkflowOverviewPanel({
  data,
  loading,
}: {
  data: UnifiedWorkflowOverview | null;
  loading?: boolean;
}) {
  const leadPipelineCount = data?.leadPipelineSummary.reduce((sum, row) => sum + row.intakeCount, 0) ?? 0;
  const standardRollup = data?.standardVsServiceRollups.find((row) => row.workflowRoute === "estimating");
  const serviceRollup = data?.standardVsServiceRollups.find((row) => row.workflowRoute === "service");
  const companyCount = data?.companyRollups.length ?? 0;
  const staleLeadCount = data?.staleLeads.length ?? 0;
  const staleDealCount = data?.staleDeals.length ?? 0;

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-6">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#CC0000] mb-2">
            Unified Workflow
          </p>
          <h1 className="text-6xl font-black tracking-tighter text-slate-900 leading-none mb-4">
            Workflow Overview
          </h1>
          <p className="text-slate-500 text-sm max-w-2xl leading-relaxed">
            Consolidated lead-stage, standard deal, and service deal reporting using the current hierarchy and workflow family boundaries.
          </p>
        </div>
        <div className="flex items-center gap-3 pt-2 shrink-0">
          <button
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-white text-sm font-semibold"
            style={{ background: "linear-gradient(135deg, #CC0000, #991111)" }}
          >
            <Calendar className="h-4 w-4" />
            Current View
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <KpiCard
          label="Lead Pipeline Intakes"
          value={String(leadPipelineCount)}
          badge={{ text: "Pre-RFP", color: "gray" }}
          icon={<ClipboardList />}
          loading={loading}
        />
        <KpiCard
          label="Standard Pipeline"
          value={standardRollup ? String(standardRollup.dealCount) : "0"}
          badge={{ text: standardRollup ? formatCurrency(standardRollup.totalValue) : "$0", color: "green" }}
          icon={<Briefcase />}
          loading={loading}
        />
        <KpiCard
          label="Service Pipeline"
          value={serviceRollup ? String(serviceRollup.dealCount) : "0"}
          badge={{ text: serviceRollup ? formatCurrency(serviceRollup.totalValue) : "$0", color: "green" }}
          icon={<DollarSign />}
          loading={loading}
        />
        <KpiCard
          label="Companies"
          value={String(companyCount)}
          badge={{ text: "Multi-property rollups", color: "gray" }}
          icon={<Building2 />}
          loading={loading}
        />
        <KpiCard
          label="Stale Leads"
          value={String(staleLeadCount)}
          badge={{ text: "Pre-RFP", color: staleLeadCount > 0 ? "red" : "green" }}
          icon={<Clock3 />}
          loading={loading}
        />
        <KpiCard
          label="Stale Deals"
          value={String(staleDealCount)}
          badge={{ text: "Active pipeline", color: staleDealCount > 0 ? "red" : "green" }}
          icon={<Activity />}
          loading={loading}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <WorkflowTableSection
          title="Lead Pipeline Summary"
          subtitle="Pre-RFP intake counts split by workflow family and validation state."
          rows={data?.leadPipelineSummary ?? []}
          emptyMessage="No lead pipeline data available."
          columns={[
            { key: "route", label: "Workflow", render: (row) => formatWorkflowRoute(row.workflowRoute) },
            { key: "status", label: "Status", render: (row) => formatWorkflowStatus(row.validationStatus) },
            { key: "count", label: "Intakes", align: "right", render: (row) => row.intakeCount.toLocaleString() },
          ]}
        />

        <WorkflowTableSection
          title="Standard vs Service Rollups"
          subtitle="Current active pipeline by workflow route without collapsing the two families."
          rows={data?.standardVsServiceRollups ?? []}
          emptyMessage="No workflow rollups available."
          columns={[
            { key: "route", label: "Workflow", render: (row) => formatWorkflowRoute(row.workflowRoute) },
            { key: "dealCount", label: "Active Deals", align: "right", render: (row) => row.dealCount.toLocaleString() },
            { key: "value", label: "Total Value", align: "right", render: (row) => formatCurrency(row.totalValue) },
            { key: "stale", label: "Stale", align: "right", render: (row) => row.staleDealCount.toLocaleString() },
          ]}
        />
      </div>

      <WorkflowTableSection
        title="Company Rollups"
        subtitle="Companies grouped across multiple properties, leads, and deals."
        rows={data?.companyRollups ?? []}
        emptyMessage="No company rollups available."
        columns={[
          { key: "company", label: "Company", render: (row) => row.companyName },
          { key: "leads", label: "Leads", align: "right", render: (row) => row.leadCount.toLocaleString() },
          { key: "properties", label: "Properties", align: "right", render: (row) => row.propertyCount.toLocaleString() },
          { key: "deals", label: "Deals", align: "right", render: (row) => row.dealCount.toLocaleString() },
          { key: "active", label: "Active", align: "right", render: (row) => row.activeDealCount.toLocaleString() },
          { key: "standard", label: "Standard", align: "right", render: (row) => row.standardDealCount.toLocaleString() },
          { key: "service", label: "Service", align: "right", render: (row) => row.serviceDealCount.toLocaleString() },
          { key: "value", label: "Value", align: "right", render: (row) => formatCurrency(row.totalValue) },
        ]}
      />

      <WorkflowTableSection
        title="Rep Activity Split"
        subtitle="Work captured before activation versus work done on activated deals."
        rows={data?.repActivitySplit ?? []}
        emptyMessage="No rep activity split available."
        columns={[
          { key: "rep", label: "Rep", render: (row) => row.repName },
          { key: "leadCalls", label: "Lead Calls", align: "right", render: (row) => row.leadStageCalls.toLocaleString() },
          { key: "leadEmails", label: "Lead Emails", align: "right", render: (row) => row.leadStageEmails.toLocaleString() },
          { key: "dealCalls", label: "Deal Calls", align: "right", render: (row) => row.dealStageCalls.toLocaleString() },
          { key: "dealEmails", label: "Deal Emails", align: "right", render: (row) => row.dealStageEmails.toLocaleString() },
          { key: "leadTotal", label: "Lead Work", align: "right", render: (row) => row.totalLeadStageActivities.toLocaleString() },
          { key: "dealTotal", label: "Deal Work", align: "right", render: (row) => row.totalDealStageActivities.toLocaleString() },
        ]}
      />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <WorkflowTableSection
          title="Stale Leads"
          subtitle="Pre-RFP intakes that have sat in draft or ready too long."
          rows={data?.staleLeads ?? []}
          emptyMessage="No stale leads found."
          columns={[
            { key: "lead", label: "Lead", render: (row) => row.leadName },
            { key: "company", label: "Company", render: (row) => row.companyName },
            { key: "workflow", label: "Workflow", render: (row) => formatWorkflowRoute(row.workflowRoute) },
            { key: "status", label: "Status", render: (row) => formatWorkflowStatus(row.validationStatus) },
            { key: "age", label: "Age", align: "right", render: (row) => `${row.ageInDays}d` },
          ]}
        />

        <WorkflowTableSection
          title="Stale Deals"
          subtitle="Active deals that have exceeded their stage threshold."
          rows={data?.staleDeals ?? []}
          emptyMessage="No stale deals found."
          columns={[
            { key: "deal", label: "Deal", render: (row) => row.dealName },
            { key: "number", label: "Number", render: (row) => row.dealNumber },
            { key: "workflow", label: "Workflow", render: (row) => formatWorkflowRoute(row.workflowRoute) },
            { key: "rep", label: "Rep", render: (row) => row.repName },
            { key: "age", label: "Age", align: "right", render: (row) => `${row.daysInStage}d` },
            { key: "value", label: "Value", align: "right", render: (row) => formatCurrency(row.dealValue) },
          ]}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function ReportsPage() {
  // --- preserved report hooks ---
  const { user } = useAuth();
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

  // --- unified workflow overview ---
  const {
    data: workflowOverview,
    loading: workflowOverviewLoading,
    error: workflowOverviewError,
    refetch: refetchWorkflowOverview,
  } = useUnifiedWorkflowOverview();
  const canViewDataMining = canViewDataMiningSection(user?.role);
  const {
    data: dataMiningOverview,
    loading: dataMiningLoading,
    error: dataMiningError,
  } = useDataMiningOverview({}, { enabled: canViewDataMining });
  const canViewRegionalOwnership = user?.role !== "rep";
  const regionalOfficeId = user?.activeOfficeId ?? user?.officeId;
  const {
    data: regionalOwnership,
    loading: regionalOwnershipLoading,
    error: regionalOwnershipError,
  } = useRegionalOwnershipOverview(
    {
      officeId: regionalOfficeId,
    },
    canViewRegionalOwnership
  );

  // --- UI state ---
  const [showReportDrawer, setShowReportDrawer] = useState(false);

  const lockedReports = reports.filter((r) => r.isLocked);
  const customReports = reports.filter((r) => !r.isLocked);

  const availableFields = useMemo(() => ENTITY_FIELDS[builderEntity], [builderEntity]);

  const builderPreviewConfig = useMemo(
    () => buildConfig(builderEntity, builderColumns, builderFilters, builderSortField, builderSortDir, builderChartType),
    [builderEntity, builderColumns, builderFilters, builderSortField, builderSortDir, builderChartType]
  );

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
    setShowReportDrawer(true);

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
  const activeReportType = (activeReport?.config as any)?.reportType ?? "";
  const isWorkflowOverviewReport = activeReportType === "workflow_overview";
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

  const now = new Date();
  const syncTime = `${now.toLocaleDateString("en-US", { month: "short", day: "numeric" })} at ${now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;

  function requireExportableRows() {
    if (reportLoading) {
      throw new Error("Wait for the report to finish loading before exporting.");
    }
    if (isWorkflowOverviewReport) {
      throw new Error("Workflow overview reports are structured dashboards and do not export as rows.");
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
        <div className="flex items-start justify-between gap-6">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#CC0000] mb-2">
              Unified Workflow Intelligence
            </p>
            <h1 className="text-6xl font-black tracking-tighter text-slate-900 leading-none mb-4">
              Reports
            </h1>
            <p className="text-slate-500 text-sm max-w-md leading-relaxed">
              Lead pipeline, standard deal, and service deal performance in one consolidated operating view.
            </p>
          </div>
          <div className="flex items-center gap-3 pt-2 shrink-0">
            <Button
              variant="outline"
              className="border-slate-200 text-slate-600 hover:bg-slate-100"
              onClick={() => refetchWorkflowOverview()}
              disabled={workflowOverviewLoading}
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh Overview
            </Button>
          </div>
        </div>

        {workflowOverviewError && (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
            {workflowOverviewError}
          </div>
        )}

        <div className="rounded-3xl border border-slate-200 bg-white shadow-sm p-6">
          <WorkflowOverviewPanel data={workflowOverview} loading={workflowOverviewLoading} />
        </div>

        {user?.role !== "rep" && <ForecastVarianceSection />}

        {user?.role === "director" && <SourcePerformanceSection />}

        {canViewDataMining && (
          <div className="rounded-3xl border border-slate-200 bg-white shadow-sm p-6">
            <DataMiningSection
              data={dataMiningOverview}
              loading={dataMiningLoading}
              error={dataMiningError}
            />
          </div>
        )}

        {canViewRegionalOwnership && (
          <div className="rounded-3xl border border-slate-200 bg-white shadow-sm p-6">
            <RegionalOwnershipSection
              data={regionalOwnership}
              loading={regionalOwnershipLoading}
              error={regionalOwnershipError}
            />
          </div>
        )}

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
                  disabled={reportLoading || exportRows.length === 0 || exporting === "csv" || isWorkflowOverviewReport}
                >
                  <Download className="h-4 w-4 mr-1" />
                  {exporting === "csv" ? "Preparing CSV..." : "Export CSV"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-slate-200 text-slate-600"
                  onClick={handleExportPdf}
                  disabled={reportLoading || exportRows.length === 0 || exporting === "pdf" || isWorkflowOverviewReport}
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
                isWorkflowOverviewReport ? (
                  <WorkflowOverviewPanel data={reportData as UnifiedWorkflowOverview} />
                ) : (
                  <ReportChart
                    data={reportData}
                    chartType={
                      activeReport
                        ? ((activeReport.config as any)?.chart_type ?? "table")
                        : builderChartType
                    }
                    reportType={activeReport ? (activeReport.config as any)?.reportType : undefined}
                  />
                )
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
