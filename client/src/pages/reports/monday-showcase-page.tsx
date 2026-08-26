import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Loader2 } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useMondayShowcase } from "@/hooks/use-reports";
import { useOfficeScopeId } from "@/hooks/use-office-scope";
import {
  SHOWCASE_VARIANTS,
  ROUTE_BUCKETS,
  ROUTE_BUCKET_LABEL,
  type ShowcaseVariantKey,
  type MondayShowcaseData,
  type EvidenceRequest,
  type RouteBucket,
} from "./monday-showcase/types";
import {
  ROUTES_PARAM,
  isBucketSelected,
  isFetchableSelection,
  parseRouteSelection,
  payloadDescribesSelection,
  routesForRequest,
  serializeRouteSelection,
  toggleRouteBucket,
  DEFAULT_ROUTE_SELECTION,
} from "./monday-showcase/route-filter";
import { DrillProvider } from "./monday-showcase/drill";
import { EvidenceDrawer } from "./monday-showcase/evidence-drawer";
import { DEFAULT_WEEK_MODE, WEEK_MODE_LABELS, type WeekMode } from "./week-mode";
import {
  VariantA3Lanes,
  VariantExecHero,
  VariantB2Leaderboard,
  VariantB3LoadLane,
  VariantB4ForecastLadder,
} from "./monday-showcase/variants";
import { VariantA1EstimatingReport } from "./monday-showcase/estimating-report";

const VARIANT_COMPONENT: Record<ShowcaseVariantKey, ComponentType<{ data: MondayShowcaseData }>> = {
  HERO: VariantExecHero,
  A1: VariantA1EstimatingReport,
  A3: VariantA3Lanes,
  B2: VariantB2Leaderboard,
  B3: VariantB3LoadLane,
  B4: VariantB4ForecastLadder,
};

/**
 * An open drill: the clicked number AND the period + department selection it was computed under, captured
 * at the moment of the click.
 *
 * The drawer's one contract is that its total equals the figure that opened it, so its request must not be
 * re-derived from page state that has since moved on. Reading the page's LIVE selection broke that in both
 * directions: an unfetchable selection (?routes=none, a bad shared link) yields NO ?routes, which the
 * server reads as "all departments" — an unfiltered record list behind a page that says it has no numbers
 * to show — and a switch to the other bucket silently swaps the records under an unchanged title.
 *
 * Capturing is sound because a drill can only be STARTED from a rendered number: DrillProvider is mounted
 * inside the `data` branch, which requires a fetchable selection. So a captured request is always one the
 * server will honour, whatever the chips do afterwards.
 */
interface OpenDrill {
  request: EvidenceRequest;
  mode: WeekMode;
  routes: RouteBucket[] | undefined;
}

export function MondayShowcasePage() {
  const [mode, setMode] = useState<WeekMode>(DEFAULT_WEEK_MODE);
  const [variant, setVariant] = useState<ShowcaseVariantKey>("HERO");
  const [evidence, setEvidence] = useState<OpenDrill | null>(null);
  const officeScopeId = useOfficeScopeId();
  const isFirstOfficeScopeLayout = useRef(true);

  // Evidence captures the scope behind a click and remains mounted outside the main payload branch. It
  // must close before a tenant switch can pair office A's record ids with office B's URL/search scope.
  useLayoutEffect(() => {
    if (isFirstOfficeScopeLayout.current) {
      isFirstOfficeScopeLayout.current = false;
      return;
    }
    setEvidence(null);
  }, [officeScopeId]);

  // The Service/Other selection lives in the URL (NOT component state): switching variants keeps it, and
  // the link a director pastes into Slack reproduces the exact slice they were looking at. `variant` and
  // `mode` stay local -- they are already ephemeral view controls and moving them is out of scope here.
  const [searchParams, setSearchParams] = useSearchParams();
  // getAll, NOT get: .get() returns only the FIRST occurrence, so a repeated ?routes=service&routes=other
  // would read as a confident Service-only selection here while the server rejects the same URL as
  // ambiguous — the page would show a slice the server would refuse to produce. The shared parser needs to
  // SEE the repetition to reject it.
  const rawRoutes = searchParams.getAll(ROUTES_PARAM);
  const rawRoutesKey = JSON.stringify(rawRoutes); // value-, not identity-keyed: getAll returns a new array each render
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the joined value, see above
  const selection = useMemo(() => parseRouteSelection(rawRoutes), [rawRoutesKey]);
  const setSelection = useCallback(
    (next: typeof selection) => {
      const params = new URLSearchParams(searchParams);
      const encoded = serializeRouteSelection(next);
      // Both-buckets removes the param entirely, so the default state leaves a clean, pre-filter-shaped URL.
      if (encoded === null) params.delete(ROUTES_PARAM);
      else params.set(ROUTES_PARAM, encoded);
      // replace: a chip toggle is a view control, not a navigation step -- Back should leave the report,
      // not walk the user through every chip they tried.
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  // Only a real selection may be fetched. "Neither selected" and an unparseable ?routes render their own
  // panels below; passing undefined here would fetch the UNFILTERED report and show office-wide numbers
  // under an empty or broken chip state.
  const fetchable = isFetchableSelection(selection);
  const requestRoutes: RouteBucket[] | undefined = fetchable ? routesForRequest(selection) : undefined;
  const { data, loading, error, refetch } = useMondayShowcase(mode, requestRoutes, fetchable);
  const Active = VARIANT_COMPONENT[variant];

  // The ONE place a drill is opened, and therefore the one place the selection is stamped onto it. Doing it
  // here rather than at each of the ~15 <DrillNumber> call sites means no variant can forget, and none of
  // them needs to know the filter exists. `requestRoutes` is identity-stable while the URL is (it is
  // `selection.buckets` from a memoized parse), so this callback is not rebuilt on every render.
  const openDrill = useCallback(
    (request: EvidenceRequest) => setEvidence({ request, mode, routes: requestRoutes }),
    [mode, requestRoutes]
  );

  // The server-sourced caveat, but ONLY while it describes the payload actually on screen. A refetch keeps
  // the previous payload in hand, so reading routeFilter straight off `data` can print "Showing Service
  // only" next to chips that now say All departments. That caveat is the only disclosure the unfilterable
  // figures (Active leads) have — a version of it that can contradict the chips is worse than none.
  const settledFilter =
    !loading && data && payloadDescribesSelection(data.routeFilter.selected, selection)
      ? data.routeFilter
      : null;

  // Deliberately NOT wrapped in ReportShell: this is a fixed weekly Monday view whose only control is the
  // WTD / last-full-week toggle below. It does not take a date range / office / owner filter, so it must
  // not render the shared Report Filters bar (a bar that doesn't filter is a UX trap).
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Reports · Monday showcase
          </p>
          <h1 className="text-2xl font-bold">Monday Showcase</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Many presentations, one source of truth — switch variants to compare layouts on identical
            numbers. Every number is evidence-backed: click it to see the exact records behind it. Fixed
            weekly view (use the toggle); the shared date/office/owner filter bar does not apply here.
          </p>
        </div>
        <button
          onClick={() => void refetch()}
          className="shrink-0 rounded border px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          Refresh
        </button>
      </div>

      {/* Service / Other chips. Rendered OUTSIDE the loading/error/data switch so they stay reachable in
          the "nothing selected" and "bad ?routes" states — a filter you cannot un-set is a trap. Additive
          and stackable: both on (the default) is the whole report, exactly as it read before this shipped. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Department
        </span>
        <div className="flex flex-wrap gap-1.5">
          {ROUTE_BUCKETS.map((bucket) => {
            const on = isBucketSelected(selection, bucket);
            return (
              <button
                key={bucket}
                type="button"
                aria-pressed={on}
                onClick={() => setSelection(toggleRouteBucket(selection, bucket))}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  on
                    ? "border-foreground bg-foreground text-background"
                    : "bg-white text-muted-foreground hover:bg-gray-50"
                }`}
              >
                {ROUTE_BUCKET_LABEL[bucket]}
              </button>
            );
          })}
        </div>
        {selection.kind === "selection" && selection.buckets.length === ROUTE_BUCKETS.length ? (
          <span className="text-xs text-muted-foreground">All departments — the full report.</span>
        ) : null}
        {settledFilter?.active ? (
          <span className="text-xs text-amber-700">
            Showing {ROUTE_BUCKET_LABEL[settledFilter.selected[0]]} only. Not filtered:{" "}
            {settledFilter.unfilterable.join("; ")}.
          </span>
        ) : null}
      </div>

      {selection.kind === "invalid" ? (
        // A ?routes value we cannot parse. Deliberately NOT a silent fall-back to "both": showing the full
        // report under a URL that claims a filter is how an office-wide number gets read as a slice.
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <p className="font-medium">That filter link isn’t valid.</p>
          <p className="mt-1">
            <code className="rounded bg-red-100 px-1">?{ROUTES_PARAM}={selection.raw}</code> isn’t a
            department selection, so no numbers are shown — they would not be the ones the link asked for.
            Pick a chip above, or{" "}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => setSelection(DEFAULT_ROUTE_SELECTION)}
            >
              show all departments
            </button>
            .
          </p>
        </div>
      ) : selection.kind === "empty" ? (
        // Both chips off. There is no such report, so we say so — rendering zeros here would look like a
        // measured result ("Service and Other both closed nothing this week") rather than an empty filter.
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <p className="font-medium">Select at least one department.</p>
          <p className="mt-1">
            Nothing is selected, so there is nothing to report. These would be zeros, not results — turn{" "}
            {ROUTE_BUCKET_LABEL.service} or {ROUTE_BUCKET_LABEL.other} back on above.
          </p>
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      ) : data ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex overflow-hidden rounded-lg border">
              {(["to_date", "completed", "mtd", "ytd"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`px-3 py-1.5 text-sm ${mode === m ? "bg-foreground text-background" : "bg-white text-muted-foreground"}`}
                >
                  {WEEK_MODE_LABELS[m]}
                </button>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">Period: {data.period.label}</span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {SHOWCASE_VARIANTS.map((v) => (
              <button
                key={v.key}
                onClick={() => setVariant(v.key)}
                className={`rounded-full border px-3 py-1 text-xs ${
                  variant === v.key ? "border-foreground bg-foreground text-background" : "bg-white text-muted-foreground hover:bg-gray-50"
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>

          <DrillProvider open={openDrill}>
            <div className="rounded-xl border bg-gray-50/50 p-4">
              <Active data={data} />
            </div>
          </DrillProvider>
          <p className="text-xs text-muted-foreground">
            Tip: most figures here are clickable — open the exact records behind a number. Many show a dotted
            underline; the headline tiles and hero numbers are clickable too.
          </p>

          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Source notes &amp; value-basis discipline</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {data.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </details>
        </div>
      ) : (
        <div className="rounded-lg border bg-gray-50 p-6 text-sm text-muted-foreground">
          No showcase data for this period.
        </div>
      )}

      {/* The drawer gets the SAME period and selection the clicked number was rendered under, so its total
          equals that figure. Without this a card reading 6 under "Service" would open the office's 10 —
          and these come from the CAPTURED drill, not from `mode`/`requestRoutes`, so a selection that
          changes while the drawer is open cannot re-point it at a slice the user never clicked. */}
      <EvidenceDrawer
        request={evidence?.request ?? null}
        mode={evidence?.mode ?? mode}
        routes={evidence?.routes}
        onClose={() => setEvidence(null)}
        onMutated={refetch}
      />
    </div>
  );
}
