import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { getStageColor, formatCurrency } from "./chart-colors";

interface PipelinePieChartProps {
  data: Array<{
    name: string;
    value: number;
    color?: string;
  }>;
  valueFormatter?: (value: number) => string;
  valueLabel?: string;
}

export function PipelinePieChart({ data, valueFormatter, valueLabel }: PipelinePieChartProps) {
  const chartData = data.map((d, i) => ({
    ...d,
    fill: d.color ?? getStageColor(null, i),
  }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <PieChart>
        <Pie
          data={chartData}
          cx="50%"
          cy="50%"
          outerRadius={100}
          innerRadius={50}
          paddingAngle={2}
          dataKey="value"
          nameKey="name"
          label={({ name, percent }) =>
            `${name} (${(percent * 100).toFixed(0)}%)`
          }
          labelLine={{ strokeWidth: 1 }}
        >
          {chartData.map((entry, index) => (
            <Cell key={index} fill={entry.fill} />
          ))}
        </Pie>
        <Tooltip
          formatter={(value: number) => [
            (valueFormatter ?? formatCurrency)(value),
            valueLabel ?? "Value",
          ]}
          contentStyle={{ fontSize: 12, borderRadius: 8 }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}
