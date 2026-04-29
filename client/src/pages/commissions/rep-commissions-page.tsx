import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { PageHeader } from "@/components/layout/page-header";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { getChartColor } from "@/components/charts/chart-colors";

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const SHORT_USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

interface CommissionSummary {
  earnedMtd: number;
  earnedYtd: number;
  potentialPipeline: number;
  paidYtd: number;
}

interface StagePotential {
  stageId: string;
  stageName: string;
  stageSlug: string;
  displayOrder: number;
  dealCount: number;
  totalDealValue: number;
  potentialCommission: number;
}

interface EarnedMonth {
  month: string;
  earnedCommission: number;
  dealCount: number;
}

interface CommissionDeal {
  dealId: string;
  dealNumber: string | null;
  dealName: string;
  repId: string;
  repName: string;
  stageName: string;
  stageSlug: string;
  sourceValueAmount: number;
  appliedRate: number;
  earnedCommission: number;
  contractSignedDate: string | null;
  paidYtd: number;
}

const EMPTY_SUMMARY: CommissionSummary = {
  earnedMtd: 0,
  earnedYtd: 0,
  potentialPipeline: 0,
  paidYtd: 0,
};

function formatCurrency(value: number, compact = false) {
  return (compact ? SHORT_USD : USD).format(Number.isFinite(value) ? value : 0);
}

function currentYearRange() {
  const year = new Date().getFullYear();
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

function buildQuery(params: {
  from: string;
  to: string;
  repId: string;
  stages: string[];
}) {
  const query = new URLSearchParams();
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  if (params.repId) query.set("repId", params.repId);
  if (params.stages.length > 0) query.set("stages", params.stages.join(","));
  const qs = query.toString();
  return qs ? `?${qs}` : "";
}

export function RepCommissionsPage() {
  const { user } = useAuth();
  const defaults = useMemo(() => currentYearRange(), []);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [repId, setRepId] = useState("");
  const [selectedStages, setSelectedStages] = useState<string[]>([]);
  const [summary, setSummary] = useState<CommissionSummary>(EMPTY_SUMMARY);
  const [stageGroups, setStageGroups] = useState<StagePotential[]>([]);
  const [formula, setFormula] = useState("");
  const [months, setMonths] = useState<EarnedMonth[]>([]);
  const [deals, setDeals] = useState<CommissionDeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isRep = user?.role === "rep";
  const query = useMemo(
    () => buildQuery({ from, to, repId: isRep ? "" : repId, stages: selectedStages }),
    [from, isRep, repId, selectedStages, to]
  );

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);

    Promise.all([
      api<{ data: CommissionSummary }>(`/commissions/summary${query}`),
      api<{ data: { formula: string; stageGroups: StagePotential[] } }>(`/commissions/potential${query}`),
      api<{ data: { months: EarnedMonth[]; deals: CommissionDeal[] } }>(`/commissions/earned${query}`),
    ])
      .then(([summaryResponse, potentialResponse, earnedResponse]) => {
        if (!alive) return;
        setSummary(summaryResponse.data);
        setStageGroups(potentialResponse.data.stageGroups);
        setFormula(potentialResponse.data.formula);
        setMonths(earnedResponse.data.months);
        setDeals(earnedResponse.data.deals);
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
  }, [query]);

  const reps = useMemo(() => {
    const byId = new Map<string, string>();
    for (const deal of deals) byId.set(deal.repId, deal.repName);
    return [...byId.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [deals]);

  const visibleStages = stageGroups.length > 0 ? stageGroups : selectedStages.map((stage) => ({
    stageId: stage,
    stageName: stage,
    stageSlug: stage,
    displayOrder: 0,
    dealCount: 0,
    totalDealValue: 0,
    potentialCommission: 0,
  }));

  const rawDealSum = useMemo(
    () => Number(deals.reduce((sum, deal) => sum + deal.earnedCommission, 0).toFixed(2)),
    [deals]
  );
  const reconciliationMatches = Math.abs(rawDealSum - summary.earnedYtd) < 0.01;

  function toggleStage(stageSlug: string) {
    setSelectedStages((current) =>
      current.includes(stageSlug)
        ? current.filter((stage) => stage !== stageSlug)
        : [...current, stageSlug]
    );
  }

  const kpis = [
    { label: "Earned MTD", value: summary.earnedMtd },
    { label: "Earned YTD", value: summary.earnedYtd },
    { label: "Potential Pipeline", value: summary.potentialPipeline },
    { label: "Paid YTD", value: summary.paidYtd },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Sales"
        title="Commissions"
        description="Booked commission, potential pipeline, and contributing signed deals."
      />

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      <section className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 lg:grid-cols-[1fr_1fr_1.4fr_auto]">
        <label className="grid gap-1 text-xs font-medium uppercase tracking-[0.12em] text-slate-500">
          From
          <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label className="grid gap-1 text-xs font-medium uppercase tracking-[0.12em] text-slate-500">
          To
          <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
        <label className="grid gap-1 text-xs font-medium uppercase tracking-[0.12em] text-slate-500">
          Rep
          <select
            value={isRep ? user?.id ?? "" : repId}
            onChange={(event) => setRepId(event.target.value)}
            disabled={isRep}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm normal-case tracking-normal text-slate-900"
          >
            <option value="">{isRep ? user?.displayName ?? "My commissions" : "All reps"}</option>
            {reps.map((rep) => (
              <option key={rep.id} value={rep.id}>{rep.name}</option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          variant="outline"
          className="self-end"
          onClick={() => {
            setFrom(defaults.from);
            setTo(defaults.to);
            setRepId("");
            setSelectedStages([]);
          }}
        >
          Reset
        </Button>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="Commission KPI cards">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="rounded-lg border border-slate-200 bg-white p-4">
            <p className="text-xs uppercase tracking-[0.16em] text-slate-500">{kpi.label}</p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">
              {loading ? "..." : formatCurrency(kpi.value)}
            </p>
          </div>
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Potential by Stage</h2>
              <p className="mt-1 text-xs text-slate-500">{formula || "Potential uses active non-terminal deal value and rep commission settings."}</p>
            </div>
          </div>
          <div className="mt-4 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stageGroups}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="stageName" />
                <YAxis tickFormatter={(value) => formatCurrency(Number(value), true)} />
                <Tooltip formatter={(value) => formatCurrency(Number(value))} />
                <Legend />
                <Bar dataKey="potentialCommission" name="Potential" stackId="commission" fill={getChartColor(0)} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <h2 className="text-base font-semibold text-slate-900">Earned per Month</h2>
          <p className="mt-1 text-xs text-slate-500">Last 12 months from booked signed commissions.</p>
          <div className="mt-4 h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={months}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis tickFormatter={(value) => formatCurrency(Number(value), true)} />
                <Tooltip formatter={(value) => formatCurrency(Number(value))} />
                <Legend />
                <Line type="monotone" dataKey="earnedCommission" name="Earned" stroke={getChartColor(2)} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Contributing Deals</h2>
            <p className="mt-1 text-xs text-slate-500">
              Raw deal table sum: {formatCurrency(rawDealSum)}. API earned YTD: {formatCurrency(summary.earnedYtd)}.
              {" "}
              {reconciliationMatches ? "Reconciliation matches." : "Reconciliation mismatch."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {visibleStages.map((stage) => (
              <label key={stage.stageSlug} className="flex items-center gap-2 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={selectedStages.includes(stage.stageSlug)}
                  onChange={() => toggleStage(stage.stageSlug)}
                />
                {stage.stageName}
              </label>
            ))}
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-[0.12em] text-slate-500">
              <tr>
                <th className="px-3 py-2">Deal</th>
                <th className="px-3 py-2">Rep</th>
                <th className="px-3 py-2">Stage</th>
                <th className="px-3 py-2 text-right">Source Value</th>
                <th className="px-3 py-2 text-right">Rate</th>
                <th className="px-3 py-2 text-right">Earned</th>
                <th className="px-3 py-2 text-right">Paid YTD</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td className="px-3 py-4 text-slate-500" colSpan={7}>Loading deals...</td></tr>
              ) : deals.length === 0 ? (
                <tr><td className="px-3 py-4 text-slate-500" colSpan={7}>No contributing deals in this view.</td></tr>
              ) : (
                deals.map((deal) => (
                  <tr key={deal.dealId} className="align-top">
                    <td className="px-3 py-3">
                      <Link to={`/deals/${deal.dealId}`} className="font-medium text-slate-950 hover:underline">
                        {deal.dealNumber ? `${deal.dealNumber} - ` : ""}{deal.dealName}
                      </Link>
                      <p className="mt-1 text-xs text-slate-500">{deal.contractSignedDate ?? "No signed date"}</p>
                    </td>
                    <td className="px-3 py-3 text-slate-700">{deal.repName}</td>
                    <td className="px-3 py-3 text-slate-700">{deal.stageName}</td>
                    <td className="px-3 py-3 text-right text-slate-700">{formatCurrency(deal.sourceValueAmount)}</td>
                    <td className="px-3 py-3 text-right text-slate-700">{(deal.appliedRate * 100).toFixed(2)}%</td>
                    <td className="px-3 py-3 text-right font-semibold text-slate-950">{formatCurrency(deal.earnedCommission)}</td>
                    <td className="px-3 py-3 text-right text-slate-700">{formatCurrency(deal.paidYtd)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
