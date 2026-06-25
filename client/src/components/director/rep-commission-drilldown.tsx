import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ChevronDown, ChevronRight, DollarSign, Eye, Lock } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { RepDetailData } from "@/hooks/use-director-dashboard";

// Commission amounts are cent-precision and this surface asserts a VISIBLE reconciliation (owner +
// estimator + override == total). The deal-utils formatter rounds to whole dollars, which would let the
// shown rows fail to sum to the shown total (e.g. $10.49 + $10.49 reads as $10 + $10 vs a $21 total). So
// commission $ render at cent precision here. NaN-safe ("--"), matching the deal-utils safety contract.
const USD_CENTS = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return USD_CENTS.format(value);
}

// Engine A (getRepCommissionDashboard) — the rep's OWN commission page payload, fetched read-only for
// the "View as rep" panel. Mirrors the shape rendered on /commissions (rep-commissions-page).
interface RepCommissionView {
  period: string;
  summary: {
    earned: number;
    inPipeline: number;
    totalPotential: number;
    openDealCount: number;
    wonAwaitingSignature: { dealCount: number; dealValue: number; potentialCommission: number };
  };
  stageTotals: Array<{
    stageKey: string;
    stageName: string;
    commission: number;
    dealValue: number;
    dealCount: number;
    percentOfTotal: number;
  }>;
  deals: Array<{
    dealId: string;
    dealName: string;
    dealNumber: string | null;
    companyName: string | null;
    commission: number;
    isEarned: boolean;
    stageName: string;
  }>;
}

interface Props {
  repId: string;
  repName: string;
  periodLabel: string;
  /**
   * True when the page's selected window is the SAME one the flat Team-Commissions list uses (YTD). Only
   * then does the breakdown total provably equal this rep's flat-list row, so we only claim the match here.
   */
  isFlatListWindow: boolean;
  dateRange: { from: string; to: string };
  commissionSummary: RepDetailData["commissionSummary"];
  commissionDeals: RepDetailData["commissionDeals"];
  wonMissingContractDate: RepDetailData["wonMissingContractDate"];
  /** Refetch the rep-detail payload after a contract date is set (commission recalculates server-side). */
  onDataChanged: () => void;
}

function RoleBadge({ role }: { role: "owner" | "estimator" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        role === "owner"
          ? "bg-slate-100 text-slate-700 ring-slate-200"
          : "bg-violet-50 text-violet-700 ring-violet-200"
      )}
    >
      {role === "owner" ? "Owner cut" : "Estimator cut"}
    </span>
  );
}

export function RepCommissionDrilldown({
  repId,
  repName,
  periodLabel,
  isFlatListWindow,
  dateRange,
  commissionSummary: cs,
  commissionDeals = [],
  wonMissingContractDate = [],
  onDataChanged,
}: Props) {
  const ownerCuts = commissionDeals.filter((d) => d.attributionRole === "owner");
  const estimatorCuts = commissionDeals.filter((d) => d.attributionRole === "estimator");
  const ownerTotal = ownerCuts.reduce((sum, d) => sum + d.earnedCommission, 0);
  const estimatorTotal = estimatorCuts.reduce((sum, d) => sum + d.earnedCommission, 0);

  // Uncommissioned: no commission rate AND nothing attributed — show an explicit notice rather than a
  // wall of $0 that reads as "broken". (A rate-0 rep can still earn estimator cuts on others' deals, so
  // only treat as uncommissioned when there's genuinely nothing.)
  const isUncommissioned =
    cs.commissionRate === 0 && commissionDeals.length === 0 && cs.totalEarnedCommission === 0;

  const floor = cs.rollingFloor;
  const hasFloor = floor > 0;
  // Never render a full bar while the floor is unmet: round DOWN and cap at 99% below floor, so the visual
  // can't contradict the "Below floor" copy (e.g. $99,600 / $100,000 must not read as 100%).
  const floorPct =
    !hasFloor || cs.floorMet
      ? 100
      : Math.max(0, Math.min(99, Math.floor((cs.qualifyingRevenue / floor) * 100)));
  const floorShortfall = Math.max(floor - cs.qualifyingRevenue, 0);

  // "View as rep" (Engine A) — lazy-loaded on expand; state lifted here so the panel renders as a normal
  // full-width block in the card body (no positioning hacks).
  const [viewOpen, setViewOpen] = useState(false);
  const [view, setView] = useState<RepCommissionView | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);

  // Fetch (and RE-fetch) the rep's own commission view whenever the panel is open and the window changes —
  // so switching the date preset for the same rep refreshes the panel instead of showing the prior period.
  useEffect(() => {
    if (!viewOpen) return;
    let cancelled = false;
    setViewLoading(true);
    setViewError(null);
    (async () => {
      try {
        const params = new URLSearchParams();
        if (dateRange.from) params.set("from", dateRange.from);
        if (dateRange.to) params.set("to", dateRange.to);
        const res = await api<{ data: RepCommissionView }>(
          `/dashboard/director/rep/${repId}/commission-view?${params.toString()}`
        );
        if (!cancelled) setView(res.data);
      } catch (err) {
        if (!cancelled) setViewError(err instanceof Error ? err.message : "Failed to load rep view");
      } finally {
        if (!cancelled) setViewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [viewOpen, dateRange.from, dateRange.to, repId]);

  const toggleView = () => setViewOpen((open) => !open);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <DollarSign className="h-4 w-4 text-emerald-600" />
          Commission Breakdown · {periodLabel}
        </CardTitle>
        <Button variant="outline" size="sm" onClick={toggleView}>
          <Eye className="mr-1 h-4 w-4" />
          {viewOpen ? "Hide rep view" : "View as rep"}
          {viewOpen ? <ChevronDown className="ml-1 h-4 w-4" /> : <ChevronRight className="ml-1 h-4 w-4" />}
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {isUncommissioned ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
            <span className="font-medium text-slate-700">Uncommissioned.</span> {repName} has no active
            commission rate, so no earnings are attributed for this period. Set a rate in commission
            settings to start tracking.
          </div>
        ) : (
          <>
            {/* Floor progress — makes "below floor" legible instead of a confusing blank $0. */}
            <FloorProgress
              hasFloor={hasFloor}
              floor={floor}
              floorMet={cs.floorMet}
              floorPct={floorPct}
              qualifyingRevenue={cs.qualifyingRevenue}
              floorShortfall={floorShortfall}
            />

            {/* Owner + estimator split → direct, + override → total. The total MUST equal the flat
                Team-Commissions list (both Engine B, same window). */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <SplitStat
                label="Owner cuts"
                value={ownerTotal}
                sub={`${ownerCuts.length} deal${ownerCuts.length === 1 ? "" : "s"}`}
              />
              <SplitStat
                label="Estimator cuts"
                value={estimatorTotal}
                sub={`${estimatorCuts.length} deal${estimatorCuts.length === 1 ? "" : "s"}`}
                accent="violet"
              />
              <SplitStat
                label="Manager override"
                value={cs.overrideEarnedCommission}
                sub={cs.overrideEarnedCommission > 0 ? "on reports" : "none"}
              />
              <SplitStat label="Total earned" value={cs.totalEarnedCommission} sub={periodLabel} strong />
            </div>
            <p className="text-xs text-slate-400">
              Owner + estimator = {formatUsd(cs.directEarnedCommission)} direct; + override ={" "}
              {formatUsd(cs.totalEarnedCommission)} total for {periodLabel}.
              {isFlatListWindow
                ? " Matches this rep's row on Team Commissions."
                : " (Team Commissions shows YTD.)"}
            </p>

            {/* Per-deal contributing rows. Below floor: rows stay visible with held ($0) earnings. */}
            {commissionDeals.length === 0 ? (
              <p className="text-sm text-slate-500">No contributing deals in this period.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-3 py-2 text-left">Deal</th>
                      <th className="px-3 py-2 text-left">Cut</th>
                      <th className="px-3 py-2 text-right">Won</th>
                    </tr>
                  </thead>
                  <tbody>
                    {commissionDeals.map((deal, i) => (
                      <tr
                        key={`${deal.dealId}-${deal.attributionRole}-${i}`}
                        className="border-b border-slate-100"
                      >
                        <td className="px-3 py-2">
                          <Link
                            to={`/deals/${deal.dealId}`}
                            className="font-medium text-slate-900 underline-offset-2 hover:underline"
                          >
                            {deal.dealName}
                          </Link>
                          <div className="text-xs text-slate-500">
                            {[deal.companyName, deal.propertyName].filter(Boolean).join(" · ") || "—"}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <RoleBadge role={deal.attributionRole} />
                        </td>
                        <td className="px-3 py-2 text-right font-semibold text-slate-900">
                          {formatUsd(deal.earnedCommission)}
                          {!cs.floorMet ? (
                            <span className="ml-1 text-xs font-normal text-amber-600">held</span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* View-as-rep panel (read-only Engine A) */}
        {viewOpen ? (
          <RepViewPanel repName={repName} view={view} loading={viewLoading} error={viewError} />
        ) : null}

        {/* Won-but-missing-contract-date worklist — stuck commissions the director can release. */}
        {wonMissingContractDate.length > 0 ? (
          <MissingContractWorklist deals={wonMissingContractDate} onDataChanged={onDataChanged} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function FloorProgress({
  hasFloor,
  floor,
  floorMet,
  floorPct,
  qualifyingRevenue,
  floorShortfall,
}: {
  hasFloor: boolean;
  floor: number;
  floorMet: boolean;
  floorPct: number;
  qualifyingRevenue: number;
  floorShortfall: number;
}) {
  if (!hasFloor) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
        No commission floor set — earnings are recognized from dollar one.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-slate-700">Floor progress</span>
        <span className={cn("font-semibold", floorMet ? "text-emerald-700" : "text-amber-700")}>
          {formatUsd(qualifyingRevenue)} of {formatUsd(floor)}
        </span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className={cn("h-full rounded-full transition-all", floorMet ? "bg-emerald-500" : "bg-amber-400")}
          style={{ width: `${floorPct}%` }}
        />
      </div>
      {floorMet ? (
        <p className="text-xs text-emerald-700">Floor cleared — earned commission is fully recognized.</p>
      ) : (
        <p className="flex items-center gap-1 text-xs text-amber-700">
          <Lock className="h-3 w-3" />
          Below floor — earnings held at $0. {formatUsd(floorShortfall)} more booked revenue needed.
        </p>
      )}
    </div>
  );
}

function SplitStat({
  label,
  value,
  sub,
  accent,
  strong,
}: {
  label: string;
  value: number;
  sub: string;
  accent?: "violet";
  strong?: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div
        className={cn(
          "mt-1 font-semibold",
          strong ? "text-lg text-slate-900" : "text-base",
          accent === "violet" ? "text-violet-700" : "text-slate-900"
        )}
      >
        {formatUsd(value)}
      </div>
      <div className="text-xs text-slate-400">{sub}</div>
    </div>
  );
}

function MissingContractWorklist({
  deals,
  onDataChanged,
}: {
  deals: RepDetailData["wonMissingContractDate"];
  onDataChanged: () => void;
}) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-amber-800">
        <AlertTriangle className="h-4 w-4" />
        Won, missing contract date ({deals.length})
      </div>
      <p className="mt-1 text-xs text-amber-700">
        These Won deals have no contract-signed date, so no commission was minted. Set the date to release it.
      </p>
      <div className="mt-3 space-y-2">
        {deals.map((deal) => (
          <MissingContractRow key={deal.dealId} deal={deal} onDataChanged={onDataChanged} />
        ))}
      </div>
    </div>
  );
}

function MissingContractRow({
  deal,
  onDataChanged,
}: {
  deal: RepDetailData["wonMissingContractDate"][number];
  onDataChanged: () => void;
}) {
  const [date, setDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError("Pick a date");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api(`/deals/${deal.dealId}/contract-signed-date`, {
        method: "PATCH",
        json: { date },
      });
      onDataChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set date");
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-amber-200 bg-white px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <Link
          to={`/deals/${deal.dealId}`}
          className="font-medium text-slate-900 underline-offset-2 hover:underline"
        >
          {deal.dealName}
        </Link>
        <div className="text-xs text-slate-500">
          {[deal.companyName, deal.propertyName].filter(Boolean).join(" · ") || "—"} ·{" "}
          {formatUsd(deal.value)}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="h-8 w-[9.5rem]"
          aria-label={`Contract signed date for ${deal.dealName}`}
          disabled={saving}
        />
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Set date"}
        </Button>
      </div>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </div>
  );
}

function RepViewPanel({
  repName,
  view,
  loading,
  error,
}: {
  repName: string;
  view: RepCommissionView | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-4">
      <div className="mb-3 flex items-center gap-2 rounded-md bg-white px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200">
        <Eye className="h-3.5 w-3.5" />
        Read-only — exactly what {repName} sees on their own Commissions page.
      </div>
      {loading ? (
        <p className="text-sm text-slate-500">Loading {repName}'s view…</p>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : view ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <SplitStat label="Won" value={view.summary.earned} sub="locked in" strong />
            <SplitStat
              label="In pipeline"
              value={view.summary.inPipeline}
              sub={`${view.summary.openDealCount} open`}
            />
            <SplitStat label="Total potential" value={view.summary.totalPotential} sub="earned + pipeline" />
          </div>
          {(view.summary.wonAwaitingSignature?.dealCount ?? 0) > 0 ? (
            <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
                  Won — awaiting contract signature
                </p>
                <p className="text-xs text-amber-600">
                  {view.summary.wonAwaitingSignature?.dealCount ?? 0} won deal
                  {(view.summary.wonAwaitingSignature?.dealCount ?? 0) === 1 ? "" : "s"} with no signed contract date
                  yet — no commission is booked until the contract date is set.
                </p>
              </div>
              <div className="text-right">
                <p className="text-lg font-bold tabular-nums text-amber-900">
                  {formatUsd(view.summary.wonAwaitingSignature?.dealValue ?? 0)}
                </p>
                <p className="text-xs text-amber-700">
                  {formatUsd(view.summary.wonAwaitingSignature?.potentialCommission ?? 0)} potential commission
                </p>
              </div>
            </div>
          ) : null}
          {view.stageTotals.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-3 py-2 text-left">Stage</th>
                    <th className="px-3 py-2 text-right">Deals</th>
                    <th className="px-3 py-2 text-right">Commission</th>
                  </tr>
                </thead>
                <tbody>
                  {view.stageTotals.map((stage) => (
                    <tr key={stage.stageKey} className="border-b border-slate-100">
                      <td className="px-3 py-2 text-slate-700">{stage.stageName}</td>
                      <td className="px-3 py-2 text-right text-slate-600">{stage.dealCount}</td>
                      <td className="px-3 py-2 text-right font-medium text-slate-900">
                        {formatUsd(stage.commission)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {/* The rep's contributing deals — the same list the rep sees on /commissions (earned + open
              pipeline), so "View as rep" is a faithful mirror rather than just the stage roll-up. */}
          {view.deals.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-3 py-2 text-left">Deal</th>
                    <th className="px-3 py-2 text-left">Stage</th>
                    <th className="px-3 py-2 text-right">Commission</th>
                  </tr>
                </thead>
                <tbody>
                  {view.deals.map((deal) => (
                    <tr key={deal.dealId} className="border-b border-slate-100">
                      <td className="px-3 py-2">
                        <Link
                          to={`/deals/${deal.dealId}`}
                          className="font-medium text-slate-900 underline-offset-2 hover:underline"
                        >
                          {deal.dealName}
                        </Link>
                        {deal.companyName ? (
                          <div className="text-xs text-slate-500">{deal.companyName}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
                            deal.isEarned
                              ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                              : "bg-slate-100 text-slate-600 ring-slate-200"
                          )}
                        >
                          {deal.isEarned ? "Won" : deal.stageName}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-medium text-slate-900">
                        {formatUsd(deal.commission)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
