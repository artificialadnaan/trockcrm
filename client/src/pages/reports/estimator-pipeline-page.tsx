import { useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import type {
  EstimatorPipelineBucket,
  EstimatorPipelineTargetKey,
} from "@trock-crm/shared/types";
import { Button } from "@/components/ui/button";
import { useEstimatorPipelineReport } from "@/hooks/use-estimator-pipeline-report";
import {
  formatNumber,
  formatUsd,
  OperationsReportShell,
  ReportPanel,
} from "./operations-report-common";
import { EstimatorEvidenceSheet } from "./estimator-pipeline/estimator-evidence-sheet";
import { EstimatorStageMatrix } from "./estimator-pipeline/estimator-stage-matrix";
import type { EstimatorDrillSelection } from "./estimator-pipeline/types";

type SummaryTone = "slate" | "amber" | "red";

function SummaryCard({
  label,
  count,
  value,
  detail,
  tone = "slate",
  enabled = true,
  bucket,
  estimatorKey,
  onDrill,
}: {
  label: string;
  count: number;
  value: number;
  detail: string;
  tone?: SummaryTone;
  enabled?: boolean;
  bucket: EstimatorPipelineBucket;
  estimatorKey?: EstimatorPipelineTargetKey;
  onDrill: (selection: EstimatorDrillSelection) => void;
}) {
  const toneClass: Record<SummaryTone, string> = {
    slate: "border-slate-200 bg-white",
    amber: "border-amber-300 bg-amber-50",
    red: "border-red-300 bg-red-50",
  };
  const contents = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-600">{label}</p>
        <span className="rounded-md bg-white/80 px-2 py-1 text-xs font-black tabular-nums text-slate-600 shadow-sm">
          {formatNumber(count)} projects
        </span>
      </div>
      <p className="mt-5 text-3xl font-black tabular-nums tracking-tight text-slate-950">{formatUsd(value)}</p>
      <p className="mt-1 text-xs font-semibold leading-5 text-slate-500">{detail}</p>
    </>
  );

  if (!enabled || count === 0) {
    return (
      <div className={`min-h-40 rounded-xl border p-4 shadow-sm ${toneClass[tone]}`} aria-label={`${label}: ${formatNumber(count)} projects, ${formatUsd(value)}`}>
        {contents}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onDrill({
        bucket,
        estimatorKey,
        title: label,
        description: "Current active projects across every open pipeline stage.",
      })}
      aria-label={`Show ${formatNumber(count)} ${label} projects with ${formatUsd(value)} in pipeline value`}
      className={`min-h-40 rounded-xl border p-4 text-left shadow-sm transition-colors hover:border-brand-red hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 active:bg-red-100 ${toneClass[tone]}`}
    >
      {contents}
    </button>
  );
}

function ReportLoading() {
  return (
    <div role="status" aria-label="Loading estimator pipeline report" className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => <div key={item} className="h-40 animate-pulse rounded-xl bg-slate-200" />)}
      </div>
      <div className="h-72 animate-pulse rounded-xl bg-slate-200" />
    </div>
  );
}

export function EstimatorPipelinePage() {
  const { search } = useLocation();
  const officeScopeKey = useMemo(() => new URLSearchParams(search).get("officeId") ?? "default", [search]);
  const { data, loading, error, refetch } = useEstimatorPipelineReport(officeScopeKey);
  const [drill, setDrill] = useState<EstimatorDrillSelection | null>(null);

  return (
    <OperationsReportShell
      title="Estimator Pipeline"
      description="Current pipeline attribution for Sidney Gibson and Alex Koch, with stage distribution and assignment gaps that need follow-up."
    >
      <section className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm" aria-label="Report scope">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Live office snapshot</p>
            <p className="mt-1 text-sm font-semibold text-slate-700">
              Current assignment and current stage. This report does not reconstruct historical estimator ownership.
            </p>
          </div>
          {data ? (
            <div className="flex gap-6 text-right">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">Open projects</p>
                <p className="mt-0.5 font-black tabular-nums text-slate-950">{formatNumber(data.pipeline.count)}</p>
              </div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">Pipeline value</p>
                <p className="mt-0.5 font-black tabular-nums text-slate-950">{formatUsd(data.pipeline.value)}</p>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {loading ? <ReportLoading /> : null}

      {!loading && error ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-800">
          <p className="font-black">The estimator report could not be loaded.</p>
          <p className="mt-1 text-sm">{error}</p>
          <Button type="button" variant="outline" className="mt-4" onClick={refetch}>Try again</Button>
        </div>
      ) : null}

      {!loading && !error && data ? (
        <>
          {data.warnings.length > 0 ? (
            <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
              <p className="font-black">Estimator identity check</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {data.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            </div>
          ) : null}

          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Estimator assignment summaries">
            {data.estimators.map((estimator) => (
              <SummaryCard
                key={estimator.key}
                label={estimator.estimatorName}
                count={estimator.count}
                value={estimator.value}
                detail={estimator.resolved ? "Currently linked estimator" : "CRM identity could not be resolved"}
                enabled={estimator.resolved}
                bucket="target"
                estimatorKey={estimator.key}
                onDrill={setDrill}
              />
            ))}
            <SummaryCard
              label="Other assigned"
              count={data.otherAssigned.count}
              value={data.otherAssigned.value}
              detail="Linked to another estimator"
              bucket="other"
              onDrill={setDrill}
            />
            <SummaryCard
              label="Missing estimator"
              count={data.missingEstimator.count}
              value={data.missingEstimator.value}
              detail={`${formatNumber(data.missingEstimator.actionableCount)} at Estimating or later need assignment`}
              tone={data.missingEstimator.actionableCount > 0 ? "red" : "amber"}
              bucket="missing"
              onDrill={setDrill}
            />
          </section>

          <ReportPanel
            title="Current pipeline by stage"
            action={<span className="text-xs font-semibold text-slate-500">Count and {data.valueBasisLabel.toLowerCase()}</span>}
          >
            <EstimatorStageMatrix report={data} onDrill={setDrill} />
          </ReportPanel>

          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm" aria-labelledby="estimator-report-definitions">
            <h2 id="estimator-report-definitions" className="text-base font-black text-slate-950">How this report is defined</h2>
            <ul className="mt-3 grid gap-2 text-sm leading-6 text-slate-600 md:grid-cols-2">
              <li><strong className="text-slate-800">Current attribution:</strong> projects are grouped by their linked estimator user today.</li>
              <li><strong className="text-slate-800">Selected office:</strong> only the office currently active in CRM is queried.</li>
              <li><strong className="text-slate-800">Active base projects:</strong> test, held, change-order, and terminal projects are excluded.</li>
              <li><strong className="text-slate-800">Missing:</strong> no linked estimator user, even if an older free-text name exists.</li>
            </ul>
            <p className="mt-3 text-xs font-medium text-slate-500">{data.scope.note}</p>
          </section>
        </>
      ) : null}

      <EstimatorEvidenceSheet
        selection={drill}
        officeScopeKey={officeScopeKey}
        onOpenChange={(open) => { if (!open) setDrill(null); }}
      />
    </OperationsReportShell>
  );
}

export default EstimatorPipelinePage;
