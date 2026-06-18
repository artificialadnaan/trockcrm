import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  Search,
  Download,
  ArrowUpDown,
  TrendingUp,
  TrendingDown,
  CheckCircle2,
  Briefcase,
  User as UserIcon,
  Users,
  CalendarClock,
  DollarSign,
  Trophy,
  Target,
  Crown,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EYEBROW, MetricCard } from "./preview-shared";

type CommissionStage = "opportunity" | "estimating" | "estimate_sent" | "contract" | "won";

const stageMeta: Record<
  CommissionStage,
  { label: string; pill: string; barClass: string; legendDot: string; description: string }
> = {
  opportunity: {
    label: "Opportunity",
    pill: "bg-slate-100 text-slate-700 ring-slate-200",
    barClass: "bg-slate-300",
    legendDot: "bg-slate-300",
    description: "Earliest stage · uncertain",
  },
  estimating: {
    label: "Estimating",
    pill: "bg-amber-50 text-amber-700 ring-amber-200",
    barClass: "bg-amber-300",
    legendDot: "bg-amber-300",
    description: "Pricing in progress",
  },
  estimate_sent: {
    label: "Estimate Sent",
    pill: "bg-blue-50 text-blue-700 ring-blue-200",
    barClass: "bg-blue-400",
    legendDot: "bg-blue-400",
    description: "Awaiting client review",
  },
  contract: {
    label: "Contract",
    pill: "bg-brand-red/10 text-brand-red ring-brand-red/20",
    barClass: "bg-brand-red/70",
    legendDot: "bg-brand-red/70",
    description: "One signature away",
  },
  won: {
    label: "Won",
    pill: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    barClass: "bg-emerald-500",
    legendDot: "bg-emerald-500",
    description: "Contract signed · locked in",
  },
};

type CommissionDeal = {
  id: string;
  dealName: string;
  account: string;
  stage: CommissionStage;
  dealValue: number;
  commissionRate: number;
  commission: number;
  closeDate: string;
  contractSignedAt?: string;
  delta?: number; // change since last update
  daysInStage: number;
};

const myDeals: CommissionDeal[] = [
  { id: "d1", dealName: "Allen Sports Complex", account: "Allen ISD", stage: "won", dealValue: 100_000, commissionRate: 0.015, commission: 1_500, closeDate: "May 2", contractSignedAt: "May 2", daysInStage: 5 },
  { id: "d2", dealName: "Skyline Auditorium Closeout", account: "Dallas ISD", stage: "won", dealValue: 32_000, commissionRate: 0.015, commission: 480, closeDate: "Apr 24", contractSignedAt: "Apr 24", daysInStage: 13 },
  { id: "d3", dealName: "Garland Warehouse 14", account: "Garland Industrial", stage: "contract", dealValue: 305_000, commissionRate: 0.015, commission: 4_575, closeDate: "expected May 22", daysInStage: 7, delta: 75 },
  { id: "d4", dealName: "Frisco Distribution Center", account: "Frisco Logistics Co.", stage: "estimate_sent", dealValue: 1_120_000, commissionRate: 0.015, commission: 16_800, closeDate: "expected Jun 10", daysInStage: 4 },
  { id: "d5", dealName: "Plano Office Tower Re-Cover", account: "Plano Tower LP", stage: "estimating", dealValue: 320_000, commissionRate: 0.015, commission: 4_800, closeDate: "expected Jun 30", daysInStage: 9, delta: -120 },
  { id: "d6", dealName: "Dallas ISD Roof Replacement", account: "Dallas ISD", stage: "estimating", dealValue: 875_000, commissionRate: 0.015, commission: 13_125, closeDate: "expected Jul 18", daysInStage: 22, delta: 380 },
  { id: "d7", dealName: "Carrollton Logistics Hub", account: "Carrollton Properties", stage: "estimating", dealValue: 680_000, commissionRate: 0.015, commission: 10_200, closeDate: "expected Jul 5", daysInStage: 18 },
  { id: "d8", dealName: "Westlake Industrial Park", account: "Westlake Holdings", stage: "opportunity", dealValue: 410_000, commissionRate: 0.015, commission: 6_150, closeDate: "expected Aug 14", daysInStage: 4 },
  { id: "d9", dealName: "Mesquite Retail Center", account: "Mesquite RE Trust", stage: "opportunity", dealValue: 215_000, commissionRate: 0.015, commission: 3_225, closeDate: "expected Aug 28", daysInStage: 11 },
];

type TeamRep = {
  id: string;
  name: string;
  initials: string;
  region: string;
  earned: number;
  pipeline: number;
  segments: Record<CommissionStage, number>;
  activeDeals: number;
  winRate: number;
  goal: number;
};

const teamReps: TeamRep[] = [
  {
    id: "u1",
    name: "Brett Rios",
    initials: "BR",
    region: "Dallas-Fort Worth",
    earned: 1_980,
    pipeline: 58_875,
    segments: { won: 1_980, contract: 4_575, estimate_sent: 16_800, estimating: 28_125, opportunity: 9_375 },
    activeDeals: 9,
    winRate: 0.42,
    goal: 12_000,
  },
  {
    id: "u2",
    name: "Kevin Scott",
    initials: "KS",
    region: "North DFW",
    earned: 12_400,
    pipeline: 32_200,
    segments: { won: 12_400, contract: 8_600, estimate_sent: 7_200, estimating: 12_400, opportunity: 4_000 },
    activeDeals: 7,
    winRate: 0.55,
    goal: 12_000,
  },
  {
    id: "u3",
    name: "Chris Higginbotham",
    initials: "CH",
    region: "East Texas",
    earned: 8_120,
    pipeline: 24_800,
    segments: { won: 8_120, contract: 3_200, estimate_sent: 6_400, estimating: 10_400, opportunity: 4_800 },
    activeDeals: 6,
    winRate: 0.48,
    goal: 10_000,
  },
  {
    id: "u4",
    name: "Alex Koch",
    initials: "AK",
    region: "South DFW",
    earned: 5_440,
    pipeline: 18_600,
    segments: { won: 5_440, contract: 2_400, estimate_sent: 4_200, estimating: 8_000, opportunity: 4_000 },
    activeDeals: 5,
    winRate: 0.39,
    goal: 10_000,
  },
  {
    id: "u5",
    name: "Eric Williams",
    initials: "EW",
    region: "Central DFW",
    earned: 0,
    pipeline: 12_400,
    segments: { won: 0, contract: 0, estimate_sent: 1_200, estimating: 8_800, opportunity: 2_400 },
    activeDeals: 4,
    winRate: 0.0,
    goal: 8_000,
  },
];

function USD(value: number, compact = false): string {
  if (compact) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  }
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function CommissionBar({
  segments,
  variant = "full",
}: {
  segments: Record<CommissionStage, number>;
  variant?: "full" | "compact";
}) {
  const order: CommissionStage[] = ["won", "contract", "estimate_sent", "estimating", "opportunity"];
  const total = order.reduce((s, k) => s + segments[k], 0);
  const filtered = order.filter((k) => segments[k] > 0);
  if (total === 0) {
    return (
      <div className={`flex ${variant === "compact" ? "h-2" : "h-12"} items-center justify-center rounded-md bg-slate-100 text-xs text-slate-500`}>
        {variant === "full" ? "No commission activity yet" : null}
      </div>
    );
  }
  return (
    <div className={variant === "full" ? "space-y-4" : "space-y-1"}>
      <div
        className={`flex w-full overflow-hidden rounded-md ring-1 ring-slate-200 ${
          variant === "compact" ? "h-2" : "h-14"
        }`}
      >
        {filtered.map((stage, i) => {
          const value = segments[stage];
          const meta = stageMeta[stage];
          const widthPct = (value / total) * 100;
          return (
            <div
              key={stage}
              style={{ width: `${widthPct}%` }}
              className={`group relative flex flex-col items-center justify-center transition-all ${meta.barClass} ${
                i > 0 ? "border-l border-white/40" : ""
              }`}
              title={`${meta.label}: ${USD(value)}`}
            >
              {variant === "full" && widthPct > 8 ? (
                <>
                  <p className="text-xs font-black text-white drop-shadow-sm">{USD(value, true)}</p>
                  <p className="text-[9px] font-bold uppercase tracking-wide text-white/90">{meta.label}</p>
                </>
              ) : null}
            </div>
          );
        })}
      </div>
      {variant === "full" ? (
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
          {order.map((stage) => {
            const meta = stageMeta[stage];
            const value = segments[stage];
            const pct = total === 0 ? 0 : (value / total) * 100;
            return (
              <div key={stage} className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${meta.legendDot}`} />
                  <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">{meta.label}</p>
                </div>
                <p className="text-lg font-black tabular-nums text-slate-950">{USD(value)}</p>
                <p className="text-[10px] font-semibold tabular-nums text-slate-500">{pct.toFixed(0)}% of total</p>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function StagePill({ stage }: { stage: CommissionStage }) {
  const meta = stageMeta[stage];
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ring-1 ${meta.pill}`}>
      {meta.label}
    </span>
  );
}

function MyCommissions() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState<"MTD" | "QTD" | "YTD" | "All">("YTD");

  const segments = myDeals.reduce<Record<CommissionStage, number>>(
    (acc, d) => {
      acc[d.stage] += d.commission;
      return acc;
    },
    { opportunity: 0, estimating: 0, estimate_sent: 0, contract: 0, won: 0 }
  );

  const earned = segments.won;
  const pipeline = segments.opportunity + segments.estimating + segments.estimate_sent + segments.contract;
  const total = earned + pipeline;
  const goal = 12_000;
  const goalPct = (earned / goal) * 100;

  const groupedByStage = useMemo(() => {
    const order: CommissionStage[] = ["won", "contract", "estimate_sent", "estimating", "opportunity"];
    return order.map((stage) => ({
      stage,
      deals: myDeals.filter((d) => d.stage === stage),
    }));
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-1 rounded-full bg-slate-100 p-1 self-start">
        {(["MTD", "QTD", "YTD", "All"] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPeriod(p)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors ${
              period === p ? "bg-brand-red text-white shadow-sm" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {p}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MetricCard
          eyebrow="Won"
          value={USD(earned, true)}
          badge="contract signed"
          drenched
          caption="Locked in this period"
        />
        <MetricCard
          eyebrow="In pipeline"
          value={USD(pipeline, true)}
          badge={`${myDeals.length - groupedByStage[0]!.deals.length} open deals`}
          badgeTone="blue"
          caption="Potential, in flight"
          accent="blue"
        />
        <MetricCard
          eyebrow="Total potential"
          value={USD(total, true)}
          badge={`${(goalPct).toFixed(0)}% to goal`}
          badgeTone="green"
          caption={`Goal ${USD(goal, true)} ${period}`}
          accent="green"
        />
      </div>

      <Card>
        <CardContent className="space-y-5 p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className={EYEBROW}>Pipeline by stage</p>
              <p className="mt-1 text-3xl font-black tracking-tight text-slate-950">{USD(total)}</p>
              <p className="mt-1 text-xs text-slate-500">
                {USD(earned)} earned · {USD(pipeline)} still in flight
              </p>
            </div>
            <div className="flex items-center gap-3 text-sm">
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                <p className="font-bold text-slate-950 tabular-nums">{USD(earned)}</p>
                <p className="text-xs text-slate-500">earned</p>
              </div>
              <span className="h-4 w-px bg-slate-200" aria-hidden />
              <div className="flex items-center gap-1.5">
                <Target className="h-4 w-4 text-brand-red" />
                <p className="font-bold text-slate-950 tabular-nums">{USD(goal)}</p>
                <p className="text-xs text-slate-500">goal</p>
              </div>
            </div>
          </div>

          <CommissionBar segments={segments} />

          <div className="rounded-md border border-slate-200 bg-slate-50/40 p-4">
            <div className="flex items-center gap-2">
              <Target className="h-4 w-4 text-brand-red" />
              <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-700">Goal progress</p>
              <p className="ml-auto text-xs font-semibold text-slate-700 tabular-nums">
                {USD(earned)} / {USD(goal)} ({goalPct.toFixed(0)}%)
              </p>
            </div>
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-gradient-to-r from-brand-red to-brand-red/70"
                style={{ width: `${Math.min(100, goalPct)}%` }}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.16em] text-slate-950">Projects contributing</p>
            <p className="mt-0.5 text-xs text-slate-500">
              Commission updates as deal values and stages change
            </p>
          </div>
          <Button variant="outline" size="sm">
            <Download className="mr-1 h-4 w-4" />
            Export
          </Button>
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-[680px]">
            <div className="grid grid-cols-[minmax(0,1fr)_120px_70px_160px_24px] gap-x-4 border-b border-slate-100 px-5 py-2.5 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
              <div>Deal</div>
              <div className="text-right">Deal value</div>
              <div className="text-right">Rate</div>
              <div className="text-right">Commission</div>
              <div aria-hidden />
            </div>
            <div className="divide-y divide-slate-100">
              {groupedByStage.map((group) => {
                if (group.deals.length === 0) return null;
                const meta = stageMeta[group.stage];
                const groupTotal = group.deals.reduce((s, d) => s + d.commission, 0);
                return (
                  <section key={group.stage}>
                    <div className="grid grid-cols-[minmax(0,1fr)_120px_70px_160px_24px] gap-x-4 bg-slate-50/40 px-5 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className={`h-2.5 w-2.5 rounded-sm ${meta.legendDot}`} />
                        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-700">
                          {meta.label}
                        </p>
                        <span className="hidden text-[10px] font-semibold text-slate-500 sm:inline">
                          · {meta.description}
                        </span>
                      </div>
                      <div aria-hidden />
                      <div aria-hidden />
                      <p className="text-right text-xs font-black tabular-nums text-slate-950">
                        {USD(groupTotal)}
                      </p>
                      <div aria-hidden />
                    </div>
                    <div className="divide-y divide-slate-100">
                      {group.deals.map((d) => (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => navigate(`/deals/${d.id}`)}
                          className="grid w-full grid-cols-[minmax(0,1fr)_120px_70px_160px_24px] items-center gap-x-4 px-5 py-3 text-left transition-colors hover:bg-slate-50"
                        >
                          <div className="min-w-0">
                            <p className="truncate font-bold text-slate-950">{d.dealName}</p>
                            <p className="mt-0.5 truncate text-xs text-slate-500">
                              {d.account} ·{" "}
                              {d.stage === "won"
                                ? `signed ${d.contractSignedAt}`
                                : `closes ${d.closeDate} · ${d.daysInStage}d in stage`}
                            </p>
                          </div>
                          <p className="text-right text-sm font-semibold tabular-nums text-slate-700">
                            <span className="text-xs text-slate-500">deal</span> {USD(d.dealValue, true)}
                          </p>
                          <p className="text-right text-xs font-semibold tabular-nums text-slate-500">
                            {(d.commissionRate * 100).toFixed(1)}%
                          </p>
                          <div className="text-right">
                            <p className="text-base font-black tabular-nums text-slate-950">{USD(d.commission)}</p>
                            {d.delta != null && d.delta !== 0 ? (
                              <p
                                className={`text-[10px] font-bold tabular-nums ${
                                  d.delta > 0 ? "text-emerald-600" : "text-brand-red"
                                }`}
                              >
                                {d.delta > 0 ? "+" : ""}
                                {USD(d.delta)} since last update
                              </p>
                            ) : null}
                          </div>
                          <ChevronRight className="ml-auto h-4 w-4 text-slate-400" />
                        </button>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_120px_70px_160px_24px] gap-x-4 border-t border-slate-200 bg-slate-50/40 px-5 py-3">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-700">Total</p>
          <div aria-hidden />
          <div aria-hidden />
          <p className="text-right text-lg font-black tabular-nums text-slate-950">{USD(total)}</p>
          <div aria-hidden />
        </div>
      </Card>
    </div>
  );
}

function TeamCommissions() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState<"MTD" | "QTD" | "YTD" | "All">("YTD");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"earned" | "pipeline" | "goal">("earned");

  const filtered = useMemo(() => {
    return teamReps
      .filter((r) => {
        if (search.trim()) {
          const q = search.toLowerCase();
          return r.name.toLowerCase().includes(q) || r.region.toLowerCase().includes(q);
        }
        return true;
      })
      .sort((a, b) => {
        if (sortBy === "pipeline") return b.pipeline - a.pipeline;
        if (sortBy === "goal") return b.earned / b.goal - a.earned / a.goal;
        return b.earned - a.earned;
      });
  }, [search, sortBy]);

  const totalEarned = teamReps.reduce((s, r) => s + r.earned, 0);
  const totalPipeline = teamReps.reduce((s, r) => s + r.pipeline, 0);
  const totalGoal = teamReps.reduce((s, r) => s + r.goal, 0);
  const repsHittingGoal = teamReps.filter((r) => r.earned >= r.goal).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-1 rounded-full bg-slate-100 p-1 self-start">
        {(["MTD", "QTD", "YTD", "All"] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPeriod(p)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors ${
              period === p ? "bg-brand-red text-white shadow-sm" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {p}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MetricCard
          eyebrow="Team earned"
          value={USD(totalEarned, true)}
          badge={`${repsHittingGoal} of ${teamReps.length} hitting goal`}
          drenched
          caption={`${period} contract signed`}
        />
        <MetricCard
          eyebrow="Team pipeline"
          value={USD(totalPipeline, true)}
          badge={`${teamReps.reduce((s, r) => s + r.activeDeals, 0)} active deals`}
          badgeTone="blue"
          caption="Potential commissions"
          accent="blue"
        />
        <MetricCard
          eyebrow="Goal attainment"
          value={`${((totalEarned / totalGoal) * 100).toFixed(0)}%`}
          badge={`${USD(totalGoal - totalEarned, true)} to go`}
          badgeTone="green"
          caption={`Team goal ${USD(totalGoal, true)}`}
          accent="green"
        />
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.16em] text-slate-950">Rep leaderboard</p>
            <p className="mt-0.5 text-xs text-slate-500">Click a rep to drill into their commission detail</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-md bg-slate-100 px-3 py-2 lg:max-w-sm">
              <Search className="h-4 w-4 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search reps"
                className="flex-1 bg-transparent text-sm placeholder:text-slate-500 focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={() =>
                setSortBy((s) => (s === "earned" ? "pipeline" : s === "pipeline" ? "goal" : "earned"))
              }
              className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <ArrowUpDown className="h-3.5 w-3.5" />
              Sort: {sortBy === "earned" ? "Won" : sortBy === "pipeline" ? "Pipeline" : "Goal %"}
            </button>
            <Button variant="outline" size="sm">
              <Download className="mr-1 h-4 w-4" />
              Export
            </Button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px]">
            <thead>
              <tr className="border-b border-slate-100 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                <th className="px-5 py-3 text-left">Rep</th>
                <th className="px-5 py-3 text-right">Won</th>
                <th className="px-5 py-3 text-right">Pipeline</th>
                <th className="px-5 py-3 text-left">Stage breakdown</th>
                <th className="px-5 py-3 text-right">Active</th>
                <th className="px-5 py-3 text-right">Win rate</th>
                <th className="px-5 py-3 text-left">Goal</th>
                <th className="w-10 px-5 py-3" aria-hidden />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((rep, i) => {
                const goalPct = (rep.earned / rep.goal) * 100;
                const total = rep.earned + rep.pipeline;
                const isLeader = i === 0;
                return (
                  <tr
                    key={rep.id}
                    onClick={() => navigate(`/director/rep/${rep.id}`)}
                    className="cursor-pointer transition-colors hover:bg-slate-50"
                  >
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-red text-[11px] font-black uppercase text-white">
                          {rep.initials}
                        </div>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <p className="font-bold text-slate-950">{rep.name}</p>
                            {isLeader ? (
                              <Crown className="h-3.5 w-3.5 fill-amber-400 stroke-amber-500" aria-label="Leader" />
                            ) : null}
                          </div>
                          <p className="mt-0.5 text-xs text-slate-500">{rep.region}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-4 text-right">
                      <p className="text-base font-black tabular-nums text-slate-950">{USD(rep.earned)}</p>
                    </td>
                    <td className="px-5 py-4 text-right">
                      <p className="text-base font-black tabular-nums text-slate-700">{USD(rep.pipeline)}</p>
                      <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400 tabular-nums">
                        {USD(total, true)} total
                      </p>
                    </td>
                    <td className="px-5 py-4">
                      <div className="w-44">
                        <CommissionBar segments={rep.segments} variant="compact" />
                      </div>
                    </td>
                    <td className="px-5 py-4 text-right text-sm font-semibold tabular-nums text-slate-700">
                      {rep.activeDeals}
                    </td>
                    <td className="px-5 py-4 text-right">
                      <span className="inline-flex items-center gap-1 text-sm font-bold tabular-nums">
                        {rep.winRate >= 0.5 ? (
                          <TrendingUp className="h-3 w-3 text-emerald-500" />
                        ) : rep.winRate >= 0.3 ? null : (
                          <TrendingDown className="h-3 w-3 text-brand-red" />
                        )}
                        <span
                          className={
                            rep.winRate >= 0.5
                              ? "text-emerald-700"
                              : rep.winRate >= 0.3
                                ? "text-slate-700"
                                : "text-brand-red"
                          }
                        >
                          {(rep.winRate * 100).toFixed(0)}%
                        </span>
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-200">
                          <div
                            className={`h-full rounded-full ${
                              goalPct >= 100
                                ? "bg-emerald-500"
                                : goalPct >= 50
                                  ? "bg-brand-red"
                                  : "bg-amber-400"
                            }`}
                            style={{ width: `${Math.min(100, goalPct)}%` }}
                          />
                        </div>
                        <p
                          className={`text-xs font-bold tabular-nums ${
                            goalPct >= 100 ? "text-emerald-700" : "text-slate-700"
                          }`}
                        >
                          {goalPct.toFixed(0)}%
                        </p>
                      </div>
                    </td>
                    <td className="px-5 py-4 text-right">
                      <ChevronRight className="ml-auto h-4 w-4 text-slate-400" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-200 bg-slate-50/40">
                <td className="px-5 py-3 text-[11px] font-bold uppercase tracking-[0.16em] text-slate-700">
                  Team total
                </td>
                <td className="px-5 py-3 text-right text-base font-black tabular-nums text-slate-950">
                  {USD(totalEarned)}
                </td>
                <td className="px-5 py-3 text-right text-base font-black tabular-nums text-slate-700">
                  {USD(totalPipeline)}
                </td>
                <td colSpan={4} className="px-5 py-3" />
                <td className="px-5 py-3" />
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
    </div>
  );
}

type View = "mine" | "team";

export function CommissionsPreview() {
  const [view, setView] = useState<View>("mine");
  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-4xl font-black uppercase tracking-tight text-slate-950 md:text-5xl">Commissions</h1>
          <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.24em] text-slate-500">
            {view === "mine" ? "Your earnings · per project" : "Team performance · per rep"}
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-slate-200 bg-white p-0.5">
          {(
            [
              { key: "mine", label: "My commissions", icon: UserIcon },
              { key: "team", label: "Team commissions", icon: Users },
            ] as const
          ).map((v) => {
            const Icon = v.icon;
            const isActive = view === v.key;
            return (
              <button
                key={v.key}
                type="button"
                onClick={() => setView(v.key)}
                className={`flex items-center gap-1.5 rounded-sm px-3 py-2 text-sm font-bold transition-colors ${
                  isActive ? "bg-slate-100 text-slate-950" : "text-slate-500 hover:text-slate-900"
                }`}
              >
                <Icon className="h-4 w-4" />
                {v.label}
              </button>
            );
          })}
        </div>
      </section>

      {view === "mine" ? <MyCommissions /> : <TeamCommissions />}
    </div>
  );
}
