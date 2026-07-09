import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "@/components/layout/page-header";
import { useDirectorCommissionWorkspace, presetToDateRange } from "@/hooks/use-director-dashboard";
import type {
  CommissionDrillRequest,
  CommissionEvidenceMetric,
} from "@/hooks/use-director-dashboard";
import { CommissionEvidenceDrawer } from "./commission-evidence-drawer";
import { useTableSort, SortHeaderButton, type SortColumn } from "@/components/reports/sortable";
import { usdExact, int } from "@/pages/reports/format";

type Row = NonNullable<ReturnType<typeof useDirectorCommissionWorkspace>["data"]>["rows"][number];

const PERCENT = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const pct = (v: number) => PERCENT.format(Number.isFinite(v) ? v : 0);
// Bar fill % with a 2% sliver floor so a small-but-real value stays visible; 0 stays empty.
const barPct = (value: number, max: number) => (value <= 0 || max <= 0 ? 0 : Math.max(2, Math.round((value / max) * 100)));

const PRESETS = [
  { key: "mtd", label: "MTD" },
  { key: "qtd", label: "QTD" },
  { key: "ytd", label: "YTD" },
] as const;
type PresetKey = (typeof PRESETS)[number]["key"];

// ── a clickable number that opens the drill drawer (sky for counts, emerald for money) ──
function Drill({
  row, metric, money, zeroDim, onDrill, children,
}: {
  row: Row;
  metric: CommissionEvidenceMetric;
  money?: boolean;
  zeroDim?: boolean; // render dimmed + non-clickable when the underlying number is 0
  onDrill: (req: CommissionDrillRequest) => void;
  children: ReactNode;
}) {
  if (zeroDim) return <span className="tabular-nums text-slate-300">{children}</span>;
  return (
    <button
      type="button"
      onClick={() => onDrill({ repId: row.repId, repName: row.repName, metric })}
      className={`group cursor-pointer tabular-nums font-semibold ${money ? "text-emerald-700" : "text-sky-700"}`}
      title="Click to see the records behind this number"
    >
      <span className="group-hover:underline">{children}</span>
    </button>
  );
}

// The Earned cell shows the PAYABLE total, EXCEPT a pure below-floor row — nothing payable yet but real
// commission withheld — which shows its held amount with a "held" badge. A below-floor rep who still has a
// payable manager override has totalEarnedCommission > 0 (override is not gated), so it falls through to the
// normal payable display rather than hiding the override behind the held badge. The held branch, the cell
// display, and the sort accessor all read these helpers so the column sorts by the number the director sees.
function isHeldOnly(r: Row): boolean {
  return !r.floorMet && r.totalEarnedCommission === 0 && r.heldEarnedCommission > 0;
}
function displayedEarned(r: Row): number {
  return isHeldOnly(r) ? r.heldEarnedCommission : r.totalEarnedCommission;
}
// Reserved = the rep's accrued commission on ALL won work: signed (earned/held-aware) commission + projected
// commission on their won-but-unsigned deals. One figure. The floor "held" badge still rides on the
// signed/earned portion (see the cell). Note the mixed window: the signed part is period-windowed, the
// unsigned part is a live snapshot — surfaced in the caption under the period toggle.
function reserved(r: Row): number {
  return displayedEarned(r) + r.wonUnsignedCommission;
}

function KpiCard({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-white p-4">
      <span className={`absolute inset-y-0 left-0 w-1 ${tone}`} />
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-extrabold tabular-nums text-slate-800">{value}</div>
    </div>
  );
}

export function TeamCommissionsPage() {
  const [preset, setPreset] = useState<PresetKey>("ytd");
  const range = useMemo(() => presetToDateRange(preset), [preset]);
  const { data, loading, error } = useDirectorCommissionWorkspace(range);
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const [drill, setDrill] = useState<CommissionDrillRequest | null>(null);
  const onDrill = (req: CommissionDrillRequest) => setDrill({ ...req, from: range.from, to: range.to });

  // Earned + potential are ADDITIVE commission cuts (owner + estimator each earn separately) — their team
  // total legitimately sums the rows. The deal-VALUE totals (pipeline, active, won·unsigned) come from
  // officeTotals, which counts each deal ONCE — summing the involvement rows would double-count a deal that
  // has a distinct owner+estimator (e.g. Sidney/Alex as estimator).
  // Earned sums displayedEarned (NOT totalEarnedCommission) so the KPI + footer reconcile with the column:
  // a held-only row shows its held amount in the cell, so it must contribute that same held amount to the
  // total — otherwise a team of all-held rows shows $X in the column but $0 in the card/footer (the very
  // "$0 reads as earned nothing" contradiction the held display exists to remove).
  const additive = useMemo(() => rows.reduce(
    (a, r) => ({
      earned: a.earned + displayedEarned(r),
      wonUnsignedCommission: a.wonUnsignedCommission + r.wonUnsignedCommission,
      potential: a.potential + r.potentialCommission,
      activities: a.activities + r.totalActivities,
    }),
    { earned: 0, wonUnsignedCommission: 0, potential: 0, activities: 0 },
  ), [rows]);
  const office = data?.officeTotals ?? { activeDeals: 0, pipelineValue: 0, wonUnsignedValue: 0, wonUnsignedCount: 0, wonSignedValue: 0, wonSignedCount: 0 };
  const maxPipeline = useMemo(() => rows.reduce((m, r) => Math.max(m, r.pipelineValue), 0), [rows]);
  // Won·signed / Won·unsigned can have $0 value but real deals (no awarded/bid/DD amount). Surface the count
  // in the KPI + footer total so a bare "$0.00" doesn't hide N wins — mirrors the per-row cell.
  const withCount = (value: number, count: number) =>
    value === 0 && count > 0 ? `${usdExact(value)} (${count})` : usdExact(value);
  const wonUnsignedLabel = withCount;
  const wonSignedLabel = withCount;

  // Sortable columns (sort keys cover every visible figure; compound cells sort by a representative total).
  const sortCols: SortColumn<Row>[] = [
    { key: "rep", type: "text", accessor: (r) => r.repName },
    // Reserved sorts by the DISPLAYED combined figure (signed/held-aware earned + unsigned commission).
    { key: "earned", type: "number", accessor: (r) => reserved(r) },
    // Tie-break equal values by deal count so a zero-value-but-counted won row (a won deal with no
    // awarded/bid/DD amount) outranks a truly-empty row instead of collapsing to the same position.
    { key: "wonsigned", type: "number", accessor: (r) => r.wonSignedValue, compare: (a, b) => (a.wonSignedValue - b.wonSignedValue) || (a.wonSignedCount - b.wonSignedCount) },
    { key: "wonunsigned", type: "number", accessor: (r) => r.wonUnsignedValue, compare: (a, b) => (a.wonUnsignedValue - b.wonUnsignedValue) || (a.wonUnsignedCount - b.wonUnsignedCount) },
    { key: "potential", type: "number", accessor: (r) => r.potentialCommission },
    { key: "pipeline", type: "number", accessor: (r) => r.pipelineValue },
    { key: "funnel", type: "number", accessor: (r) => r.leads + r.qualifiedLeads + r.opportunities },
    { key: "estimating", type: "number", accessor: (r) => r.estimating },
    { key: "active", type: "number", accessor: (r) => r.activeDeals },
    { key: "activity", type: "number", accessor: (r) => r.totalActivities },
    { key: "newmix", type: "number", accessor: (r) => r.newCustomerShare },
  ];
  const { sortedRows, toggle, getHeaderProps } = useTableSort(rows, sortCols, { initialSort: { key: "pipeline", dir: "desc" } });

  const HEAD = "text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500";
  const sortHead = (key: string, label: string, numeric = true) => {
    const hp = getHeaderProps(key);
    return (
      <th className={`px-3 py-2.5 ${numeric ? "text-right" : "text-left"}`} aria-sort={hp.active ? (hp.dir === "asc" ? "ascending" : "descending") : "none"}>
        <SortHeaderButton label={label} numeric={numeric} active={hp.active} dir={hp.dir} onClick={() => toggle(key)} className={HEAD} />
      </th>
    );
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Director"
        title="Team Commissions"
        description="Earned commission, open pipeline, funnel mix and activity per rep. Click any number to see the deals, leads or activities behind it."
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex overflow-hidden rounded-lg border border-slate-200 bg-white">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPreset(p.key)}
              className={`px-3 py-1.5 text-xs font-semibold ${preset === p.key ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-50"}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <span className="max-w-md text-right text-[11px] text-slate-400">
          Reserved (signed commission), Won&nbsp;·&nbsp;signed &amp; activity are period-windowed; pipeline,
          potential, funnel &amp; Won&nbsp;·&nbsp;unsigned are live snapshots. Reserved also folds in live
          unsigned commission. Deal-value totals count each deal once; rep rows credit both owner and estimator,
          so the columns sum higher.
        </span>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      ) : null}

      {/* Team totals — Reserved/potential sum the rows (additive commission cuts); pipeline/active/won·signed/
          won·unsigned count each deal once (officeTotals). Reserved = Σ(earned) + Σ(unsigned commission). */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <KpiCard label="Reserved" value={usdExact(additive.earned + additive.wonUnsignedCommission)} tone="bg-emerald-500" />
        <KpiCard label="Potential commission" value={usdExact(additive.potential)} tone="bg-sky-500" />
        <KpiCard label="Won · signed" value={wonSignedLabel(office.wonSignedValue, office.wonSignedCount)} tone="bg-teal-500" />
        <KpiCard label="Won · unsigned" value={wonUnsignedLabel(office.wonUnsignedValue, office.wonUnsignedCount)} tone="bg-cyan-500" />
        <KpiCard label="Open pipeline" value={usdExact(office.pipelineValue)} tone="bg-violet-500" />
        <KpiCard label="Active deals" value={int(office.activeDeals)} tone="bg-amber-500" />
      </div>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {loading ? (
          <p className="px-5 py-6 text-sm text-slate-500">Loading team commissions…</p>
        ) : rows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">No reps found for commission reporting.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50">
                <tr className="border-b border-slate-200">
                  {sortHead("rep", "Rep", false)}
                  {sortHead("earned", "Reserved")}
                  {sortHead("wonsigned", "Won · signed")}
                  {sortHead("wonunsigned", "Won · unsigned")}
                  {sortHead("potential", "Potential")}
                  {sortHead("pipeline", "Pipeline")}
                  {sortHead("funnel", "L / Q / O")}
                  {sortHead("estimating", "Estimating")}
                  <th className={`px-3 py-2.5 text-right ${HEAD}`}>Calls / Emails / Mtgs</th>
                  {sortHead("active", "Active")}
                  {sortHead("activity", "Activity")}
                  {sortHead("newmix", "New Mix")}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sortedRows.map((row) => (
                  <tr key={row.repId} className="hover:bg-slate-50/60">
                    <td className="px-3 py-2.5">
                      {row.isRep ? (
                        <Link to={`/director/rep/${row.repId}`} className="font-semibold text-slate-900 underline-offset-2 hover:underline">
                          {row.repName}
                        </Link>
                      ) : (
                        // A non-rep source row (e.g. a director) is earned-only here; the rep-detail page is
                        // rep-centric and would show their owned deals, so render the name un-linked.
                        <span className="font-semibold text-slate-900">{row.repName}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {/* Reserved = signed (earned/held-aware) commission + unsigned commission. The drill opens
                          the EARNED (signed-commission) evidence only — the unsigned portion has no per-deal
                          booked records — so the drawer total reflects the signed part, not the full cell. */}
                      {isHeldOnly(row) ? (
                        // Below floor with nothing payable from the signed side: the earned commission is
                        // WITHHELD, not zero. Show the full reserve (held earned + unsigned commission) so a
                        // director doesn't read a bare $0 as "reserved nothing"; floorRemaining is how much more
                        // booked revenue clears the floor. Drillable to the earned deals; the badge carries the
                        // amber "held" cue for the signed portion.
                        <span
                          className="inline-flex flex-col items-end"
                          title={`Held below floor — ${usdExact(row.floorRemaining)} more booked revenue clears the signed commission`}
                        >
                          <Drill row={row} metric="earned" money onDrill={onDrill}>
                            {usdExact(reserved(row))}
                          </Drill>
                          <span className="mt-0.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-200">
                            held · {usdExact(row.floorRemaining)} to floor
                          </span>
                        </span>
                      ) : (
                        // Payable/normal: signed commission (incl. any not-gated manager override) + unsigned.
                        <Drill row={row} metric="earned" money zeroDim={reserved(row) === 0} onDrill={onDrill}>{usdExact(reserved(row))}</Drill>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {/* Gross value of this rep's WON + contract-SIGNED deals (period-windowed on the signed
                          date). Mirrors won·unsigned: drills on COUNT so a won·signed deal with no awarded/bid/DD
                          amount (value 0) still surfaces its count instead of being hidden. */}
                      <Drill row={row} metric="won_signed" money zeroDim={row.wonSignedCount === 0} onDrill={onDrill}>
                        {usdExact(row.wonSignedValue)}
                        {row.wonSignedValue === 0 && row.wonSignedCount > 0 ? <span className="ml-1 text-[10px] font-normal text-slate-400">({row.wonSignedCount})</span> : null}
                      </Drill>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {/* Drill on COUNT, not value: a won·unsigned deal can lack an awarded/bid/DD amount
                          (value 0) yet still exist — gating on value would hide it, and this is its only surface. */}
                      <Drill row={row} metric="won_unsigned" money zeroDim={row.wonUnsignedCount === 0} onDrill={onDrill}>
                        {usdExact(row.wonUnsignedValue)}
                        {row.wonUnsignedValue === 0 && row.wonUnsignedCount > 0 ? <span className="ml-1 text-[10px] font-normal text-slate-400">({row.wonUnsignedCount})</span> : null}
                      </Drill>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Drill row={row} metric="potential" money zeroDim={row.potentialCommission === 0} onDrill={onDrill}>{usdExact(row.potentialCommission)}</Drill>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-2">
                        <Drill row={row} metric="pipeline" money zeroDim={row.pipelineValue === 0} onDrill={onDrill}>{usdExact(row.pipelineValue)}</Drill>
                        <div className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-slate-100 sm:block">
                          <div className="h-full rounded-full bg-violet-400" style={{ width: `${barPct(row.pipelineValue, maxPipeline)}%` }} />
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <span className="inline-flex items-center gap-1 tabular-nums">
                        <Drill row={row} metric="leads" zeroDim={row.leads === 0} onDrill={onDrill}>{row.leads}</Drill>
                        <span className="text-slate-300">/</span>
                        <Drill row={row} metric="qualified" zeroDim={row.qualifiedLeads === 0} onDrill={onDrill}>{row.qualifiedLeads}</Drill>
                        <span className="text-slate-300">/</span>
                        <Drill row={row} metric="opportunities" zeroDim={row.opportunities === 0} onDrill={onDrill}>{row.opportunities}</Drill>
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Drill row={row} metric="estimating" zeroDim={row.estimating === 0} onDrill={onDrill}>{int(row.estimating)}</Drill>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <span className="inline-flex items-center gap-1 tabular-nums">
                        <Drill row={row} metric="calls" zeroDim={row.calls === 0} onDrill={onDrill}>{row.calls}</Drill>
                        <span className="text-slate-300">/</span>
                        <Drill row={row} metric="emails" zeroDim={row.emails === 0} onDrill={onDrill}>{row.emails}</Drill>
                        <span className="text-slate-300">/</span>
                        <Drill row={row} metric="meetings" zeroDim={row.meetings === 0} onDrill={onDrill}>{row.meetings}</Drill>
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Drill row={row} metric="active" zeroDim={row.activeDeals === 0} onDrill={onDrill}>{int(row.activeDeals)}</Drill>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{int(row.totalActivities)}</td>
                    <td className="px-3 py-2.5 text-right">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${row.meetsNewCustomerShare ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                        {pct(row.newCustomerShare)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-300 bg-slate-50 font-black tabular-nums text-slate-800">
                  <td className="px-3 py-2.5 text-left uppercase tracking-wide text-[11px] text-slate-500">Team total</td>
                  {/* Reserved total = additive earned + additive unsigned commission (both are per-rep cuts). */}
                  <td className="px-3 py-2.5 text-right text-emerald-700">{usdExact(additive.earned + additive.wonUnsignedCommission)}</td>
                  <td className="px-3 py-2.5 text-right">{wonSignedLabel(office.wonSignedValue, office.wonSignedCount)}</td>
                  <td className="px-3 py-2.5 text-right">{wonUnsignedLabel(office.wonUnsignedValue, office.wonUnsignedCount)}</td>
                  <td className="px-3 py-2.5 text-right">{usdExact(additive.potential)}</td>
                  <td className="px-3 py-2.5 text-right">{usdExact(office.pipelineValue)}</td>
                  <td className="px-3 py-2.5" />
                  <td className="px-3 py-2.5" />
                  <td className="px-3 py-2.5" />
                  <td className="px-3 py-2.5 text-right">{int(office.activeDeals)}</td>
                  <td className="px-3 py-2.5 text-right">{int(additive.activities)}</td>
                  <td className="px-3 py-2.5" />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      <CommissionEvidenceDrawer request={drill} onClose={() => setDrill(null)} />
    </div>
  );
}
