import { Link } from "react-router-dom";
import { useClosedWonRevenueReport } from "@/hooks/use-reports";
import { useReportFilters } from "@/components/reports/report-filter-bar";
import {
  DataTable,
  formatCurrency,
  formatDate,
  formatInteger,
  formatPercent,
  KpiCard,
  KpiStrip,
  Panel,
  ReportShell,
  sheetsFromReport,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TrendChart,
  ValueBarChart,
} from "./sales-report-ui";

export function ClosedWonRevenuePage() {
  const { query } = useReportFilters();
  const { data, loading, error, refetch } = useClosedWonRevenueReport(query);
  const hasRows = Boolean(data && (data.kpis.wonDealCount > 0 || data.topDeals.length > 0 || data.byOwner.length > 0));

  return (
    <ReportShell
      eyebrow="Sales Reports"
      title="Closed Won Revenue"
      description="Booked revenue by rep, region, workflow family, and period."
      loading={loading}
      error={error}
      hasData={hasRows}
      emptyText="No won deals match this filter."
      onRefresh={() => void refetch()}
      exportFilename="closed-won-revenue-report"
      exportSheets={sheetsFromReport("Closed Won Revenue", data)}
    >
      {data ? (
        <div className="space-y-6">
          <KpiStrip>
            <KpiCard label="Total Booked Revenue" value={formatCurrency(data.kpis.totalBookedRevenue)} helper="Won deal value" />
            <KpiCard label="Won Deal Count" value={formatInteger(data.kpis.wonDealCount)} helper="Closed won" />
            <KpiCard label="Avg Deal Size" value={formatCurrency(data.kpis.avgDealSize)} helper="Revenue per win" />
            <KpiCard label="Win Rate" value={formatPercent(data.kpis.winRate)} helper="Won / won + lost" />
          </KpiStrip>

          <div className="grid gap-6 xl:grid-cols-2">
            <Panel title="Monthly Booked Revenue" description="Booked revenue trend by month.">
              <TrendChart data={data.monthlyRevenue.map((row) => ({ label: row.label, revenue: row.totalRevenue }))} xKey="label" barKey="revenue" barName="Revenue" leftFormat="currency" />
            </Panel>
            <Panel title="Revenue by Region" description="Top 15 regions by booked revenue; the rest roll into Other. Full list in the table below.">
              <ValueBarChart data={data.byRegion.map((row) => ({ regionName: row.regionName, totalRevenue: row.totalRevenue }))} xKey="regionName" yKey="totalRevenue" name="Revenue" topN={15} />
            </Panel>
          </div>

          <Panel title="By Owner">
            <DataTable>
              <TableHeader>
                <TableRow>
                  <TableHead>Owner Name</TableHead>
                  <TableHead className="text-right">Won Deals</TableHead>
                  <TableHead className="text-right">Total Revenue</TableHead>
                  <TableHead className="text-right">Avg Deal Size</TableHead>
                  <TableHead>Largest Won Deal</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byOwner.map((owner) => (
                  <TableRow key={owner.ownerId}>
                    <TableCell className="font-semibold text-slate-950">{owner.ownerName}</TableCell>
                    <TableCell className="text-right tabular-nums">{owner.wonDeals}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(owner.totalRevenue)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(owner.avgDealSize)}</TableCell>
                    <TableCell>
                      {owner.largestWonDeal.dealId ? (
                        <Link to={`/deals/${owner.largestWonDeal.dealId}`} className="font-semibold text-brand-red hover:underline">
                          {owner.largestWonDeal.dealName} ({formatCurrency(owner.largestWonDeal.value)})
                        </Link>
                      ) : "None"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </DataTable>
          </Panel>

          <div className="grid gap-6 xl:grid-cols-2">
            <Panel title="By Region">
              <DataTable>
                <TableHeader>
                  <TableRow>
                    <TableHead>Region</TableHead>
                    <TableHead className="text-right">Won Deals</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                    <TableHead className="text-right">% of Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.byRegion.map((region) => (
                    <TableRow key={region.regionName}>
                      <TableCell className="font-semibold text-slate-950">{region.regionName}</TableCell>
                      <TableCell className="text-right">{region.wonDeals}</TableCell>
                      <TableCell className="text-right">{formatCurrency(region.totalRevenue)}</TableCell>
                      <TableCell className="text-right">{formatPercent(region.percentOfTotal)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </DataTable>
            </Panel>
            <Panel title="By Workflow Family">
              <DataTable>
                <TableHeader>
                  <TableRow>
                    <TableHead>Workflow Family</TableHead>
                    <TableHead className="text-right">Won Deals</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.byWorkflowFamily.map((row) => (
                    <TableRow key={row.workflowFamily}>
                      <TableCell className="font-semibold text-slate-950">{row.workflowFamilyName}</TableCell>
                      <TableCell className="text-right">{row.wonDeals}</TableCell>
                      <TableCell className="text-right">{formatCurrency(row.totalRevenue)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </DataTable>
            </Panel>
          </div>

          <Panel title="Top 10 Won Deals">
            <DataTable>
              <TableHeader>
                <TableRow>
                  <TableHead>Deal</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Won Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.topDeals.map((deal) => (
                  <TableRow key={deal.dealId}>
                    <TableCell><Link to={`/deals/${deal.dealId}`} className="font-semibold text-brand-red hover:underline">{deal.dealName}</Link></TableCell>
                    <TableCell>{deal.ownerName}</TableCell>
                    <TableCell className="text-right">{formatCurrency(deal.value)}</TableCell>
                    <TableCell>{formatDate(deal.wonAt)}</TableCell>
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
