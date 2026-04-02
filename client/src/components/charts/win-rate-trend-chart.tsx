import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { CHART_COLORS, formatPercent } from "./chart-colors";

interface WinRateTrendChartProps {
  data: Array<{
    month: string;
    wins: number;
    losses: number;
    winRate: number;
  }>;
}

export function WinRateTrendChart({ data }: WinRateTrendChartProps) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
        <XAxis
          dataKey="month"
          tick={{ fontSize: 12, fill: "#64748b" }}
          axisLine={{ stroke: "#e2e8f0" }}
        />
        <YAxis
          domain={[0, 100]}
          tick={{ fontSize: 12, fill: "#64748b" }}
          axisLine={{ stroke: "#e2e8f0" }}
          tickFormatter={formatPercent}
        />
        <Tooltip
          formatter={(value: number) => [formatPercent(value), "Win Rate"]}
          contentStyle={{ fontSize: 12, borderRadius: 8 }}
        />
        <ReferenceLine y={50} stroke="#e2e8f0" strokeDasharray="3 3" label="" />
        <Line
          type="monotone"
          dataKey="winRate"
          stroke={CHART_COLORS[0]}
          strokeWidth={2}
          dot={{ fill: CHART_COLORS[0], r: 4 }}
          activeDot={{ r: 6 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
