import { useLeadConversionReport } from "@/hooks/use-reports";
import { useReportFilters } from "@/components/reports/report-filter-bar";
import {
  DataTable,
  formatCurrency,
  formatInteger,
  formatPercent,
  KpiCard,
  KpiStrip,
  Panel,
  ReportShell,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TrendChart,
  ValueBarChart,
} from "./sales-report-ui";

export function LeadConversionPage() {
  const { query } = useReportFilters();
  const { data, loading, error, refetch } = useLeadConversionReport(query);
  const hasRows = Boolean(data && (data.kpis.totalLeads > 0 || data.bySource.length > 0 || data.monthlyTrend.length > 0));

  return (
    <ReportShell
      eyebrow="Sales Reports"
      title="Lead Conversion"
      description="Lead source performance from inquiry through booked work."
      loading={loading}
      error={error}
      hasData={hasRows}
      emptyText="No leads match this filter."
      onRefresh={() => void refetch()}
    >
      {data ? (
        <div className="space-y-6">
          <KpiStrip>
            <KpiCard label="Total Leads" value={formatInteger(data.kpis.totalLeads)} helper="Created in range" />
            <KpiCard label="Qualified" value={formatInteger(data.kpis.qualified)} helper="Ready for deal review" />
            <KpiCard label="Lead-to-Deal" value={formatPercent(data.kpis.leadToDealRate)} helper={`${formatInteger(data.kpis.inDeals)} in deals`} />
            <KpiCard label="Deal-to-Won" value={formatPercent(data.kpis.dealToWonRate)} helper={`${formatInteger(data.kpis.won)} won`} />
          </KpiStrip>

          <Panel title="Conversion Funnel" description="Leadership view of lead progression through closed won.">
            <div className="grid gap-3 md:grid-cols-4">
              {data.funnel.map((step, index) => (
                <div key={step.key} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <p className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">{step.label}</p>
                  <p className="mt-2 text-3xl font-black text-slate-950">{formatInteger(step.count)}</p>
                  <p className="mt-1 text-xs font-semibold text-slate-500">
                    {index === 0 ? "Starting volume" : `${formatPercent(step.conversionRate)} from prior step`}
                  </p>
                  <div className="mt-4 h-2 rounded-full bg-white">
                    <div className="h-2 rounded-full bg-brand-red" style={{ width: `${Math.min(100, step.conversionRate)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          <div className="grid gap-6 xl:grid-cols-2">
            <Panel title="Leads Created by Month" description="Volume trend with conversion overlay.">
              <TrendChart data={data.monthlyTrend.map((row) => ({ label: row.label, leads: row.leads, conversionRate: row.conversionRate }))} xKey="label" barKey="leads" barName="Leads" lineKey="conversionRate" lineName="Conversion %" />
            </Panel>
            <Panel title="Top Sources by Converted Revenue">
              <ValueBarChart data={data.topRevenueSources.map((row) => ({ source: row.source, totalRevenue: row.totalRevenue }))} xKey="source" yKey="totalRevenue" name="Revenue" />
            </Panel>
          </div>

          <Panel title="Breakdown by Lead Source">
            <DataTable>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                  <TableHead className="text-right">Qualified</TableHead>
                  <TableHead className="text-right">Converted to Deal</TableHead>
                  <TableHead className="text-right">Won</TableHead>
                  <TableHead className="text-right">Total Revenue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.bySource.map((source) => (
                  <TableRow key={source.source}>
                    <TableCell className="font-semibold text-slate-950">{source.source}</TableCell>
                    <TableCell className="text-right tabular-nums">{source.leads}</TableCell>
                    <TableCell className="text-right tabular-nums">{source.qualified}</TableCell>
                    <TableCell className="text-right tabular-nums">{source.convertedToDeal}</TableCell>
                    <TableCell className="text-right tabular-nums">{source.won}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(source.totalRevenue)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </DataTable>
          </Panel>
        </div>
      ) : null}
    </ReportShell>
  );
}
