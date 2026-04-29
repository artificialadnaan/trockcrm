import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createSavedReport, runReportBuilder, type ReportBuilderDimension, type ReportBuilderMeasure, type ReportBuilderRequest, type ReportBuilderResult, type SavedReport } from "@/hooks/use-reports";
import { downloadTextFile, serializeRowsToCsv } from "@/lib/report-export";
import { useAuth } from "@/lib/auth";
import { getChartColor } from "@/components/charts/chart-colors";

const DIMENSIONS: Array<{ key: ReportBuilderDimension; label: string }> = [
  { key: "stage", label: "Stage" },
  { key: "rep", label: "Rep" },
  { key: "region", label: "Region" },
  { key: "source", label: "Source" },
  { key: "deal_type", label: "Deal Type" },
  { key: "month", label: "Month" },
  { key: "week", label: "Week" },
  { key: "age_in_stage_bucket", label: "Age-in-Stage Bucket" },
];

const MEASURES: Array<{ key: ReportBuilderMeasure; label: string }> = [
  { key: "deal_count", label: "Deal Count" },
  { key: "total_value", label: "Total Value" },
  { key: "avg_value", label: "Avg Value" },
  { key: "win_rate", label: "Win Rate" },
  { key: "avg_cycle_time", label: "Avg Cycle Time" },
  { key: "avg_age_in_stage", label: "Avg Age in Stage" },
];

const QUICK_REPORTS: Array<{ id: string; name: string; request: ReportBuilderRequest }> = [
  {
    id: "mtd-pipeline",
    name: "MTD Pipeline",
    request: {
      dimensions: ["stage", "rep"],
      measures: ["deal_count", "total_value", "avg_value"],
      filters: { from: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10) },
      dateField: "created_at",
    },
  },
  {
    id: "ytd-closed-won",
    name: "YTD Closed Won",
    request: {
      dimensions: ["month", "rep"],
      measures: ["deal_count", "total_value", "win_rate", "avg_cycle_time"],
      filters: { from: `${new Date().getFullYear()}-01-01`, stage: ["sent_to_production", "service_sent_to_production", "closed_won"] },
      dateField: "actual_close_date",
    },
  },
  {
    id: "this-week-activity",
    name: "This Week's Activity",
    request: {
      dimensions: ["week", "rep"],
      measures: ["deal_count", "avg_age_in_stage"],
      filters: { from: new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10) },
      dateField: "updated_at",
    },
  },
];

function toggle<T extends string>(items: T[], item: T) {
  return items.includes(item) ? items.filter((value) => value !== item) : [...items, item];
}

function defaultRequest(): ReportBuilderRequest {
  return {
    dimensions: ["stage", "rep"],
    measures: ["deal_count", "total_value", "avg_value"],
    filters: {},
    dateField: "created_at",
  };
}

function formatCell(value: unknown) {
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);
  if (value == null) return "";
  return String(value);
}

interface ReportBuilderProps {
  savedReports: SavedReport[];
  onSaved?: () => void;
}

export function ReportBuilder({ savedReports, onSaved }: ReportBuilderProps) {
  const { user } = useAuth();
  const [request, setRequest] = useState<ReportBuilderRequest>(() => defaultRequest());
  const [activeViewId, setActiveViewId] = useState(QUICK_REPORTS[0].id);
  const [mode, setMode] = useState<"table" | "chart">("table");
  const [result, setResult] = useState<ReportBuilderResult>({ columns: [], rows: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveName, setSaveName] = useState("");
  const [saveOrgWide, setSaveOrgWide] = useState(false);

  const allViews = useMemo(() => [
    ...QUICK_REPORTS.map((view) => ({ id: view.id, name: view.name, request: view.request })),
    ...savedReports
      .filter((report) => (report.config as any)?.builderRequest)
      .map((report) => ({ id: report.id, name: report.name, request: (report.config as any).builderRequest as ReportBuilderRequest })),
  ], [savedReports]);

  useEffect(() => {
    const view = allViews.find((item) => item.id === activeViewId);
    if (view) setRequest(view.request);
  }, [activeViewId, allViews]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    runReportBuilder(request)
      .then((response) => {
        if (alive) setResult(response.data);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : "Failed to run report");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [request]);

  const firstDimension = request.dimensions[0] ?? "stage";
  const firstMeasure = request.measures[0] ?? "deal_count";

  async function saveCurrentView() {
    if (!saveName.trim()) return;
    await createSavedReport({
      name: saveName.trim(),
      entity: "deals",
      config: { entity: "deals", filters: [], columns: [], builderRequest: request } as any,
      visibility: saveOrgWide && user?.role === "admin" ? "company" : "private",
    });
    setSaveName("");
    setSaveOrgWide(false);
    onSaved?.();
  }

  function exportCsv() {
    downloadTextFile(
      serializeRowsToCsv(result.rows),
      `report-${new Date().toISOString().slice(0, 10)}.csv`,
      "text/csv;charset=utf-8"
    );
  }

  return (
    <div className="grid min-h-[680px] gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="space-y-5 border-r border-slate-200 pr-4">
        <div className="space-y-2">
          <label className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Saved Views</label>
          <select
            value={activeViewId}
            onChange={(event) => setActiveViewId(event.target.value)}
            className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
          >
            {allViews.map((view) => (
              <option key={view.id} value={view.id}>{view.name}</option>
            ))}
          </select>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Dimensions</p>
          <div className="mt-2 space-y-2">
            {DIMENSIONS.map((dimension) => (
              <label key={dimension.key} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={request.dimensions.includes(dimension.key)}
                  onChange={() => setRequest((current) => ({ ...current, dimensions: toggle(current.dimensions, dimension.key) }))}
                />
                {dimension.label}
              </label>
            ))}
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Measures</p>
          <div className="mt-2 space-y-2">
            {MEASURES.map((measure) => (
              <label key={measure.key} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={request.measures.includes(measure.key)}
                  onChange={() => setRequest((current) => ({ ...current, measures: toggle(current.measures, measure.key) }))}
                />
                {measure.label}
              </label>
            ))}
          </div>
        </div>

        <div className="grid gap-2">
          <label className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Date Field</label>
          <select
            value={request.dateField}
            onChange={(event) => setRequest((current) => ({ ...current, dateField: event.target.value as ReportBuilderRequest["dateField"] }))}
            className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm"
          >
            <option value="created_at">Created</option>
            <option value="updated_at">Updated</option>
            <option value="expected_close_date">Expected Close</option>
            <option value="actual_close_date">Actual Close</option>
            <option value="contract_signed_date">Contract Signed</option>
          </select>
          <Input
            type="date"
            aria-label="From"
            value={typeof request.filters.from === "string" ? request.filters.from : ""}
            onChange={(event) => setRequest((current) => ({ ...current, filters: { ...current.filters, from: event.target.value } }))}
          />
          <Input
            type="date"
            aria-label="To"
            value={typeof request.filters.to === "string" ? request.filters.to : ""}
            onChange={(event) => setRequest((current) => ({ ...current, filters: { ...current.filters, to: event.target.value } }))}
          />
        </div>

        <div className="grid gap-2">
          <Input value={saveName} onChange={(event) => setSaveName(event.target.value)} placeholder="Save view name" />
          {user?.role === "admin" ? (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={saveOrgWide} onChange={(event) => setSaveOrgWide(event.target.checked)} />
              Save org-wide
            </label>
          ) : null}
          <Button type="button" onClick={saveCurrentView} disabled={!saveName.trim()}>
            Save View
          </Button>
        </div>
      </aside>

      <section className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">Report Builder</h2>
            <p className="text-sm text-slate-500">Quick Reports use the same builder request model as saved views.</p>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant={mode === "table" ? "default" : "outline"} onClick={() => setMode("table")}>Table</Button>
            <Button type="button" variant={mode === "chart" ? "default" : "outline"} onClick={() => setMode("chart")}>Chart</Button>
            <Button type="button" variant="outline" onClick={exportCsv}>CSV Export</Button>
          </div>
        </div>

        {error ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}

        {mode === "chart" ? (
          <div className="h-[420px] rounded-lg border border-slate-200 bg-white p-4">
            <ResponsiveContainer width="100%" height="100%">
              {firstMeasure === "deal_count" ? (
                <BarChart data={result.rows}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey={firstDimension} />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey={firstMeasure} fill={getChartColor(0)} />
                </BarChart>
              ) : (
                <LineChart data={result.rows}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey={firstDimension} />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey={firstMeasure} stroke={getChartColor(2)} strokeWidth={2} />
                </LineChart>
              )}
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-[0.12em] text-slate-500">
                <tr>
                  {result.columns.map((column) => (
                    <th key={column.key} className="px-3 py-2">{column.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <tr><td className="px-3 py-4 text-slate-500" colSpan={Math.max(result.columns.length, 1)}>Loading report...</td></tr>
                ) : result.rows.length === 0 ? (
                  <tr><td className="px-3 py-4 text-slate-500" colSpan={Math.max(result.columns.length, 1)}>No rows returned.</td></tr>
                ) : (
                  result.rows.map((row, index) => (
                    <tr key={index}>
                      {result.columns.map((column) => (
                        <td key={column.key} className="px-3 py-3 text-slate-700">{formatCell(row[column.key])}</td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
