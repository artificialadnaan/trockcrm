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
}

export function PipelineBarChart({ data, valueKey = "totalValue" }: PipelineBarChartProps) {
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
          tickFormatter={(v) => (valueKey === "totalValue" ? formatCurrency(v) : String(v))}
        />
        <Tooltip
          formatter={(value: number) => [
            valueKey === "totalValue" ? formatCurrency(value) : value,
            valueKey === "totalValue" ? "Value" : "Deals",
          ]}
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
