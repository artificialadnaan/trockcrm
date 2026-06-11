import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { cn } from "@/lib/utils";
import { usePlatformUsageReport, formatActiveTime, type PlatformUsageRow } from "@/hooks/use-platform-usage-report";

// A rep at or below this many actions for the period is flagged as "gone dark".
const LOW_ACTIVITY_THRESHOLD = 5;
// Fraction of the roster active for the reps-active card to read as healthy (green) vs alarm (red).
const HEALTHY_ACTIVE_RATIO = 0.5;

// Shared column template — header and rows must stay in lockstep.
const GRID = "grid grid-cols-[2rem_minmax(0,1fr)_5.5rem_5rem_4.5rem] items-center gap-3";

export function PlatformUsagePage() {
  // Initialize the period (and office) from the URL so the rep-detail back link round-trips to the
  // same view the user was on. Subsequent toggles update local state; the detail link re-emits them.
  const [searchParams] = useSearchParams();
  const officeId = searchParams.get("officeId");
  const [grain, setGrain] = useState<"day" | "week">(() => (searchParams.get("grain") === "day" ? "day" : "week"));
  const [anchorDate, setAnchorDate] = useState<string>(() => searchParams.get("date") ?? "");
  const { data, loading, error } = usePlatformUsageReport({ grain, date: anchorDate || undefined });

  // Headline ranking is by Actions desc — the proportion bars make 46-vs-0 read at a glance.
  const rows = useMemo<PlatformUsageRow[]>(() => {
    if (!data) return [];
    return [...data.leaderboard].sort((a, b) => b.usage.actionCount - a.usage.actionCount);
  }, [data]);
  const maxActions = useMemo(() => rows.reduce((m, r) => Math.max(m, r.usage.actionCount), 0), [rows]);

  // Clicking a rep row opens their detail, carrying the current period (grain/date) AND the active
  // office (?officeId) so the detail is scoped to the same office the leaderboard is showing — the
  // api client reads ?officeId into the x-office-id header.
  const detailHref = (repId: string) => {
    const qs = new URLSearchParams({ grain });
    if (anchorDate) qs.set("date", anchorDate);
    if (officeId) qs.set("officeId", officeId);
    return `/reports/performance/platform-usage/${repId}?${qs.toString()}`;
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <PageHeader
          eyebrow="Performance"
          title="Platform Usage"
          description="Active time, actions, and views per rep — daily and weekly."
        />
        {/* Brand title rule (accent only) */}
        <div className="h-1 w-14 rounded-full bg-gradient-to-r from-[#CC0000] to-[#790000]" />
      </div>

      {/* Controls — grain toggle, date nav, today (behavior unchanged) */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-lg border border-slate-200">
          <button
            type="button"
            onClick={() => setGrain("day")}
            aria-pressed={grain === "day"}
            className={cn(
              "px-3 py-1.5 text-sm font-semibold transition-colors",
              grain === "day" ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-50",
            )}
          >
            Daily
          </button>
          <button
            type="button"
            onClick={() => setGrain("week")}
            aria-pressed={grain === "week"}
            className={cn(
              "px-3 py-1.5 text-sm font-semibold transition-colors",
              grain === "week" ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-50",
            )}
          >
            Weekly
          </button>
        </div>
        <input
          type="date"
          value={anchorDate}
          onChange={(e) => setAnchorDate(e.target.value)}
          aria-label="Report date"
          className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700"
        />
        <button
          type="button"
          onClick={() => setAnchorDate("")}
          className="rounded-lg px-2.5 py-1.5 text-sm font-semibold text-slate-500 hover:text-slate-900"
        >
          Today
        </button>
      </div>

      {loading ? <div className="text-sm text-slate-500">Loading…</div> : null}
      {error ? (
        <div className="rounded-lg border border-brand-red/30 bg-brand-red/5 px-3 py-2 text-sm text-brand-red">{error}</div>
      ) : null}

      {data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <MetricCard
              label="Active time"
              value={formatActiveTime(data.summary.activeSeconds)}
              muted={data.summary.activeSeconds === 0}
            />
            <MetricCard label="Actions" value={String(data.summary.actionCount)} />
            <RepsActiveCard active={data.summary.activeReps} total={data.summary.totalReps} />
          </div>

          <Leaderboard rows={rows} maxActions={maxActions} detailHref={detailHref} />

          <p className="text-xs leading-relaxed text-slate-400">
            Sessions and Views show <span className="font-medium text-slate-500">—</span> until telemetry is
            populated; pre-launch days show "—" for time and views. Impersonated stage changes, logged activities,
            and uploads attribute to the impersonated rep (time and views are excluded).
          </p>
        </>
      ) : null}
    </div>
  );
}

function MetricCard({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className={cn("mt-1 text-3xl font-black tabular-nums", muted ? "text-slate-300" : "text-slate-900")}>
        {value}
      </div>
    </div>
  );
}

/**
 * The most actionable number on the page — and the loudest. Red/danger treatment when the roster is
 * quiet or under-active, green/success when a healthy fraction is active.
 */
function RepsActiveCard({ active, total }: { active: number; total: number }) {
  const ratio = total > 0 ? active / total : 0;
  const healthy = ratio >= HEALTHY_ACTIVE_RATIO;
  const status = healthy ? "Healthy" : active === 0 ? "All quiet" : "Low";
  return (
    <div
      className={cn(
        "rounded-xl border-l-4 p-4",
        healthy ? "border-emerald-500 bg-emerald-50" : "border-brand-red bg-[#FCEBEB]",
      )}
    >
      <div
        className={cn(
          "text-xs font-semibold uppercase tracking-wide",
          healthy ? "text-emerald-700" : "text-[#791F1F]/70",
        )}
      >
        Reps active
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={cn("text-3xl font-black tabular-nums", healthy ? "text-emerald-800" : "text-[#791F1F]")}>
          {active}/{total}
        </span>
        <span
          className={cn(
            "text-xs font-bold uppercase tracking-wide",
            healthy ? "text-emerald-700" : "text-[#791F1F]/80",
          )}
        >
          {status}
        </span>
      </div>
    </div>
  );
}

function Leaderboard({
  rows,
  maxActions,
  detailHref,
}: {
  rows: PlatformUsageRow[];
  maxActions: number;
  detailHref: (repId: string) => string;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
        No reps to show for this period.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div
        className={cn(
          GRID,
          "border-b border-slate-100 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400",
        )}
      >
        <div>#</div>
        <div>Rep · Actions</div>
        <div className="text-right">Active</div>
        <div className="text-right">Sessions</div>
        <div className="text-right">Views</div>
      </div>
      <div className="divide-y divide-slate-50">
        {rows.map((r, i) => (
          <RepRow
            key={r.rep.id}
            row={r}
            rank={i + 1}
            maxActions={maxActions}
            isTop={i === 0 && r.usage.actionCount > 0}
            href={detailHref(r.rep.id)}
          />
        ))}
      </div>
    </div>
  );
}

function RepRow({
  row,
  rank,
  maxActions,
  isTop,
  href,
}: {
  row: PlatformUsageRow;
  rank: number;
  maxActions: number;
  isTop: boolean;
  href: string;
}) {
  const u = row.usage;
  const low = u.actionCount <= LOW_ACTIVITY_THRESHOLD;
  const pct = barWidthPct(u.actionCount, maxActions);
  return (
    <Link to={href} className={cn(GRID, "px-4 py-3 transition-colors hover:bg-slate-50/70")}>
      <div className={cn("text-sm font-bold tabular-nums", isTop ? "text-brand-red" : "text-slate-300")}>{rank}</div>

      <div className="flex min-w-0 items-center gap-3">
        <RepAvatar name={row.rep.displayName} top={isTop} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={cn("truncate text-sm", isTop ? "font-semibold text-slate-900" : "font-medium text-slate-700")}
            >
              {row.rep.displayName}
            </span>
            {low ? (
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="Low activity — gone dark" />
            ) : null}
            <span className="ml-auto shrink-0 pl-2 text-xs font-bold tabular-nums text-slate-500">{u.actionCount}</span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className={cn("h-full rounded-full", isTop ? "bg-brand-red" : "bg-slate-300")}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </div>

      <MutedValue value={formatActiveTime(u.activeSeconds)} empty={u.activeSeconds === 0} />
      <MutedValue value={u.sessionCount} empty={u.sessionCount === 0} />
      <MutedValue value={u.viewCount} empty={viewsAreEmpty(u.viewCount, u.sessionCount)} />
    </Link>
  );
}

/** Telemetry columns: a muted em-dash until rows exist, the real count in primary once populated. */
function MutedValue({ value, empty }: { value: string | number | undefined; empty: boolean }) {
  return (
    <div className={cn("text-right text-sm tabular-nums", empty ? "text-slate-300" : "font-medium text-slate-700")}>
      {empty ? "—" : value}
    </div>
  );
}

function RepAvatar({ name, top }: { name: string; top: boolean }) {
  return (
    <span
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-black",
        top ? "bg-brand-red text-white" : "bg-slate-100 text-slate-600",
      )}
      aria-hidden="true"
    >
      {repInitials(name)}
    </span>
  );
}

/**
 * Whether the Views cell should render the muted "—" (no data) vs the real count. "—" only when the
 * rep has NO telemetry yet (no session) — so a genuine 0 views, once the rep has a session, shows as
 * a real "0" rather than masquerading as not-yet-populated.
 */
export function viewsAreEmpty(viewCount: number | undefined, sessionCount: number): boolean {
  return viewCount === undefined || sessionCount === 0;
}

/**
 * Proportion-bar width (%). Zero-action reps get an EMPTY bar (0%) so the bar never contradicts the
 * displayed 0 / "gone dark" flag; positive counts get at least a 2% sliver so a small-but-real
 * contribution stays visible.
 */
export function barWidthPct(actionCount: number, maxActions: number): number {
  if (maxActions <= 0 || actionCount <= 0) return 0;
  return Math.max(2, Math.round((actionCount / maxActions) * 100));
}

function repInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase() || "?";
}
