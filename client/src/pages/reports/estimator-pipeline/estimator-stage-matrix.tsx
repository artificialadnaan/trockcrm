import type {
  EstimatorPipelineReport,
  EstimatorPipelineStageSummary,
  EstimatorPipelineTargetKey,
} from "@trock-crm/shared/types";
import { ScrollSyncX } from "../scroll-sync-x";
import { formatNumber, formatUsd } from "../operations-report-common";
import type { EstimatorDrillSelection } from "./types";

interface MatrixRow {
  key: string;
  label: string;
  bucket: EstimatorDrillSelection["bucket"];
  estimatorKey?: EstimatorPipelineTargetKey;
  count: number;
  value: number;
  resolved: boolean;
  stages: EstimatorPipelineStageSummary[];
}

function stageMetric(row: MatrixRow, stageSlug: string): EstimatorPipelineStageSummary | null {
  return row.stages.find((stage) => stage.stageSlug === stageSlug) ?? null;
}

function DrillMetric({
  label,
  count,
  value,
  disabled,
  onClick,
}: {
  label: string;
  count: number;
  value: number;
  disabled?: boolean;
  onClick: () => void;
}) {
  if (count === 0 || disabled) {
    return (
      <div className="min-w-[8.5rem] px-3 py-3 text-right" aria-label={`${label}: ${formatNumber(count)} projects, ${formatUsd(value)}`}>
        <div className="text-base font-black tabular-nums text-slate-500">{formatNumber(count)}</div>
        <div className="text-xs font-semibold tabular-nums text-slate-500">{formatUsd(value)}</div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Show ${formatNumber(count)} ${label} projects with ${formatUsd(value)} in pipeline value`}
      className="min-w-[8.5rem] rounded-md px-3 py-3 text-right transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 active:bg-red-100"
    >
      <div className="text-base font-black tabular-nums text-slate-950">{formatNumber(count)}</div>
      <div className="text-xs font-semibold tabular-nums text-slate-500">{formatUsd(value)}</div>
    </button>
  );
}

export function EstimatorStageMatrix({
  report,
  onDrill,
}: {
  report: EstimatorPipelineReport;
  onDrill: (selection: EstimatorDrillSelection) => void;
}) {
  const rows: MatrixRow[] = [
    ...report.estimators.map((estimator) => ({
      key: estimator.key,
      label: estimator.estimatorName,
      bucket: "target" as const,
      estimatorKey: estimator.key,
      count: estimator.count,
      value: estimator.value,
      resolved: estimator.resolved,
      stages: estimator.stages,
    })),
    {
      key: "other",
      label: "Other assigned",
      bucket: "other" as const,
      count: report.otherAssigned.count,
      value: report.otherAssigned.value,
      resolved: true,
      stages: report.otherAssigned.stages,
    },
    {
      key: "missing",
      label: "Missing estimator",
      bucket: "missing" as const,
      count: report.missingEstimator.count,
      value: report.missingEstimator.value,
      resolved: true,
      stages: report.missingEstimator.stages,
    },
  ];

  if (report.stageColumns.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm font-semibold text-slate-500">
        No active pipeline stages contain projects in this office.
      </div>
    );
  }

  return (
    <ScrollSyncX className="rounded-lg border border-slate-200" bodyClassName="overflow-x-auto">
      <table className="min-w-[980px] w-full border-collapse bg-white text-sm">
        <caption className="sr-only">Estimator project counts and best current estimate value by pipeline stage</caption>
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50">
            <th scope="col" className="sticky left-0 z-10 min-w-48 bg-slate-50 px-4 py-3 text-left text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
              Assignment
            </th>
            {report.stageColumns.map((stage) => (
              <th key={stage.stageSlug} scope="col" className="min-w-[9rem] px-3 py-3 text-right text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">
                {stage.stageLabel}
              </th>
            ))}
            <th scope="col" className="min-w-[9rem] bg-slate-100 px-3 py-3 text-right text-[11px] font-black uppercase tracking-[0.12em] text-slate-600">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-slate-100 last:border-b-0">
              <th scope="row" className="sticky left-0 z-10 bg-white px-4 py-4 text-left shadow-[1px_0_0_0_rgb(226_232_240)]">
                <div className="font-black text-slate-950">{row.label}</div>
                <div className="mt-0.5 text-xs font-medium text-slate-500">
                  {row.resolved ? "Current assignment" : "CRM identity not resolved"}
                </div>
              </th>
              {report.stageColumns.map((stage) => {
                const metric = stageMetric(row, stage.stageSlug);
                const count = metric?.count ?? 0;
                const value = metric?.value ?? 0;
                const label = `${row.label} in ${stage.stageLabel}`;
                return (
                  <td key={stage.stageSlug} className="px-1 py-1 align-middle">
                    <DrillMetric
                      label={label}
                      count={count}
                      value={value}
                      disabled={!row.resolved}
                      onClick={() => onDrill({
                        bucket: row.bucket,
                        estimatorKey: row.estimatorKey,
                        stageSlug: stage.stageSlug,
                        title: `${row.label}: ${stage.stageLabel}`,
                        description: `Current active projects in ${stage.stageLabel}.`,
                      })}
                    />
                  </td>
                );
              })}
              <td className="bg-slate-50 px-1 py-1 align-middle">
                <DrillMetric
                  label={`${row.label} across all stages`}
                  count={row.count}
                  value={row.value}
                  disabled={!row.resolved}
                  onClick={() => onDrill({
                    bucket: row.bucket,
                    estimatorKey: row.estimatorKey,
                    title: row.label,
                    description: "Current active projects across every open pipeline stage.",
                  })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollSyncX>
  );
}
