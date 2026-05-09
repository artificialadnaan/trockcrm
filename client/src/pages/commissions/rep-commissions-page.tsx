import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, ChevronRight, Download, Target, User as UserIcon, Users } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { buildReportExportFilename, downloadTextFile, serializeRowsToCsv } from "@/lib/report-export";

type Period = "mtd" | "qtd" | "ytd" | "all";
type CommissionStage = "won" | "contract" | "estimate_sent" | "estimating" | "opportunity";

interface CommissionDeal {
  dealId: string;
  dealNumber: string | null;
  dealName: string;
  companyName: string | null;
  propertyName: string | null;
  propertyAddress: string | null;
  stageKey: CommissionStage;
  stageName: string;
  stageSlug: string;
  dealValue: number;
  commissionRate: number;
  commission: number;
  deltaCommission: number | null;
  contractSignedDate: string | null;
  expectedCloseDate: string | null;
  daysInStage: number;
  isEarned: boolean;
}

interface StageTotal {
  stageKey: CommissionStage;
  stageName: string;
  commission: number;
  dealValue: number;
  dealCount: number;
  percentOfTotal: number;
}

interface CommissionDashboard {
  period: Period;
  dateRange: { from: string | null; to: string | null };
  formula: string;
  goal: { amount: number; percentToGoal: number | null; source: "none" };
  summary: {
    earned: number;
    inPipeline: number;
    totalPotential: number;
    openDealCount: number;
  };
  stageTotals: StageTotal[];
  deals: CommissionDeal[];
}

const PERIODS: Array<{ key: Period; label: string }> = [
  { key: "mtd", label: "MTD" },
  { key: "qtd", label: "QTD" },
  { key: "ytd", label: "YTD" },
  { key: "all", label: "All" },
];

const STAGE_ORDER: CommissionStage[] = ["won", "contract", "estimate_sent", "estimating", "opportunity"];

const STAGE_META: Record<CommissionStage, { label: string; description: string; dot: string; bar: string; pill: string }> = {
  won: {
    label: "Earned",
    description: "Contract signed · locked in",
    dot: "bg-emerald-500",
    bar: "bg-emerald-500",
    pill: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  },
  contract: {
    label: "Contract",
    description: "One signature away",
    dot: "bg-brand-red/70",
    bar: "bg-brand-red/70",
    pill: "bg-brand-red/10 text-brand-red ring-brand-red/20",
  },
  estimate_sent: {
    label: "Estimate Sent",
    description: "Awaiting client review",
    dot: "bg-blue-400",
    bar: "bg-blue-400",
    pill: "bg-blue-50 text-blue-700 ring-blue-200",
  },
  estimating: {
    label: "Estimating",
    description: "Pricing in progress",
    dot: "bg-amber-300",
    bar: "bg-amber-300",
    pill: "bg-amber-50 text-amber-700 ring-amber-200",
  },
  opportunity: {
    label: "Opportunity",
    description: "Earliest stage · uncertain",
    dot: "bg-slate-300",
    bar: "bg-slate-300",
    pill: "bg-slate-100 text-slate-700 ring-slate-200",
  },
};

const EMPTY_DASHBOARD: CommissionDashboard = {
  period: "ytd",
  dateRange: { from: null, to: null },
  formula: "",
  goal: { amount: 0, percentToGoal: null, source: "none" },
  summary: { earned: 0, inPipeline: 0, totalPotential: 0, openDealCount: 0 },
  stageTotals: STAGE_ORDER.map((stageKey) => ({
    stageKey,
    stageName: STAGE_META[stageKey].label,
    commission: 0,
    dealValue: 0,
    dealCount: 0,
    percentOfTotal: 0,
  })),
  deals: [],
};

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const USD_WHOLE = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const USD_COMPACT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

function money(value: number, mode: "full" | "whole" | "compact" = "full") {
  const safe = Number.isFinite(value) ? value : 0;
  if (mode === "compact") return USD_COMPACT.format(safe);
  if (mode === "whole") return USD_WHOLE.format(safe);
  return USD.format(safe);
}

function percent(value: number | null) {
  return value == null || !Number.isFinite(value) ? "No goal set" : `${value.toFixed(0)}%`;
}

function formatDate(value: string | null) {
  if (!value) return "";
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function csvRows(deals: CommissionDeal[]) {
  return deals.map((deal) => ({
    deal: deal.dealName,
    company: deal.companyName ?? "",
    property: deal.propertyName ?? deal.propertyAddress ?? "",
    stage: STAGE_META[deal.stageKey].label,
    dealValue: deal.dealValue.toFixed(2),
    rate: (deal.commissionRate * 100).toFixed(2),
    commission: deal.commission.toFixed(2),
    delta: deal.deltaCommission == null ? "" : deal.deltaCommission.toFixed(2),
    signedDate: deal.contractSignedDate ?? "",
    expectedCloseDate: deal.expectedCloseDate ?? "",
  }));
}

function MetricCard({
  eyebrow,
  value,
  badge,
  caption,
  tone = "neutral",
}: {
  eyebrow: string;
  value: string;
  badge: string;
  caption: string;
  tone?: "red" | "blue" | "green" | "neutral";
}) {
  const drenched = tone === "red";
  const accent =
    tone === "blue" ? "border-b-blue-400" : tone === "green" ? "border-b-emerald-500" : "border-b-slate-200";
  return (
    <div
      className={
        drenched
          ? "rounded-lg bg-brand-red p-5 text-white shadow-sm"
          : `rounded-lg border border-slate-200 border-b-4 ${accent} bg-white p-5 shadow-sm`
      }
    >
      <p className={`text-[11px] font-bold uppercase tracking-[0.18em] ${drenched ? "text-white/75" : "text-slate-500"}`}>
        {eyebrow}
      </p>
      <p className={`mt-2 text-3xl font-black tabular-nums ${drenched ? "text-white" : "text-slate-950"}`}>{value}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span
          className={
            drenched
              ? "rounded-full bg-white/15 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-white ring-1 ring-white/25"
              : "rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-slate-700 ring-1 ring-slate-200"
          }
        >
          {badge}
        </span>
        <span className={`text-[10px] font-bold uppercase tracking-wide ${drenched ? "text-white/70" : "text-slate-500"}`}>
          {caption}
        </span>
      </div>
    </div>
  );
}

function StageBadge({ stage }: { stage: CommissionStage }) {
  const meta = STAGE_META[stage];
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ring-1 ${meta.pill}`}>
      <span className={`h-2 w-2 rounded-sm ${meta.dot}`} />
      {meta.label}
    </span>
  );
}

function PipelineBar({ stageTotals }: { stageTotals: StageTotal[] }) {
  const total = stageTotals.reduce((sum, stage) => sum + stage.commission, 0);
  if (total <= 0) {
    return <div className="flex h-14 items-center justify-center rounded-md bg-slate-100 text-xs text-slate-500">No commission activity yet</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex h-14 w-full overflow-hidden rounded-md ring-1 ring-slate-200">
        {STAGE_ORDER.map((stageKey, index) => {
          const stage = stageTotals.find((item) => item.stageKey === stageKey) ?? EMPTY_DASHBOARD.stageTotals[index]!;
          if (stage.commission <= 0) return null;
          const widthPct = (stage.commission / total) * 100;
          return (
            <div
              key={stageKey}
              style={{ width: `${widthPct}%` }}
              className={`flex min-w-0 flex-col items-center justify-center ${STAGE_META[stageKey].bar} ${index > 0 ? "border-l border-white/40" : ""}`}
              title={`${STAGE_META[stageKey].label}: ${money(stage.commission)}`}
            >
              {widthPct > 8 ? (
                <>
                  <p className="text-xs font-black text-white drop-shadow-sm">{money(stage.commission, "compact")}</p>
                  <p className="text-[9px] font-bold uppercase tracking-wide text-white/90">{widthPct.toFixed(0)}%</p>
                </>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
        {STAGE_ORDER.map((stageKey, index) => {
          const stage = stageTotals.find((item) => item.stageKey === stageKey) ?? EMPTY_DASHBOARD.stageTotals[index]!;
          return (
            <div key={stageKey} className="space-y-1">
              <div className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-sm ${STAGE_META[stageKey].dot}`} />
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">{STAGE_META[stageKey].label}</p>
              </div>
              <p className="text-lg font-black tabular-nums text-slate-950">{money(stage.commission)}</p>
              <p className="text-[10px] font-semibold tabular-nums text-slate-500">{stage.percentOfTotal.toFixed(0)}% of total</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function RepCommissionsPage() {
  const [period, setPeriod] = useState<Period>("ytd");
  const [dashboard, setDashboard] = useState<CommissionDashboard>(EMPTY_DASHBOARD);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api<{ data: CommissionDashboard }>(`/commissions/dashboard?period=${period}`)
      .then((response) => {
        if (!alive) return;
        setDashboard(response.data);
      })
      .catch((err) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : "Failed to load commissions");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [period]);

  const groupedDeals = useMemo(
    () =>
      STAGE_ORDER.map((stage) => ({
        stage,
        deals: dashboard.deals.filter((deal) => deal.stageKey === stage),
      })),
    [dashboard.deals]
  );

  const visibleTotal = useMemo(
    () => Number(dashboard.deals.reduce((sum, deal) => sum + deal.commission, 0).toFixed(2)),
    [dashboard.deals]
  );
  const goalPct = dashboard.goal.percentToGoal;
  const goalLabel = dashboard.goal.amount > 0 ? `Goal ${money(dashboard.goal.amount, "compact")} ${period.toUpperCase()}` : "No rep goal configured";

  function exportCsv() {
    const csv = serializeRowsToCsv(csvRows(dashboard.deals));
    downloadTextFile(csv, buildReportExportFilename("Commissions", "csv"), "text/csv;charset=utf-8;");
  }

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-4xl font-black uppercase tracking-tight text-slate-950 md:text-5xl">Commissions</h1>
          <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.24em] text-slate-500">Your earnings · per project</p>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-slate-200 bg-white p-0.5" aria-label="Commission view">
          <button type="button" className="flex items-center gap-1.5 rounded-sm bg-slate-100 px-3 py-2 text-sm font-bold text-slate-950">
            <UserIcon className="h-4 w-4" />
            My commissions
          </button>
          <button
            type="button"
            disabled
            title="Team commissions are not available on the sales-rep commissions page."
            className="hidden items-center gap-1.5 rounded-sm px-3 py-2 text-sm font-bold text-slate-400 disabled:cursor-not-allowed md:flex"
          >
            <Users className="h-4 w-4" />
            Team commissions
          </button>
        </div>
      </section>

      <div className="flex items-center gap-1 self-start rounded-full bg-slate-100 p-1">
        {PERIODS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setPeriod(item.key)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors ${
              period === item.key ? "bg-brand-red text-white shadow-sm" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error ? <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3" aria-label="Commission KPI cards">
        <MetricCard
          eyebrow="Earned"
          value={loading ? "$0.00" : money(dashboard.summary.earned)}
          badge="Contract signed"
          caption="Locked in this period"
          tone="red"
        />
        <MetricCard
          eyebrow="In pipeline"
          value={loading ? "$0.00" : money(dashboard.summary.inPipeline)}
          badge={`${dashboard.summary.openDealCount} open deals`}
          caption="Potential, in flight"
          tone="blue"
        />
        <MetricCard
          eyebrow="Total potential"
          value={loading ? "$0.00" : money(dashboard.summary.totalPotential)}
          badge={percent(goalPct)}
          caption={goalLabel}
          tone="green"
        />
      </div>

      <Card className="rounded-lg border-slate-200 bg-white shadow-sm">
        <CardContent className="space-y-5 p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">Pipeline by stage</p>
              <p className="mt-1 text-3xl font-black tracking-tight text-slate-950">{money(dashboard.summary.totalPotential)}</p>
              <p className="mt-1 text-xs text-slate-500">
                {money(dashboard.summary.earned)} earned · {money(dashboard.summary.inPipeline)} still in flight
              </p>
            </div>
            <div className="flex items-center gap-3 text-sm">
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                <p className="font-bold tabular-nums text-slate-950">{money(dashboard.summary.earned)}</p>
                <p className="text-xs text-slate-500">earned</p>
              </div>
              <span className="h-4 w-px bg-slate-200" aria-hidden />
              <div className="flex items-center gap-1.5">
                <Target className="h-4 w-4 text-brand-red" />
                <p className="font-bold tabular-nums text-slate-950">{dashboard.goal.amount > 0 ? money(dashboard.goal.amount) : "No goal"}</p>
                <p className="text-xs text-slate-500">goal</p>
              </div>
            </div>
          </div>

          <PipelineBar stageTotals={dashboard.stageTotals} />

          <div className="rounded-md border border-slate-200 bg-slate-50/40 p-4">
            <div className="flex items-center gap-2">
              <Target className="h-4 w-4 text-brand-red" />
              <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-700">Goal progress</p>
              <p className="ml-auto text-xs font-semibold tabular-nums text-slate-700">
                {money(dashboard.summary.earned)} / {dashboard.goal.amount > 0 ? money(dashboard.goal.amount) : "No goal"} ({percent(goalPct)})
              </p>
            </div>
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-200">
              <div className="h-full rounded-full bg-gradient-to-r from-brand-red to-brand-red/70" style={{ width: `${Math.min(100, goalPct ?? 0)}%` }} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="overflow-hidden rounded-lg border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.16em] text-slate-950">Projects contributing</p>
            <p className="mt-0.5 text-xs text-slate-500">Commission updates as deal values and stages change</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={exportCsv}>
            <Download className="mr-1 h-4 w-4" />
            Export
          </Button>
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-[760px]">
            <div className="grid grid-cols-[minmax(0,1fr)_130px_80px_170px_24px] gap-x-4 border-b border-slate-100 px-5 py-2.5 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
              <div>Deal</div>
              <div className="text-right">Deal value</div>
              <div className="text-right">Rate</div>
              <div className="text-right">Commission</div>
              <div aria-hidden />
            </div>

            {loading ? (
              <div className="px-5 py-8 text-sm text-slate-500">Loading commissions...</div>
            ) : dashboard.deals.length === 0 ? (
              <div className="px-5 py-8 text-sm text-slate-500">No commission activity for this period.</div>
            ) : (
              <div className="divide-y divide-slate-100">
                {groupedDeals.map((group) => {
                  if (group.deals.length === 0) return null;
                  const groupTotal = group.deals.reduce((sum, deal) => sum + deal.commission, 0);
                  return (
                    <section key={group.stage}>
                      <div className="grid grid-cols-[minmax(0,1fr)_130px_80px_170px_24px] gap-x-4 bg-slate-50/40 px-5 py-2.5">
                        <div className="flex items-center gap-2">
                          <StageBadge stage={group.stage} />
                          <span className="hidden text-[10px] font-semibold text-slate-500 sm:inline">· {STAGE_META[group.stage].description}</span>
                        </div>
                        <div aria-hidden />
                        <div aria-hidden />
                        <p className="text-right text-xs font-black tabular-nums text-slate-950">{money(groupTotal)}</p>
                        <div aria-hidden />
                      </div>
                      <div className="divide-y divide-slate-100">
                        {group.deals.map((deal) => (
                          <Link
                            key={deal.dealId}
                            to={`/deals/${deal.dealId}`}
                            className="grid grid-cols-[minmax(0,1fr)_130px_80px_170px_24px] items-center gap-x-4 px-5 py-3 text-left transition-colors hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-brand-red/30"
                          >
                            <div className="min-w-0">
                              <p className="truncate font-bold text-slate-950">
                                {deal.dealNumber ? `${deal.dealNumber} · ` : ""}
                                {deal.dealName}
                              </p>
                              <p className="mt-0.5 truncate text-xs text-slate-500">
                                {[deal.companyName, deal.propertyName ?? deal.propertyAddress].filter(Boolean).join(" · ")}
                                {deal.isEarned
                                  ? ` · signed ${formatDate(deal.contractSignedDate)}`
                                  : ` · ${deal.expectedCloseDate ? `closes ${formatDate(deal.expectedCloseDate)} · ` : ""}${deal.daysInStage}d in stage`}
                              </p>
                            </div>
                            <p className="text-right text-sm font-semibold tabular-nums text-slate-700">{money(deal.dealValue)}</p>
                            <p className="text-right text-xs font-semibold tabular-nums text-slate-500">{(deal.commissionRate * 100).toFixed(1)}%</p>
                            <div className="text-right">
                              <p className="text-base font-black tabular-nums text-slate-950">{money(deal.commission)}</p>
                              {deal.deltaCommission != null ? (
                                <p className={`text-[10px] font-bold tabular-nums ${deal.deltaCommission > 0 ? "text-emerald-600" : "text-brand-red line-through decoration-brand-red/50"}`}>
                                  {deal.deltaCommission > 0 ? "+" : ""}
                                  {money(deal.deltaCommission)} since last update
                                </p>
                              ) : null}
                            </div>
                            <ChevronRight className="ml-auto h-4 w-4 text-slate-400" />
                          </Link>
                        ))}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_130px_80px_170px_24px] gap-x-4 border-t border-slate-200 bg-slate-50/40 px-5 py-3">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-700">Total</p>
          <div aria-hidden />
          <div aria-hidden />
          <p className="text-right text-lg font-black tabular-nums text-slate-950">{money(visibleTotal)}</p>
          <div aria-hidden />
        </div>
      </Card>
    </div>
  );
}
