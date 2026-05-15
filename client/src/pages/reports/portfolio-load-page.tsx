import { Link } from "react-router-dom";
import { ReportFilterBar, useReportFilters } from "@/components/reports/report-filter-bar";
import { usePortfolioLoadReport } from "@/hooks/use-reports";
import { sheetsFromReport } from "@/lib/excel-export";
import {
  EmptyState,
  ErrorState,
  formatDate,
  formatDays,
  formatNumber,
  formatUsd,
  KpiCard,
  KpiGrid,
  LoadingState,
  OperationsReportShell,
  ReportPanel,
  ScrollTable,
} from "./operations-report-common";

export function PortfolioLoadPage() {
  const { query } = useReportFilters();
  const { data, loading, error } = usePortfolioLoadReport(query);

  return (
    <OperationsReportShell
      title="Portfolio Load"
      description="Active work grouped by company, property, concentration, and geography."
      exportFilename="portfolio-load-report"
      exportSheets={sheetsFromReport("Portfolio Load", data)}
    >
      <ReportFilterBar />
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} /> : null}
      {!loading && !error && data ? (
        <>
          <KpiGrid>
            <KpiCard label="Active companies" value={formatNumber(data.kpis.activeCompanies)} />
            <KpiCard label="Active properties" value={formatNumber(data.kpis.activeProperties)} />
            <KpiCard label="Total active value" value={formatUsd(data.kpis.totalActiveValue)} tone="green" />
            <KpiCard label="Avg deal value per company" value={formatUsd(data.kpis.avgDealValuePerCompany)} />
          </KpiGrid>

          <ReportPanel title="Concentration Risk" action={<ConcentrationLegend />}>
            {data.concentrationRisk.length === 0 ? (
              <EmptyState message="No company concentration data matched the selected filters." />
            ) : (
              <div className="space-y-3">
                {data.concentrationRisk.map((company) => (
                  <div key={company.companyName} className="grid gap-2 md:grid-cols-[240px_1fr_150px] md:items-center">
                    <p className="truncate text-sm font-bold text-slate-950">{company.companyName}</p>
                    <div className="h-4 rounded-full bg-slate-100">
                      <div
                        className="h-4 rounded-full bg-brand-red"
                        style={{ width: `${Math.max(3, company.percentOfOpenPipeline)}%` }}
                        title={`${company.companyName}: ${company.percentOfOpenPipeline.toFixed(1)}% of open pipeline`}
                      />
                    </div>
                    <p className="text-sm font-black text-slate-900">
                      {company.percentOfOpenPipeline.toFixed(1)}% · {formatUsd(company.totalOpenValue)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </ReportPanel>

          <ReportPanel title="Per-company Breakdown">
            {data.companyBreakdown.length === 0 ? (
              <EmptyState message="No active companies matched the selected filters." />
            ) : (
              <ScrollTable>
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Company Name</th>
                      <th className="px-3 py-2">Active Deal Count</th>
                      <th className="px-3 py-2">Total Open Value</th>
                      <th className="px-3 py-2">Top Property</th>
                      <th className="px-3 py-2">Owner(s)</th>
                      <th className="px-3 py-2">Avg Deal Age</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.companyBreakdown.map((company) => (
                      <tr key={company.companyId ?? company.companyName}>
                        <td className="px-3 py-3">
                          {company.companyId ? (
                            <Link to={`/companies/${company.companyId}`} className="font-semibold text-slate-950 hover:text-brand-red hover:underline">
                              {company.companyName}
                            </Link>
                          ) : (
                            <span className="font-semibold text-slate-950">{company.companyName}</span>
                          )}
                        </td>
                        <td className="px-3 py-3">{formatNumber(company.activeDealCount)}</td>
                        <td className="px-3 py-3">{formatUsd(company.totalOpenValue)}</td>
                        <td className="px-3 py-3">{company.topProperty}</td>
                        <td className="px-3 py-3">{company.owners.join(", ") || "Unassigned"}</td>
                        <td className="px-3 py-3">{formatDays(company.avgDealAge)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollTable>
            )}
          </ReportPanel>

          <ReportPanel title="Per-property Breakdown">
            {data.propertyBreakdown.length === 0 ? (
              <EmptyState message="No active properties matched the selected filters." />
            ) : (
              <ScrollTable>
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Property Name</th>
                      <th className="px-3 py-2">Company</th>
                      <th className="px-3 py-2">Active Deal Count</th>
                      <th className="px-3 py-2">Total Value</th>
                      <th className="px-3 py-2">Most Recent Activity</th>
                      <th className="px-3 py-2">Owner</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.propertyBreakdown.map((property) => (
                      <tr key={property.propertyId ?? `${property.companyName}:${property.propertyName}`}>
                        <td className="px-3 py-3">
                          {property.propertyId ? (
                            <Link to={`/properties/${property.propertyId}`} className="font-semibold text-slate-950 hover:text-brand-red hover:underline">
                              {property.propertyName}
                            </Link>
                          ) : (
                            <span className="font-semibold text-slate-950">{property.propertyName}</span>
                          )}
                        </td>
                        <td className="px-3 py-3">{property.companyName}</td>
                        <td className="px-3 py-3">{formatNumber(property.activeDealCount)}</td>
                        <td className="px-3 py-3">{formatUsd(property.totalValue)}</td>
                        <td className="px-3 py-3">{formatDate(property.mostRecentActivity)}</td>
                        <td className="px-3 py-3">{property.ownerName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollTable>
            )}
          </ReportPanel>

          <ReportPanel title="Geographic Spread">
            <div className="grid gap-4 lg:grid-cols-2">
              <SpreadTable title="By Office" rows={data.geographicSpread.byOffice.map((row) => ({ label: row.office, dealCount: row.dealCount, totalValue: row.totalValue }))} />
              <SpreadTable title="By City / Region" rows={data.geographicSpread.byRegion.map((row) => ({ label: row.region, dealCount: row.dealCount, totalValue: row.totalValue }))} />
            </div>
          </ReportPanel>
        </>
      ) : null}
    </OperationsReportShell>
  );
}

function ConcentrationLegend() {
  return (
    <div className="flex flex-wrap gap-3 text-xs font-semibold text-slate-600">
      <span className="inline-flex items-center gap-1">
        <span className="h-2.5 w-2.5 rounded-full bg-brand-red" />
        Percent of open pipeline
      </span>
    </div>
  );
}

function SpreadTable({ title, rows }: { title: string; rows: Array<{ label: string; dealCount: number; totalValue: number }> }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-black text-slate-950">{title}</h3>
      {rows.length === 0 ? (
        <EmptyState message="No geographic data matched the selected filters." />
      ) : (
        <ScrollTable>
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Area</th>
                <th className="px-3 py-2">Deals</th>
                <th className="px-3 py-2">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.label}>
                  <td className="px-3 py-3 font-semibold text-slate-950">{row.label}</td>
                  <td className="px-3 py-3">{formatNumber(row.dealCount)}</td>
                  <td className="px-3 py-3">{formatUsd(row.totalValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollTable>
      )}
    </div>
  );
}
