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
import { CHART_COLORS } from "./chart-colors";

interface ActivityBarChartProps {
  data: Array<{
    repName: string;
    calls: number;
    emails: number;
    meetings: number;
    notes: number;
    total: number;
  }>;
}

export function ActivityBarChart({ data }: ActivityBarChartProps) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
        <XAxis
          dataKey="repName"
          tick={{ fontSize: 12, fill: "#64748b" }}
          axisLine={{ stroke: "#e2e8f0" }}
        />
        <YAxis
          tick={{ fontSize: 12, fill: "#64748b" }}
          axisLine={{ stroke: "#e2e8f0" }}
        />
        <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="calls" name="Calls" fill={CHART_COLORS[0]} stackId="a" radius={[0, 0, 0, 0]} />
        <Bar dataKey="emails" name="Emails" fill={CHART_COLORS[1]} stackId="a" radius={[0, 0, 0, 0]} />
        <Bar dataKey="meetings" name="Meetings" fill={CHART_COLORS[2]} stackId="a" radius={[0, 0, 0, 0]} />
        <Bar dataKey="notes" name="Notes" fill={CHART_COLORS[3]} stackId="a" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
