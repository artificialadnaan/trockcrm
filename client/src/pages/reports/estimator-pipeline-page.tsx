import { useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import type {
  EstimatorPipelineBucket,
  EstimatorPipelineMetric,
  EstimatorPipelineTargetKey,
  EstimatorPipelineWonPeriod,
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

type SummaryTone = "neutral" | "red";

function formatProjectCount(count: number): string {
  return `${formatNumber(count)} ${count === 1 ? "project" : "projects"}`;
}

function formatMissingAssignmentDetail(count: number): string {
  return count === 1
    ? "1 open project at Estimating or later needs assignment"
    : `${formatNumber(count)} open projects at Estimating or later need assignment`;
}

function formatReportDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}

function SummaryMetric({
  label,
  count,
  value,
  enabled,
  tone,
  onClick,
  accessibleName,
}: {
  label: string;
  count: number;
  value: number;
  enabled: boolean;
  tone: "open" | "won";
  onClick: () => void;
  accessibleName: string;
}) {
  const classes = tone === "won"
    ? "border-emerald-200 bg-emerald-50/80 hover:border-emerald-400 hover:bg-emerald-100/70"
    : "border-slate-200 bg-white/80 hover:border-slate-400 hover:bg-white";
  const contents = (
    <>
      <span className={`text-[11px] font-black uppercase tracking-[0.1em] ${tone === "won" ? "text-emerald-800" : "text-slate-600"}`}>
        {label}
      </span>
      <span className="mt-2 block text-2xl font-black tabular-nums tracking-tight text-slate-950">
        {formatNumber(count)}
      </span>
      <span className="mt-0.5 block text-xs font-bold tabular-nums text-slate-600">
        {formatUsd(value)}
      </span>
    </>
  );

  if (!enabled || count === 0) {
    return (
      <div className={`min-h-24 rounded-lg border p-3 ${classes}`} aria-label={accessibleName}>
        {contents}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Show ${accessibleName}`}
      className={`min-h-24 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red focus-visible:ring-offset-2 active:translate-y-px ${classes}`}
    >
      {contents}
    </button>
  );
}

function SummaryCard({
  label,
  open,
  won,
  detail,
  tone,
  enabled = true,
  bucket,
  estimatorKey,
  wonLabel,
  wonPeriod,
  wonDescription,
  onDrill,
}: {
  label: string;
  open: EstimatorPipelineMetric;
  won: EstimatorPipelineMetric;
  detail: string;
  tone: SummaryTone;
  enabled?: boolean;
  bucket: EstimatorPipelineBucket;
  estimatorKey?: EstimatorPipelineTargetKey;
  wonLabel: string;
  wonPeriod: EstimatorPipelineWonPeriod;
  wonDescription: string;
  onDrill: (selection: EstimatorDrillSelection) => void;
}) {
  const toneClass: Record<SummaryTone, string> = {
    neutral: "border-slate-200 bg-white",
    red: "border-red-300 bg-red-50/70",
  };

  return (
    <article className={`rounded-xl border p-4 shadow-sm ${toneClass[tone]}`}>
      <div className="flex min-h-11 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-black leading-5 text-slate-950">{label}</h3>
          <p className="mt-0.5 text-xs font-semibold leading-5 text-slate-600">{detail}</p>
        </div>
        <span className="shrink-0 rounded-md border border-white/80 bg-white/85 px-2 py-1 text-[11px] font-black tabular-nums text-slate-600 shadow-sm">
          {formatNumber(open.count + won.count)} tracked
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <SummaryMetric
          label="Open pipeline"
          count={open.count}
          value={open.value}
          enabled={enabled}
          tone="open"
          accessibleName={`${label} open pipeline: ${formatProjectCount(open.count)}, ${formatUsd(open.value)}`}
          onClick={() => onDrill({
            cohort: "open",
            bucket,
            estimatorKey,
            title: label,
            description: "Current open projects across every active pipeline stage.",
          })}
        />
        <SummaryMetric
          label={wonLabel}
          count={won.count}
          value={won.value}
          enabled={enabled}
          tone="won"
          accessibleName={`${label} ${wonLabel}: ${formatProjectCount(won.count)}, ${formatUsd(won.value)}`}
          onClick={() => onDrill({
            cohort: "won",
            period: wonPeriod,
            bucket,
            estimatorKey,
            title: `${label}: ${wonLabel}`,
            description: wonDescription,
          })}
        />
      </div>
    </article>
  );
}

function ReportLoading() {
  return (
    <div role="status" aria-label="Loading estimator pipeline report" className="space-y-5">
      <div className="h-32 animate-pulse rounded-xl bg-slate-200" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => <div key={item} className="h-52 animate-pulse rounded-xl bg-slate-200" />)}
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
      description="Current attribution across each estimator's active pipeline work and projects won this year."
    >
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
          <section className="overflow-hidden rounded-xl border border-slate-200 border-l-4 border-l-brand-red bg-white shadow-sm" aria-label="Report scope and office totals">
            <div className="grid xl:grid-cols-[minmax(0,1.35fr)_minmax(32rem,1fr)]">
              <div className="px-5 py-5">
                <h2 className="text-base font-black text-slate-950">Current office snapshot</h2>
                <p className="mt-1 max-w-2xl text-sm font-medium leading-6 text-slate-600">
                  Current CRM assignment across open work and projects won this year. Historical estimator ownership is not reconstructed.
                </p>
              </div>
              <div className="grid grid-cols-2 border-t border-slate-200 xl:border-l xl:border-t-0">
                <div className="bg-sky-50/70 px-4 py-4">
                  <p className="text-[11px] font-black uppercase tracking-[0.1em] text-sky-800">Open projects</p>
                  <p className="mt-1 text-xl font-black tabular-nums text-slate-950">{formatNumber(data.pipeline.count)}</p>
                  <p className="mt-0.5 text-xs font-bold tabular-nums text-slate-600">{formatUsd(data.pipeline.value)}</p>
                </div>
                <div className="border-l border-emerald-200 bg-emerald-50/70 px-4 py-4">
                  <p className="text-[11px] font-black uppercase tracking-[0.1em] text-emerald-800">{data.wonPeriod.label}</p>
                  <p className="mt-1 text-xl font-black tabular-nums text-slate-950">{formatNumber(data.won.count)}</p>
                  <p className="mt-0.5 text-xs font-bold tabular-nums text-slate-600">{formatUsd(data.won.value)}</p>
                </div>
              </div>
            </div>
          </section>

          {data.warnings.length > 0 ? (
            <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
              <p className="font-black">Estimator identity check</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {data.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            </div>
          ) : null}

          <section aria-labelledby="estimator-workload-heading">
            <div className="mb-3">
              <h2 id="estimator-workload-heading" className="text-lg font-black text-slate-950">Estimator workload</h2>
              <p className="mt-1 text-sm text-slate-600">Open work and Won YTD stay separate so every value keeps its correct meaning.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Estimator assignment summaries">
              {data.estimators.map((estimator) => (
                <SummaryCard
                  key={estimator.key}
                  label={estimator.estimatorName}
                  open={estimator}
                  won={estimator.won}
                  detail={estimator.resolved ? "Currently linked estimator" : "CRM identity could not be resolved"}
                  tone="neutral"
                  enabled={estimator.resolved}
                  bucket="target"
                  estimatorKey={estimator.key}
                  wonLabel={data.wonPeriod.label}
                  wonPeriod={data.wonPeriod}
                  wonDescription={`Projects won from ${formatReportDate(data.wonPeriod.from)} through ${formatReportDate(data.wonPeriod.to)}.`}
                  onDrill={setDrill}
                />
              ))}
              <SummaryCard
                label="Other assigned"
                open={data.otherAssigned}
                won={data.otherAssigned.won}
                detail="Linked to another estimator"
                tone="neutral"
                bucket="other"
                wonLabel={data.wonPeriod.label}
                wonPeriod={data.wonPeriod}
                wonDescription={`Projects won from ${formatReportDate(data.wonPeriod.from)} through ${formatReportDate(data.wonPeriod.to)}.`}
                onDrill={setDrill}
              />
              <SummaryCard
                label="Missing estimator"
                open={data.missingEstimator}
                won={data.missingEstimator.won}
                detail={formatMissingAssignmentDetail(data.missingEstimator.actionableCount)}
                tone="red"
                bucket="missing"
                wonLabel={data.wonPeriod.label}
                wonPeriod={data.wonPeriod}
                wonDescription={`Won projects missing estimator attribution from ${formatReportDate(data.wonPeriod.from)} through ${formatReportDate(data.wonPeriod.to)}.`}
                onDrill={setDrill}
              />
            </div>
          </section>

          <ReportPanel
            title="Pipeline distribution"
            action={<span className="text-xs font-semibold text-slate-500">Open estimates and awarded Won value</span>}
          >
            <EstimatorStageMatrix report={data} onDrill={setDrill} />
          </ReportPanel>

          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm" aria-labelledby="estimator-report-definitions">
            <h2 id="estimator-report-definitions" className="text-base font-black text-slate-950">How this report is defined</h2>
            <ul className="mt-3 grid gap-x-8 gap-y-2 text-sm leading-6 text-slate-600 md:grid-cols-2">
              <li><strong className="text-slate-800">Current attribution:</strong> projects use the estimator linked in CRM today.</li>
              <li><strong className="text-slate-800">Selected office:</strong> only the office currently active in CRM is queried.</li>
              <li><strong className="text-slate-800">Open cohort:</strong> active base projects in nonterminal stages, excluding test, held, and change-order records.</li>
              <li><strong className="text-slate-800">Won cohort:</strong> active base projects won during the current calendar year. Lost projects are excluded.</li>
              <li><strong className="text-slate-800">Value basis:</strong> open stages use best current estimate. Won uses awarded-first won value.</li>
              <li><strong className="text-slate-800">Missing:</strong> no linked estimator user, even when an older free-text name exists.</li>
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
