import type {
  EstimatorPipelineMetric,
  EstimatorPipelineReport,
  EstimatorPipelineStageSummary,
  EstimatorPipelineTargetKey,
} from "@trock-crm/shared/types";
import { formatNumber, formatUsd } from "../operations-report-common";
import type { EstimatorDrillSelection } from "./types";

interface MatrixRow {
  key: string;
  label: string;
  bucket: EstimatorDrillSelection["bucket"];
  estimatorKey?: EstimatorPipelineTargetKey;
  count: number;
  value: number;
  won: EstimatorPipelineMetric;
  resolved: boolean;
  stages: EstimatorPipelineStageSummary[];
}

const compactUsdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

function formatCompactUsd(value: number): string {
  return compactUsdFormatter.format(Number.isFinite(value) ? value : 0);
}

function formatProjectCount(count: number): string {
  return `${formatNumber(count)} ${count === 1 ? "project" : "projects"}`;
}

function formatReportDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}

function stageMetric(row: MatrixRow, stageSlug: string): EstimatorPipelineStageSummary | null {
  return row.stages.find((stage) => stage.stageSlug === stageSlug) ?? null;
}

function stageTone(stageSlug: string): { header: string; cell: string; badge: string } {
  if (stageSlug === "estimating" || stageSlug === "service_estimating") {
    return {
      header: "border-t-2 border-t-sky-500 bg-sky-50 text-sky-900",
      cell: "bg-sky-50/35",
      badge: "border-sky-200 bg-sky-50 text-sky-800",
    };
  }
  if (["estimate_under_review", "estimate_sent_to_client", "contract"].includes(stageSlug)) {
    return {
      header: "border-t-2 border-t-amber-500 bg-amber-50 text-amber-950",
      cell: "bg-amber-50/30",
      badge: "border-amber-200 bg-amber-50 text-amber-900",
    };
  }
  return {
    header: "border-t-2 border-t-slate-400 bg-slate-50 text-slate-700",
    cell: "bg-white",
    badge: "border-slate-200 bg-slate-50 text-slate-700",
  };
}

function DrillMetric({
  label,
  count,
  value,
  disabled,
  compact = false,
  tone = "default",
  onClick,
}: {
  label: string;
  count: number;
  value: number;
  disabled?: boolean;
  compact?: boolean;
  tone?: "default" | "open-total" | "won";
  onClick: () => void;
}) {
  const containerClass = tone === "won"
    ? "border-emerald-200 bg-emerald-50/80 hover:border-emerald-400 hover:bg-emerald-100/70"
    : tone === "open-total"
      ? "border-sky-200 bg-sky-50/80 hover:border-sky-400 hover:bg-sky-100/70"
      : "border-transparent hover:border-slate-200 hover:bg-slate-50";
  const valueLabel = compact ? formatCompactUsd(value) : formatUsd(value);
  const contents = (
    <>
      <span className="block text-base font-black tabular-nums text-slate-950">{formatNumber(count)}</span>
      <span className="block text-xs font-semibold tabular-nums text-slate-600" title={formatUsd(value)}>{valueLabel}</span>
    </>
  );

  if (count === 0 || disabled) {
    return (
      <div className={`min-h-14 rounded-md border px-2 py-2 text-right ${containerClass}`} aria-label={`${label}: ${formatProjectCount(count)}, ${formatUsd(value)}`}>
        {contents}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Show ${formatProjectCount(count)} for ${label} with ${formatUsd(value)}`}
      className={`min-h-14 w-full rounded-md border px-2 py-2 text-right transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-1 active:translate-y-px ${containerClass}`}
    >
      {contents}
    </button>
  );
}

function openStageSelection(row: MatrixRow, stage: EstimatorPipelineReport["stageColumns"][number]): EstimatorDrillSelection {
  return {
    cohort: "open",
    bucket: row.bucket,
    estimatorKey: row.estimatorKey,
    stageSlug: stage.stageSlug,
    title: `${row.label}: ${stage.stageLabel}`,
    description: `Current open projects in ${stage.stageLabel}.`,
  };
}

function openTotalSelection(row: MatrixRow): EstimatorDrillSelection {
  return {
    cohort: "open",
    bucket: row.bucket,
    estimatorKey: row.estimatorKey,
    title: row.label,
    description: "Current open projects across every active pipeline stage.",
  };
}

function wonSelection(row: MatrixRow, report: EstimatorPipelineReport): EstimatorDrillSelection {
  return {
    cohort: "won",
    period: report.wonPeriod,
    bucket: row.bucket,
    estimatorKey: row.estimatorKey,
    title: `${row.label}: ${report.wonPeriod.label}`,
    description: `Projects won from ${formatReportDate(report.wonPeriod.from)} through ${formatReportDate(report.wonPeriod.to)}.`,
  };
}

function AssignmentCard({
  row,
  report,
  onDrill,
}: {
  row: MatrixRow;
  report: EstimatorPipelineReport;
  onDrill: (selection: EstimatorDrillSelection) => void;
}) {
  return (
    <article className={`rounded-xl border p-4 shadow-sm ${row.key === "missing" ? "border-red-200 bg-red-50/35" : "border-slate-200 bg-white"}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-black text-slate-950">{row.label}</h3>
          <p className="mt-0.5 text-xs font-medium text-slate-600">
            {row.resolved ? "Current CRM assignment" : "CRM identity not resolved"}
          </p>
        </div>
        <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-black tabular-nums text-slate-600">
          {formatNumber(row.count + row.won.count)} tracked
        </span>
      </div>

      {report.stageColumns.length > 0 ? (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {report.stageColumns.map((stage) => {
            const metric = stageMetric(row, stage.stageSlug);
            const count = metric?.count ?? 0;
            const value = metric?.value ?? 0;
            return (
              <div key={stage.stageSlug} className={`rounded-lg border p-2 ${stageTone(stage.stageSlug).badge}`}>
                <p className="min-h-8 text-[11px] font-black leading-4">{stage.stageLabel}</p>
                <DrillMetric
                  label={`${row.label} in ${stage.stageLabel}`}
                  count={count}
                  value={value}
                  disabled={!row.resolved}
                  compact
                  onClick={() => onDrill(openStageSelection(row, stage))}
                />
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="mt-3 grid grid-cols-2 gap-2 border-t border-slate-200 pt-3">
        <div>
          <p className="mb-1 text-[11px] font-black uppercase tracking-[0.1em] text-sky-800">Open total</p>
          <DrillMetric
            label={`${row.label} open pipeline`}
            count={row.count}
            value={row.value}
            disabled={!row.resolved}
            tone="open-total"
            onClick={() => onDrill(openTotalSelection(row))}
          />
        </div>
        <div>
          <p className="mb-1 text-[11px] font-black uppercase tracking-[0.1em] text-emerald-800">{report.wonPeriod.label}</p>
          <DrillMetric
            label={`${row.label} ${report.wonPeriod.label}`}
            count={row.won.count}
            value={row.won.value}
            disabled={!row.resolved}
            tone="won"
            onClick={() => onDrill(wonSelection(row, report))}
          />
        </div>
      </div>
    </article>
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
      won: estimator.won,
      resolved: estimator.resolved,
      stages: estimator.stages,
    })),
    {
      key: "other",
      label: "Other assigned",
      bucket: "other" as const,
      count: report.otherAssigned.count,
      value: report.otherAssigned.value,
      won: report.otherAssigned.won,
      resolved: true,
      stages: report.otherAssigned.stages,
    },
    {
      key: "missing",
      label: "Missing estimator",
      bucket: "missing" as const,
      count: report.missingEstimator.count,
      value: report.missingEstimator.value,
      won: report.missingEstimator.won,
      resolved: true,
      stages: report.missingEstimator.stages,
    },
  ];

  if (report.stageColumns.length === 0 && report.won.count === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm font-semibold text-slate-600">
        No open or Won YTD projects are assigned in this office.
      </div>
    );
  }

  return (
    <>
      <div className="grid gap-3 xl:hidden" data-testid="estimator-stage-cards">
        {rows.map((row) => <AssignmentCard key={row.key} row={row} report={report} onDrill={onDrill} />)}
      </div>

      <div className="hidden overflow-hidden rounded-lg border border-slate-200 xl:block" data-testid="estimator-stage-table">
        <table className="w-full table-fixed border-collapse bg-white text-sm">
          <caption className="sr-only">Estimator project counts by open pipeline stage and Won YTD</caption>
          <colgroup>
            <col className="w-44" />
            {report.stageColumns.map((stage) => <col key={stage.stageSlug} />)}
            <col />
            <col />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200">
              <th scope="col" className="bg-slate-100 px-3 py-3 text-left text-[11px] font-black uppercase tracking-[0.1em] text-slate-600">
                Assignment
              </th>
              {report.stageColumns.map((stage) => (
                <th key={stage.stageSlug} scope="col" className={`px-2 py-3 text-right text-[10px] font-black uppercase leading-4 tracking-[0.08em] ${stageTone(stage.stageSlug).header}`}>
                  {stage.stageLabel}
                </th>
              ))}
              <th scope="col" className="border-t-2 border-t-sky-600 bg-sky-100/80 px-2 py-3 text-right text-[10px] font-black uppercase leading-4 tracking-[0.08em] text-sky-950">
                Open total
              </th>
              <th scope="col" className="border-t-2 border-t-emerald-600 bg-emerald-100/80 px-2 py-3 text-right text-[10px] font-black uppercase leading-4 tracking-[0.08em] text-emerald-950">
                {report.wonPeriod.label}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className={`border-b border-slate-100 last:border-b-0 ${row.key === "missing" ? "bg-red-50/25" : ""}`}>
                <th scope="row" className="px-3 py-3 text-left">
                  <div className="font-black leading-5 text-slate-950">{row.label}</div>
                  <div className="mt-0.5 text-[11px] font-medium leading-4 text-slate-600">
                    {row.resolved ? "Current assignment" : "CRM identity not resolved"}
                  </div>
                </th>
                {report.stageColumns.map((stage) => {
                  const metric = stageMetric(row, stage.stageSlug);
                  const count = metric?.count ?? 0;
                  const value = metric?.value ?? 0;
                  return (
                    <td key={stage.stageSlug} className={`p-1 align-middle ${stageTone(stage.stageSlug).cell}`}>
                      <DrillMetric
                        label={`${row.label} in ${stage.stageLabel}`}
                        count={count}
                        value={value}
                        disabled={!row.resolved}
                        compact
                        onClick={() => onDrill(openStageSelection(row, stage))}
                      />
                    </td>
                  );
                })}
                <td className="bg-sky-50/60 p-1 align-middle">
                  <DrillMetric
                    label={`${row.label} open pipeline`}
                    count={row.count}
                    value={row.value}
                    disabled={!row.resolved}
                    compact
                    tone="open-total"
                    onClick={() => onDrill(openTotalSelection(row))}
                  />
                </td>
                <td className="bg-emerald-50/60 p-1 align-middle">
                  <DrillMetric
                    label={`${row.label} ${report.wonPeriod.label}`}
                    count={row.won.count}
                    value={row.won.value}
                    disabled={!row.resolved}
                    compact
                    tone="won"
                    onClick={() => onDrill(wonSelection(row, report))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
