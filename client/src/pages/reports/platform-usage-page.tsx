import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { cn } from "@/lib/utils";
import { useTableSort, SortHeaderButton, type SortColumn } from "@/components/reports/sortable";
import { usePlatformUsageReport, formatActiveTime, type PlatformUsageRow } from "@/hooks/use-platform-usage-report";

// A rep at or below this many actions for the period is flagged as "gone dark".
const LOW_ACTIVITY_THRESHOLD = 5;
// Fraction of the roster active for the reps-active card to read as healthy (green) vs alarm (red).
const HEALTHY_ACTIVE_RATIO = 0.5;

// Shared column template — header and rows must stay in lockstep.
const GRID = "grid grid-cols-[2rem_minmax(0,1fr)_5.5rem_5rem_4.5rem] items-center gap-3";

// Sort columns for the leaderboard. The combined "Rep · Actions" column carries TWO independent
// sort controls in its header (rep = alpha by name, actions = the numeric ranking + the default);
// the body cell keeps name + count + bar together. Telemetry columns sort numerically.
// Exported so the sort behavior is unit-tested against the real PlatformUsageRow type.
export const PLATFORM_USAGE_SORT_COLUMNS: ReadonlyArray<SortColumn<PlatformUsageRow>> = [
  { key: "rep", type: "text", accessor: (r) => r.rep.displayName },
  // Actions always renders a real number (incl. 0), so it sorts on the raw value.
  { key: "actions", type: "number", accessor: (r) => r.usage.actionCount },
  // The muted telemetry columns (Active / Sessions / Views) render "—" for the not-yet-populated
  // case, so their sort accessor returns undefined for exactly that case (→ blanks last in both
  // directions) — matching the displayed em dash, so visually-empty rows never compare as 0 and
  // beat reps with real telemetry on an ascending sort. The empty conditions mirror MutedValue's
  // `empty` prop on each cell (activeSeconds===0 / sessionCount===0 / viewsAreEmpty).
  { key: "active", type: "number", accessor: (r) => (r.usage.activeSeconds === 0 ? undefined : r.usage.activeSeconds) },
  { key: "sessions", type: "number", accessor: (r) => (r.usage.sessionCount === 0 ? undefined : r.usage.sessionCount) },
  {
    key: "views",
    type: "number",
    accessor: (r) => (viewsAreEmpty(r.usage.viewCount, r.usage.sessionCount) ? undefined : r.usage.viewCount),
  },
];

// Human label per sort key, for the leaderboard subtitle (kept honest as the user re-sorts).
const PLATFORM_USAGE_SORT_LABELS: Record<string, string> = {
  rep: "rep name",
  actions: "actions",
  active: "active time",
  sessions: "sessions",
  views: "views",
};

// Window labels. These format a CT-resolved business-date STRING (YYYY-MM-DD, already bounded to
// America/Chicago by the server) — NOT a timestamp. The weekday is read straight off the calendar
// parts via Date.UTC(...).getUTCDay() so there is ZERO timezone conversion. Do NOT "improve" this
// into `new Date(iso)` / Date.parse on a timestamp — that reintroduces a local-tz shift and drifts
// the label off the America/Chicago day bounds the rest of the feature uses.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function dateParts(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return { m, d, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}
export function dayLabel(iso: string): string {
  const p = dateParts(iso);
  return `${WEEKDAYS[p.weekday]}, ${MONTHS[p.m - 1]} ${p.d}`; // "Thu, Jun 12"
}
export function weekLabel(startIso: string, endIso: string): string {
  const s = dateParts(startIso);
  const e = dateParts(endIso);
  return s.m === e.m
    ? `Week of ${MONTHS[s.m - 1]} ${s.d}–${e.d}` // "Week of Jun 7–13"
    : `Week of ${MONTHS[s.m - 1]} ${s.d} – ${MONTHS[e.m - 1]} ${e.d}`; // "Week of Jun 28 – Jul 4"
}
/** The explicit label for the selected window (a single day or a Sun–Sat week). */
export function windowLabel(grain: "day" | "week", dates: string[]): string {
  return grain === "week" ? weekLabel(dates[0], dates[dates.length - 1]) : dayLabel(dates[0]);
}

export function PlatformUsagePage() {
  // Initialize the period (and office) from the URL so the rep-detail back link round-trips to the
  // same view the user was on. Subsequent toggles update local state; the detail link re-emits them.
  const [searchParams] = useSearchParams();
  const officeId = searchParams.get("officeId");
  const [grain, setGrain] = useState<"day" | "week">(() => (searchParams.get("grain") === "day" ? "day" : "week"));
  const [anchorDate, setAnchorDate] = useState<string>(() => searchParams.get("date") ?? "");
  const { data, loading, error } = usePlatformUsageReport({ grain, date: anchorDate || undefined });

  // Headline ranking defaults to Actions desc (the proportion bars make 46-vs-0 read at a glance);
  // every column is now click-sortable via the shared hook, with that default preserved.
  const leaderboard = data?.leaderboard ?? [];
  const { sortedRows: rows, toggle, getHeaderProps, sortState } = useTableSort(leaderboard, PLATFORM_USAGE_SORT_COLUMNS, {
    initialSort: { key: "actions", dir: "desc" },
  });
  const sortedByLabel = PLATFORM_USAGE_SORT_LABELS[sortState?.key ?? "actions"] ?? "actions";
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

  // Window-aware copy. Relative words ("today" / "this week") are used ONLY for the current period
  // (default view / Today button → anchorDate is empty); any explicit date pick falls back to the
  // explicit window label, so a past window is never mislabeled "today" / "this week".
  const isCurrent = anchorDate === "";
  const win = data ? windowLabel(data.grain, data.dates) : "";
  const relWord = (data?.grain ?? grain) === "week" ? "this week" : "today";
  const metricLabel = (base: string) => (isCurrent ? `${base} ${relWord}` : `${base} · ${win}`);

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
        {/* Window sub-header — the selected window, read first (not inferred from the toggle). */}
        {data ? (
          <div className="flex items-baseline gap-2">
            <span className="rounded bg-[#CC0000]/10 px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide text-[#CC0000]">
              {data.grain === "week" ? "Weekly" : "Daily"}
            </span>
            <span className="text-xl font-black text-slate-900">{win}</span>
          </div>
        ) : null}
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
        {/* Weekly: make explicit that the picked date expands to a full Sun–Sat week. */}
        {data && data.grain === "week" ? (
          <span className="text-sm text-slate-500">
            → {weekLabel(data.dates[0], data.dates[data.dates.length - 1])}
          </span>
        ) : null}
      </div>

      {loading ? <div className="text-sm text-slate-500">Loading…</div> : null}
      {error ? (
        <div className="rounded-lg border border-brand-red/30 bg-brand-red/5 px-3 py-2 text-sm text-brand-red">{error}</div>
      ) : null}

      {data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <MetricCard
              label={metricLabel("Active time")}
              value={formatActiveTime(data.summary.activeSeconds)}
              muted={data.summary.activeSeconds === 0}
            />
            <MetricCard label={metricLabel("Actions")} value={String(data.summary.actionCount)} />
            <RepsActiveCard label={metricLabel("Active")} active={data.summary.activeReps} total={data.summary.totalReps} />
          </div>

          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-slate-700">Leaderboard</h2>
            <span className="text-xs text-slate-400">Sorted by {sortedByLabel} · {isCurrent ? relWord : win}</span>
          </div>
          <Leaderboard rows={rows} maxActions={maxActions} detailHref={detailHref} toggle={toggle} getHeaderProps={getHeaderProps} />

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
function RepsActiveCard({ label, active, total }: { label: string; active: number; total: number }) {
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
        {label}
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
  toggle,
  getHeaderProps,
}: {
  rows: PlatformUsageRow[];
  maxActions: number;
  detailHref: (repId: string) => string;
  toggle: (key: string) => void;
  getHeaderProps: (key: string) => { active: boolean; dir: "asc" | "desc" | null };
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
        No reps to show for this period.
      </div>
    );
  }
  const headerCell = (key: string, label: string, numeric: boolean) => {
    const hp = getHeaderProps(key);
    return (
      <SortHeaderButton
        label={label}
        numeric={numeric}
        active={hp.active}
        dir={hp.dir}
        onClick={() => toggle(key)}
        className="text-[11px] font-semibold uppercase tracking-wide text-slate-400"
      />
    );
  };
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div
        className={cn(
          GRID,
          "border-b border-slate-100 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400",
        )}
      >
        <div>#</div>
        {/* Combined column, two independent sort controls: Rep (alpha) and Actions (the ranking). */}
        <div className="flex items-center gap-1">
          {headerCell("rep", "Rep", false)}
          <span className="text-slate-300" aria-hidden="true">·</span>
          {headerCell("actions", "Actions", false)}
        </div>
        <div className="text-right">{headerCell("active", "Active", true)}</div>
        <div className="text-right">{headerCell("sessions", "Sessions", true)}</div>
        <div className="text-right">{headerCell("views", "Views", true)}</div>
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
