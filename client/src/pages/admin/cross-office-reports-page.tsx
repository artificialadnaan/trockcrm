import { useState, useEffect } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { api } from "@/lib/api";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface OfficePipelineRow {
  officeId: string;
  officeName: string;
  officeSlug: string;
  totalDeals: number;
  activeDeals: number;
  totalPipelineValue: number;
  totalAwardedValue: number;
}

interface OfficeActivityRow {
  officeId: string;
  officeName: string;
  officeSlug: string;
  totalActivities: number;
  activitiesLast30Days: number;
  callCount: number;
  emailCount: number;
  meetingCount: number;
}

function formatCurrency(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

export function CrossOfficeReportsPage() {
  const [pipeline, setPipeline] = useState<OfficePipelineRow[]>([]);
  const [activity, setActivity] = useState<OfficeActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      api<{ offices: OfficePipelineRow[] }>("/admin/reports/cross-office-pipeline"),
      api<{ offices: OfficeActivityRow[] }>("/admin/reports/cross-office-activity"),
    ])
      .then(([pipelineData, activityData]) => {
        if (!cancelled) {
          setPipeline(pipelineData.offices);
          setActivity(activityData.offices);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load reports");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  const pipelineChartData = pipeline.map((o) => ({
    name: o.officeName,
    "Pipeline Value": o.totalPipelineValue,
    "Awarded Value": o.totalAwardedValue,
  }));

  const activityChartData = activity.map((o) => ({
    name: o.officeName,
    "Last 30 Days": o.activitiesLast30Days,
    Calls: o.callCount,
    Emails: o.emailCount,
    Meetings: o.meetingCount,
  }));

  return (
    <div className="p-6 space-y-8 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Cross-Office Reports</h1>
        <p className="text-sm text-gray-500 mt-1">Pipeline and activity metrics across all accessible offices</p>
      </div>

      {error && (
        <div className="p-4 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>
      )}

      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />
          ))}
        </div>
      ) : (
        <>
          {/* Pipeline Section */}
          <section className="space-y-4">
            <h2 className="text-lg font-medium text-gray-800">Pipeline by Office</h2>

            <div className="rounded-lg border bg-white p-4">
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={pipelineChartData} margin={{ top: 8, right: 16, left: 16, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tickFormatter={formatCurrency} tick={{ fontSize: 12 }} />
                  <Tooltip
                    formatter={(value: number) => formatCurrency(value)}
                    contentStyle={{ fontSize: 12 }}
                  />
                  <Legend />
                  <Bar dataKey="Pipeline Value" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="Awarded Value" fill="#10b981" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="overflow-x-auto rounded-lg border bg-white">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Office</TableHead>
                    <TableHead className="text-right">Total Deals</TableHead>
                    <TableHead className="text-right">Active Deals</TableHead>
                    <TableHead className="text-right">Pipeline Value</TableHead>
                    <TableHead className="text-right">Awarded Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pipeline.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-gray-400 py-8">
                        No offices accessible
                      </TableCell>
                    </TableRow>
                  ) : (
                    pipeline.map((row) => (
                      <TableRow key={row.officeId}>
                        <TableCell className="font-medium">{row.officeName}</TableCell>
                        <TableCell className="text-right">{row.totalDeals.toLocaleString()}</TableCell>
                        <TableCell className="text-right">{row.activeDeals.toLocaleString()}</TableCell>
                        <TableCell className="text-right">{formatCurrency(row.totalPipelineValue)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(row.totalAwardedValue)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </section>

          {/* Activity Section */}
          <section className="space-y-4">
            <h2 className="text-lg font-medium text-gray-800">Activity by Office</h2>

            <div className="rounded-lg border bg-white p-4">
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={activityChartData} margin={{ top: 8, right: 16, left: 16, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Legend />
                  <Bar dataKey="Calls" fill="#8b5cf6" radius={[3, 3, 0, 0]} stackId="activity" />
                  <Bar dataKey="Emails" fill="#f59e0b" radius={[3, 3, 0, 0]} stackId="activity" />
                  <Bar dataKey="Meetings" fill="#ec4899" radius={[3, 3, 0, 0]} stackId="activity" />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="overflow-x-auto rounded-lg border bg-white">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Office</TableHead>
                    <TableHead className="text-right">Total Activities</TableHead>
                    <TableHead className="text-right">Last 30 Days</TableHead>
                    <TableHead className="text-right">Calls</TableHead>
                    <TableHead className="text-right">Emails</TableHead>
                    <TableHead className="text-right">Meetings</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activity.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-gray-400 py-8">
                        No offices accessible
                      </TableCell>
                    </TableRow>
                  ) : (
                    activity.map((row) => (
                      <TableRow key={row.officeId}>
                        <TableCell className="font-medium">{row.officeName}</TableCell>
                        <TableCell className="text-right">{row.totalActivities.toLocaleString()}</TableCell>
                        <TableCell className="text-right">{row.activitiesLast30Days.toLocaleString()}</TableCell>
                        <TableCell className="text-right">{row.callCount.toLocaleString()}</TableCell>
                        <TableCell className="text-right">{row.emailCount.toLocaleString()}</TableCell>
                        <TableCell className="text-right">{row.meetingCount.toLocaleString()}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
