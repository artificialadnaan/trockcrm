import { ClipboardList } from "lucide-react";
import { ReportFilterBar, useReportFilters } from "@/components/reports/report-filter-bar";
import { useProjectReadinessReport } from "@/hooks/use-reports";
import {
  DealLink,
  EmptyState,
  ErrorState,
  formatDays,
  formatNumber,
  KpiCard,
  KpiGrid,
  LoadingState,
  OperationsReportShell,
  ReportPanel,
  ScrollTable,
} from "./operations-report-common";

export function ProjectReadinessPage() {
  const { query } = useReportFilters();
  const { data, loading, error } = useProjectReadinessReport(query);

  return (
    <OperationsReportShell
      title="Project Readiness"
      description="Scoping, estimating, contract, and kickoff completeness for active work."
    >
      <ReportFilterBar />
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} /> : null}
      {!loading && !error && data ? (
        <>
          <KpiGrid>
            <KpiCard label="Deals in scoping" value={formatNumber(data.kpis.dealsInScoping)} />
            <KpiCard label="Deals in estimating" value={formatNumber(data.kpis.dealsInEstimating)} tone="amber" />
            <KpiCard label="Contract-ready deals" value={formatNumber(data.kpis.dealsContractReady)} tone="green" />
            <KpiCard label="Kickoff-ready deals" value={formatNumber(data.kpis.dealsKickoffReady)} tone="green" />
          </KpiGrid>

          <ReportPanel
            title="Readiness Checklist Breakdown"
            action={<ClipboardList className="h-4 w-4 text-slate-500" />}
          >
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {data.checklistBreakdown.map((stage) => (
                <div key={stage.stageGroup} className="rounded-lg border border-slate-200 p-4">
                  <p className="text-sm font-black text-slate-950">{stage.stageGroup}</p>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <div className="rounded-md bg-emerald-50 p-2">
                      <p className="text-xs font-bold uppercase text-emerald-700">Complete</p>
                      <p className="text-xl font-black text-emerald-950">{formatNumber(stage.completeCount)}</p>
                    </div>
                    <div className="rounded-md bg-amber-50 p-2">
                      <p className="text-xs font-bold uppercase text-amber-700">Incomplete</p>
                      <p className="text-xl font-black text-amber-950">{formatNumber(stage.incompleteCount)}</p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {stage.signals.length === 0 ? (
                      <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-500">No gaps found</span>
                    ) : stage.signals.slice(0, 4).map((signal) => (
                      <span key={signal} className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                        {signal}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-4 text-xs font-medium text-slate-500">{data.assumption}</p>
          </ReportPanel>

          <ReportPanel title="Deals Missing Readiness">
            {data.missingReadiness.length === 0 ? (
              <EmptyState message="No readiness gaps matched the selected filters." />
            ) : (
              <ScrollTable>
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Deal</th>
                      <th className="px-3 py-2">Owner</th>
                      <th className="px-3 py-2">Stage</th>
                      <th className="px-3 py-2">Days in Stage</th>
                      <th className="px-3 py-2">Missing Items</th>
                      <th className="px-3 py-2">Project Number</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.missingReadiness.map((deal) => (
                      <tr key={deal.dealId}>
                        <td className="px-3 py-3"><DealLink dealId={deal.dealId}>{deal.dealName}</DealLink></td>
                        <td className="px-3 py-3">{deal.ownerName}</td>
                        <td className="px-3 py-3">{deal.stageName}</td>
                        <td className="px-3 py-3">{formatDays(deal.daysInStage)}</td>
                        <td className="px-3 py-3">
                          <div className="flex max-w-xl flex-wrap gap-1.5">
                            {deal.missingItems.map((item) => (
                              <span key={item} className="rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800">
                                {item}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-3">{deal.projectNumber ?? "Not assigned"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollTable>
            )}
          </ReportPanel>

          <ReportPanel title="Per-owner Readiness Summary">
            {data.ownerSummary.length === 0 ? (
              <EmptyState message="No owner readiness gaps matched the selected filters." />
            ) : (
              <ScrollTable>
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Rep</th>
                      <th className="px-3 py-2">Scoping Incomplete</th>
                      <th className="px-3 py-2">Estimating Incomplete</th>
                      <th className="px-3 py-2">Kickoff Incomplete</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.ownerSummary.map((owner) => (
                      <tr key={owner.ownerName}>
                        <td className="px-3 py-3 font-semibold text-slate-950">{owner.ownerName}</td>
                        <td className="px-3 py-3">{formatNumber(owner.scopingIncomplete)}</td>
                        <td className="px-3 py-3">{formatNumber(owner.estimatingIncomplete)}</td>
                        <td className="px-3 py-3">{formatNumber(owner.kickoffIncomplete)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollTable>
            )}
          </ReportPanel>
        </>
      ) : null}
    </OperationsReportShell>
  );
}
