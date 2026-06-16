// Reports shared evidence-kit: the palette, number/date formatters, and small visual primitives reused
// by the Monday showcase AND the Part-4 report views (Rep 1:1 Pack, Forecast Confidence, At-Risk) so they
// look like one system. Also re-exports the drill/drawer primitives so a new view wires evidence in one
// import. SINGLE source of the semantic palette — keep colors here, not duplicated per view.
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import type { ProjectionBand } from "./monday-showcase/types";
import { usd, int, signed } from "./format";

export { DrillProvider, DrillNumber, useDrill, DRILL_UNDERLINE } from "./monday-showcase/drill";
export { EvidenceDrawer } from "./monday-showcase/evidence-drawer";

// usd/int/signed are the null-guarded primitives from ./format; re-export so report views import them here.
export { usd, int, signed };

// Literal-day formatting (no UTC-midnight off-by-one), matching the app's date-only rendering (#572).
export function formatDayShort(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// Semantic palette: Won = emerald (money in), Sent = sky (in flight), Estimating = violet (upstream),
// Collected = slate (deferred), leads = amber. Reused across every report surface.
export type AccentKey = "estimating" | "sent" | "won" | "collected" | "leads";
export const ACCENT: Record<AccentKey, { text: string; soft: string; bar: string; ring: string; grad: string }> = {
  estimating: { text: "text-violet-700", soft: "bg-violet-50", bar: "bg-violet-500", ring: "ring-violet-200", grad: "from-violet-50" },
  sent: { text: "text-sky-700", soft: "bg-sky-50", bar: "bg-sky-500", ring: "ring-sky-200", grad: "from-sky-50" },
  won: { text: "text-emerald-700", soft: "bg-emerald-50", bar: "bg-emerald-500", ring: "ring-emerald-200", grad: "from-emerald-50" },
  collected: { text: "text-slate-400", soft: "bg-slate-50", bar: "bg-slate-300", ring: "ring-slate-200", grad: "from-slate-50" },
  leads: { text: "text-amber-700", soft: "bg-amber-50", bar: "bg-amber-500", ring: "ring-amber-200", grad: "from-amber-50" },
};

// Projection horizon: near = warm/urgent through far = cool.
export const BAND_BAR: Record<ProjectionBand, string> = {
  "0_30": "bg-emerald-500",
  "31_60": "bg-sky-500",
  "61_90": "bg-amber-500",
  beyond_90: "bg-slate-400",
};

export function DeltaChip({ delta, suffix = "WoW" }: { delta: number | null; suffix?: string }) {
  if (delta == null) return null;
  const up = delta > 0;
  const down = delta < 0;
  const tone = up
    ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
    : down
      ? "bg-rose-50 text-rose-700 ring-rose-200"
      : "bg-slate-100 text-slate-500 ring-slate-200";
  const Icon = up ? TrendingUp : down ? TrendingDown : Minus;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${tone}`}>
      <Icon className="h-3 w-3" />
      {signed(delta)} {suffix}
    </span>
  );
}

export function Sparkline({
  values,
  spikeIndex,
  barClass = "bg-sky-400",
  highlightLast = false,
  height = 48,
}: {
  values: number[];
  spikeIndex?: number;
  barClass?: string;
  highlightLast?: boolean;
  height?: number;
}) {
  const max = Math.max(1, ...values);
  const lastIdx = values.length - 1;
  return (
    <div className="flex items-end gap-1" style={{ height }} data-testid="sparkline" aria-hidden>
      {values.map((v, i) => {
        const isSpike = spikeIndex === i;
        const isLast = highlightLast && i === lastIdx;
        return (
          <div
            key={i}
            title={isSpike ? `${v} (backfill spike — excluded from averages)` : String(v)}
            className={`w-2.5 rounded-t transition-all ${isSpike ? "bg-amber-400" : barClass} ${isLast ? "opacity-100 ring-2 ring-slate-300 ring-offset-1" : "opacity-80"}`}
            style={{ height: `${Math.max(3, (v / max) * height)}px` }}
          />
        );
      })}
    </div>
  );
}
