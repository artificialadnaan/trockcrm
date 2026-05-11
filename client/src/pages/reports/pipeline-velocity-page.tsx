import { Link } from "react-router-dom";
import { usePipelineVelocityReport } from "@/hooks/use-reports";
import { useReportFilters } from "@/components/reports/report-filter-bar";
import {
  CountBarChart,
  DataTable,
  formatCurrency,
  formatInteger,
  KpiCard,
  KpiStrip,
  Panel,
  ReportShell,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ValueBarChart,
} from "./sales-report-ui";

export function PipelineVelocityPage() {
  const { query } = useReportFilters();
  const { data, loading, error, refetch } = usePipelineVelocityReport(query);
  const hasRows = Boolean(data && (data.kpis.openDealCount > 0 || data.stages.length > 0 || data.stuckDeals.length > 0));

  return (
    <ReportShell
      eyebrow="Sales Reports"
      title="Pipeline Velocity"
      description="Stage movement, aging, and value trends across the active sales pipeline."
      loading={loading}
      error={error}
      hasData={hasRows}
      emptyText="No deals match this filter."
      onRefresh={() => void refetch()}
    >
      {data ? (
        <div className="space-y-6">
          <KpiStrip>
            <KpiCard label="Avg Deal Age" value={`${formatInteger(data.kpis.avgDealAgeDays)} days`} helper="Open pipeline" />
            <KpiCard label="Total Open Value" value={formatCurrency(data.kpis.totalOpenValue)} helper="Active opportunities" />
            <KpiCard label="Open Deal Count" value={formatInteger(data.kpis.openDealCount)} helper="Non-terminal stages" />
            <KpiCard label="Stuck Deals" value={formatInteger(data.kpis.stuckDealCount)} helper="30+ days in stage" />
          </KpiStrip>

          <div className="grid gap-6 xl:grid-cols-2">
            <Panel title="Open Deal Value by Stage" description="Booked potential in each active stage.">
              <ValueBarChart data={data.stages.map((row) => ({ stageName: row.stageName, totalValue: row.totalValue }))} xKey="stageName" yKey="totalValue" name="Open value" />
            </Panel>
            <Panel title="Aging Breakdown" description="Deal count grouped by time in current stage.">
              <CountBarChart data={data.agingBuckets.map((row) => ({ label: row.label, dealCount: row.dealCount }))} xKey="label" yKey="dealCount" name="Deals" />
            </Panel>
          </div>

          <Panel title="Stage-by-Stage Breakdown">
            <DataTable>
              <TableHeader>
                <TableRow>
                  <TableHead>Stage Name</TableHead>
                  <TableHead className="text-right">Open Deals</TableHead>
                  <TableHead className="text-right">Total Value</TableHead>
                  <TableHead className="text-right">Avg Days</TableHead>
                  <TableHead className="text-right">Median Days</TableHead>
                  <TableHead>Oldest Deal</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.stages.map((stage) => (
                  <TableRow key={stage.stageId}>
                    <TableCell className="font-semibold text-slate-950">{stage.stageName}</TableCell>
                    <TableCell className="text-right tabular-nums">{stage.openDeals}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(stage.totalValue)}</TableCell>
                    <TableCell className="text-right tabular-nums">{stage.avgDaysInStage}</TableCell>
                    <TableCell className="text-right tabular-nums">{stage.medianDaysInStage}</TableCell>
                    <TableCell>
                      {stage.oldestDeal.dealId ? (
                        <Link to={`/deals/${stage.oldestDeal.dealId}`} className="font-semibold text-brand-red hover:underline">
                          {stage.oldestDeal.dealName} ({stage.oldestDeal.daysInStage}d)
                        </Link>
                      ) : "None"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </DataTable>
          </Panel>

          <Panel title="Top 10 Stuck Deals" description="Deals that have spent more than 30 days in the same stage.">
            <DataTable>
              <TableHeader>
                <TableRow>
                  <TableHead>Deal</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead className="text-right">Days in Stage</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.stuckDeals.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center text-slate-500">No stuck deals match this filter.</TableCell></TableRow>
                ) : data.stuckDeals.map((deal) => (
                  <TableRow key={deal.dealId}>
                    <TableCell>
                      <Link to={`/deals/${deal.dealId}`} className="font-semibold text-brand-red hover:underline">{deal.dealName}</Link>
                    </TableCell>
                    <TableCell>{deal.ownerName}</TableCell>
                    <TableCell>{deal.stageName}</TableCell>
                    <TableCell className="text-right tabular-nums">{deal.daysInStage}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(deal.value)}</TableCell>
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
