import { PipelineBarChart } from "./pipeline-bar-chart";
import { PipelinePieChart } from "./pipeline-pie-chart";
import { ActivityBarChart } from "./activity-bar-chart";
import { formatCurrency } from "./chart-colors";

interface ReportChartProps {
  data: any;
  chartType: string;
  reportType?: string;
}

/**
 * Dynamic chart renderer for report results.
 * For locked reports (with reportType), maps to the appropriate chart component.
 * For custom reports, renders a generic table or chart based on chart_type.
 */
export function ReportChart({ data, chartType, reportType }: ReportChartProps) {
  if (!data) return null;

  // Locked report type-specific rendering
  if (reportType) {
    return <LockedReportView data={data} reportType={reportType} />;
  }

  // Custom report rendering
  if (chartType === "table" || !Array.isArray(data)) {
    return <GenericTable data={Array.isArray(data) ? data : [data]} />;
  }

  if (chartType === "bar" && data.length > 0) {
    const firstRow = data[0];
    const numericKeys = Object.keys(firstRow).filter(
      (k) => typeof firstRow[k] === "number"
    );
    const labelKey = Object.keys(firstRow).find(
      (k) => typeof firstRow[k] === "string"
    );

    if (labelKey && numericKeys.length > 0) {
      const chartData = data.map((row: any) => ({
        stageName: row[labelKey],
        stageColor: null,
        dealCount: row[numericKeys[0]] ?? 0,
        totalValue: row[numericKeys[0]] ?? 0,
      }));
      return <PipelineBarChart data={chartData} valueKey="totalValue" />;
    }
  }

  if (chartType === "pie" && data.length > 0) {
    const firstRow = data[0];
    const numericKey = Object.keys(firstRow).find((k) => typeof firstRow[k] === "number");
    const labelKey = Object.keys(firstRow).find((k) => typeof firstRow[k] === "string");

    if (labelKey && numericKey) {
      const pieData = data.map((row: any) => ({
        name: row[labelKey],
        value: row[numericKey],
      }));
      return <PipelinePieChart data={pieData} />;
    }
  }

  // Fallback to table
  return <GenericTable data={data} />;
}

function LockedReportView({ data, reportType }: { data: any; reportType: string }) {
  if (!data) return null;

  switch (reportType) {
    case "pipeline_summary":
      return <PipelineBarChart data={Array.isArray(data) ? data : []} />;

    case "weighted_forecast":
      if (Array.isArray(data)) {
        const chartData = data.map((d: any) => ({
          stageName: d.month,
          stageColor: null,
          dealCount: d.dealCount,
          totalValue: d.weightedValue,
        }));
        return <PipelineBarChart data={chartData} />;
      }
      return <GenericTable data={Array.isArray(data) ? data : [data]} />;

    case "win_loss_ratio":
      return <GenericTable data={Array.isArray(data) ? data : [data]} />;

    case "activity_summary":
      if (Array.isArray(data)) {
        return <ActivityBarChart data={data} />;
      }
      return <GenericTable data={[data]} />;

    case "stale_deals":
      return <GenericTable data={Array.isArray(data) ? data : [data]} />;

    case "lost_by_reason":
      if (Array.isArray(data)) {
        const pieData = data.map((d: any) => ({
          name: d.reasonLabel,
          value: d.count,
        }));
        return <PipelinePieChart data={pieData} />;
      }
      return <GenericTable data={[data]} />;

    case "revenue_by_project_type":
      if (Array.isArray(data)) {
        const pieData = data.map((d: any) => ({
          name: d.projectTypeName,
          value: d.totalRevenue,
        }));
        return <PipelinePieChart data={pieData} />;
      }
      return <GenericTable data={[data]} />;

    case "lead_source_roi":
      return <GenericTable data={Array.isArray(data) ? data : [data]} />;

    default:
      return <GenericTable data={Array.isArray(data) ? data : [data]} />;
  }
}

function GenericTable({ data }: { data: Record<string, any>[] }) {
  if (data.length === 0) {
    return <p className="text-muted-foreground text-center py-8">No data.</p>;
  }

  const columns = Object.keys(data[0]);

  /** Format column header from snake_case/camelCase to Title Case */
  function formatHeader(key: string): string {
    return key
      .replace(/([A-Z])/g, " $1")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  /** Format cell value based on content */
  function formatCell(value: any, key: string): string {
    if (value == null) return "--";
    if (typeof value === "number") {
      if (key.toLowerCase().includes("value") || key.toLowerCase().includes("revenue") || key.toLowerCase().includes("amount")) {
        return formatCurrency(value);
      }
      if (key.toLowerCase().includes("rate")) {
        return `${value}%`;
      }
      return String(value);
    }
    if (Array.isArray(value)) return `${value.length} items`;
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b">
            {columns.map((col) => (
              <th key={col} className="text-left p-2 font-medium text-muted-foreground">
                {formatHeader(col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i} className="border-b last:border-b-0 hover:bg-slate-50">
              {columns.map((col) => (
                <td key={col} className="p-2">
                  {formatCell(row[col], col)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
