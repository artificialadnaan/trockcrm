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
import { ReportChart } from "@/components/charts/report-chart";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Lock, Plus, Trash2, Save, Play, X } from "lucide-react";

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

export function ReportsPage() {
  const { reports, loading, refetch } = useSavedReports();
  const [activeReport, setActiveReport] = useState<SavedReport | null>(null);
  const [reportData, setReportData] = useState<any>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);
  const [builderError, setBuilderError] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);

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

  const lockedReports = reports.filter((r) => r.isLocked);
  const customReports = reports.filter((r) => !r.isLocked);

  const availableFields = useMemo(() => ENTITY_FIELDS[builderEntity], [builderEntity]);

  const builderPreviewConfig = useMemo(
    () => buildConfig(builderEntity, builderColumns, builderFilters, builderSortField, builderSortDir, builderChartType),
    [builderEntity, builderColumns, builderFilters, builderSortField, builderSortDir, builderChartType]
  );

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
      if (current.includes(column)) {
        return current.filter((value) => value !== column);
      }
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
      current.map((filter) => (filter.id === id ? { ...filter, ...patch } : filter))
    );
  }

  function removeBuilderFilter(id: string) {
    setBuilderFilters((current) => current.filter((filter) => filter.id !== id));
  }

  async function runReport(report: SavedReport) {
    setActiveReport(report);
    setReportData(null);
    setReportLoading(true);
    setReportError(null);

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Reports</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Locked company reports plus configurable custom views with saved filters.
          </p>
        </div>
        <Button
          onClick={() => {
            resetBuilder();
            setShowBuilder(true);
          }}
          size="sm"
        >
          <Plus className="h-4 w-4 mr-1" />
          New Report
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-4">
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Lock className="h-3.5 w-3.5" />
                Company Reports
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {lockedReports.map((report) => (
                <button
                  key={report.id}
                  onClick={() => runReport(report)}
                  className={`w-full text-left px-4 py-2.5 text-sm border-b last:border-b-0 hover:bg-slate-50 transition-colors ${
                    activeReport?.id === report.id ? "bg-slate-100 font-medium" : ""
                  }`}
                >
                  {report.name}
                </button>
              ))}
              {lockedReports.length === 0 && !loading && (
                <p className="text-xs text-muted-foreground p-4">
                  No locked reports. Ask an admin to seed them.
                </p>
              )}
            </CardContent>
          </Card>

          {customReports.length > 0 && (
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm">My Reports</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {customReports.map((report) => (
                  <div
                    key={report.id}
                    className={`flex items-center justify-between px-4 py-2.5 border-b last:border-b-0 hover:bg-slate-50 transition-colors ${
                      activeReport?.id === report.id ? "bg-slate-100" : ""
                    }`}
                  >
                    <button
                      onClick={() => runReport(report)}
                      className="text-sm text-left flex-1 truncate"
                    >
                      {report.name}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteReport(report.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="lg:col-span-2 space-y-4">
          {activeReport?.isLocked && activeLockedOptions && (
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm">Report Filters</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-3">
                {activeLockedOptions.supportsDateRange && (
                  <>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">From</label>
                      <Input type="date" value={lockedFrom} onChange={(e) => setLockedFrom(e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">To</label>
                      <Input type="date" value={lockedTo} onChange={(e) => setLockedTo(e.target.value)} />
                    </div>
                  </>
                )}
                {activeLockedOptions.supportsIncludeDd && (
                  <label className="flex items-center gap-2 text-sm pt-6">
                    <input
                      type="checkbox"
                      checked={lockedIncludeDd}
                      onChange={(e) => setLockedIncludeDd(e.target.checked)}
                    />
                    Include DD
                  </label>
                )}
                <div className="md:justify-self-end md:self-end">
                  <Button onClick={() => runReport(activeReport)} size="sm">
                    <Play className="h-4 w-4 mr-1" />
                    Apply
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="flex items-center gap-2">
                  {activeReport ? activeReport.name : "Report Results"}
                  {activeReport?.isLocked && (
                    <Badge variant="secondary" className="text-xs">
                      <Lock className="h-3 w-3 mr-1" />
                      Locked
                    </Badge>
                  )}
                  {!activeReport && reportData && (
                    <Badge variant="outline" className="text-xs">
                      Preview
                    </Badge>
                  )}
                </CardTitle>
                {!activeReport && (
                  <Button variant="outline" size="sm" onClick={runBuilderPreview}>
                    <Play className="h-4 w-4 mr-1" />
                    Run Builder Preview
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {!activeReport && !reportData && !reportLoading && !reportError && (
                <div className="p-12 text-center text-muted-foreground">
                  <BarChartIcon className="h-12 w-12 mx-auto mb-3 opacity-30" />
                  <p>Select a saved report or build a custom one.</p>
                </div>
              )}

              {reportLoading && (
                <div className="p-12 text-center text-muted-foreground">Loading report...</div>
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
            </CardContent>
          </Card>
        </div>
      </div>

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
                  <span className="text-xs text-muted-foreground">
                    {builderColumns.length} selected
                  </span>
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

                        <Select
                          value={filter.op}
                          onValueChange={(value) => updateBuilderFilter(filter.id, { op: value as ReportFilterOp, value: "" })}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {FILTER_OPERATORS.map((op) => (
                              <SelectItem key={op.value} value={op.value}>
                                {op.label}
                              </SelectItem>
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
                          <div className="flex items-center text-sm text-muted-foreground px-3">
                            No value needed
                          </div>
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

function BarChartIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="12" width="4" height="9" rx="1" />
      <rect x="10" y="6" width="4" height="15" rx="1" />
      <rect x="17" y="3" width="4" height="18" rx="1" />
    </svg>
  );
}
