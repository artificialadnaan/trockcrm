import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { getStageColor, formatCurrency } from "./chart-colors";

interface PipelineBarChartProps {
  data: Array<{
    stageName: string;
    stageColor: string | null;
    dealCount: number;
    totalValue: number;
  }>;
  valueKey?: "totalValue" | "dealCount";
  valueFormatter?: (value: number) => string;
  valueLabel?: string;
}

export function PipelineBarChart({
  data,
  valueKey = "totalValue",
  valueFormatter,
  valueLabel,
}: PipelineBarChartProps) {
  const fmt = valueFormatter ?? (valueKey === "totalValue" ? formatCurrency : (v: number) => String(v));
  const label = valueLabel ?? (valueKey === "totalValue" ? "Value" : "Deals");

  const formatted = data.map((d, i) => ({
    name: d.stageName,
    value: d[valueKey],
    color: getStageColor(d.stageColor, i),
    deals: d.dealCount,
    amount: d.totalValue,
  }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={formatted} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
        <XAxis
          dataKey="name"
          tick={{ fontSize: 12, fill: "#64748b" }}
          axisLine={{ stroke: "#e2e8f0" }}
        />
        <YAxis
          tick={{ fontSize: 12, fill: "#64748b" }}
          axisLine={{ stroke: "#e2e8f0" }}
          tickFormatter={fmt}
        />
        <Tooltip
          formatter={(value: number) => [fmt(value), label]}
          contentStyle={{ fontSize: 12, borderRadius: 8 }}
        />
        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
          {formatted.map((entry, index) => (
            <Cell key={index} fill={entry.color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
