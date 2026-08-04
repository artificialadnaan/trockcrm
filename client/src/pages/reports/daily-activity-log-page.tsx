// Daily Activity Log — the readable day-by-day record of what reps logged.
//
// Companion to Rep Activity (/reports/performance/rep-activity), which shows the same activities as
// counts and charts. This page shows the entries themselves. The two are windowed and scoped by the
// SAME server predicate, so the per-day numbers in the day headers here equal that report's timeline
// bars when no type filter is on.

import { useMemo } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { ACTIVITY_TYPES } from "@trock-crm/shared/types";
import { PageHeader } from "@/components/layout/page-header";
import { ReportFilterBar, useReportFilters } from "@/components/reports/report-filter-bar";
import { ExportExcelButton } from "@/components/reports/export-excel-button";
import { useDailyActivityLogReport, type DailyActivityLogEntry } from "@/hooks/use-reports";
import { parseDisplayDate } from "@/lib/deal-utils";
import { EmptyState, ErrorState, KpiCard, LoadingState, ReportPanel, formatNumber } from "./performance-report-ui";

const PAGE_SIZE = 200;

function labelForType(type: string) {
  return type.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

// Day headers are date-only strings from the server. parseDisplayDate keeps them in LOCAL time —
// `new Date("2026-06-01")` is parsed as UTC midnight and renders as May 31 west of UTC (#572).
function formatDayHeading(date: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parseDisplayDate(date));
}

function formatDayShort(date: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(parseDisplayDate(date));
}

function formatClock(iso: string) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/**
 * The "this wasn't written on the day it happened" marker. occurred_at drives the day bucket, so
 * without this a manager reading a day would have no way to tell live notes from a Friday-afternoon
 * reconstruction of the whole week.
 */
function LoggedOffDayBadge({ entry }: { entry: DailyActivityLogEntry }) {
  if (entry.loggedSameDay) return null;
  const late = entry.loggedDaysDiff > 0;
  const days = Math.abs(entry.loggedDaysDiff);
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.12em] ${late ? "bg-amber-100 text-amber-800" : "bg-sky-100 text-sky-800"}`}
      title={`Occurred ${entry.occurredDate} · logged ${entry.loggedDate}`}
    >
      {late ? `Logged ${days}d late` : `Dated ${days}d ahead`} · {formatDayShort(entry.loggedDate)}
    </span>
  );
}

export function DailyActivityLogPage() {
  const { query } = useReportFilters();
  const [searchParams, setSearchParams] = useSearchParams();
  const { search } = useLocation();

  // The type filter and the page live in the URL, not local state: ReportFilterBar's Apply rewrites
  // the query string from a copy of the current params, so URL-held filters survive an Apply while
  // component state would be silently dropped. It also makes a filtered day shareable as a link.
  const selectedTypes = useMemo(
    () => (searchParams.get("types") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    [searchParams]
  );
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);

  const { data, loading, error } = useDailyActivityLogReport({ ...query, types: selectedTypes, page, limit: PAGE_SIZE });

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    // Any filter change invalidates the current offset — page 4 of the unfiltered log is not page 4
    // of the note-only log.
    if (key !== "page") next.delete("page");
    setSearchParams(next);
  }

  function toggleType(type: string) {
    const next = selectedTypes.includes(type)
      ? selectedTypes.filter((value) => value !== type)
      : [...selectedTypes, type];
    setParam("types", next.length ? next.join(",") : null);
  }

  // Preserve the cross-office scope on deal links; a bare /deals/:id resolves against the user's
  // default office and 404s an off-office deal.
  const officeId = searchParams.get("officeId");
  const dealHref = (dealId: string) => `/deals/${dealId}${officeId ? `?officeId=${encodeURIComponent(officeId)}` : ""}`;

  const pagination = data?.pagination;
  const rangeStart = pagination && pagination.returned > 0 ? (pagination.page - 1) * pagination.limit + 1 : 0;
  const rangeEnd = pagination ? rangeStart + Math.max(pagination.returned - 1, 0) : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Performance"
        title="Daily Activity Log"
        description="The notes and updates each rep logged, day by day — the readable record behind the Rep Activity counts."
      />
      <ReportFilterBar />

      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Entry type</span>
          <button
            type="button"
            onClick={() => setParam("types", null)}
            className={`rounded-full border px-3 py-1 text-xs font-bold transition ${selectedTypes.length === 0 ? "border-slate-950 bg-slate-950 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"}`}
          >
            All types
          </button>
          {ACTIVITY_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => toggleType(type)}
              className={`rounded-full border px-3 py-1 text-xs font-bold transition ${selectedTypes.includes(type) ? "border-brand-red bg-brand-red text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"}`}
            >
              {labelForType(type)}
            </button>
          ))}
        </div>
        {selectedTypes.length > 0 ? (
          <p className="mt-2 text-xs text-slate-500">
            Filtered to {selectedTypes.map(labelForType).join(", ")}. Counts below cover only these types, so they will
            not match the Rep Activity totals until you clear the filter.
          </p>
        ) : null}
      </div>

      <div className="flex justify-end">
        <ExportExcelButton
          filename="daily-activity-log"
          // The flat entry list is what is worth exporting; the day sections are a display grouping.
          // Only the CURRENT page is exported — the note under the table says so.
          sheets={data ? [{
            name: "Entries",
            columns: [
              { key: "occurredDate", header: "Day", type: "date" },
              { key: "occurredAt", header: "Occurred At", type: "date" },
              { key: "loggedDate", header: "Logged On", type: "date" },
              { key: "loggedDaysDiff", header: "Logged Days After", type: "number" },
              { key: "typeLabel", header: "Type", type: "text" },
              { key: "responsibleName", header: "Rep", type: "text" },
              { key: "performedByName", header: "Logged By (if different)", type: "text" },
              { key: "targetType", header: "Target Type", type: "text" },
              { key: "targetName", header: "Target", type: "text" },
              { key: "dealNumber", header: "Deal #", type: "text" },
              { key: "subject", header: "Subject", type: "text" },
              { key: "body", header: "Details", type: "text" },
              { key: "outcome", header: "Outcome", type: "text" },
              { key: "nextStep", header: "Next Step", type: "text" },
              { key: "durationMinutes", header: "Duration (min)", type: "number" },
            ],
            rows: data.days.flatMap((day) => day.entries as unknown as Array<Record<string, unknown>>),
          }] : []}
          disabled={loading || !data}
        />
      </div>

      {loading ? <LoadingState label="Loading the activity log..." /> : null}
      {error ? <ErrorState message={error} /> : null}

      {!loading && !error && data ? (
        <>
          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <KpiCard label="Entries" value={formatNumber(data.kpis.totalEntries)} helper="Across the selected window" />
            <KpiCard label="Notes" value={formatNumber(data.kpis.notes)} helper="Type: note" />
            <KpiCard label="Days With Activity" value={formatNumber(data.kpis.daysCovered)} />
            <KpiCard label="Reps Logging" value={formatNumber(data.kpis.repsLogging)} />
            <KpiCard
              label="Logged Off-Day"
              value={formatNumber(data.kpis.offDayLogged)}
              helper="Written up on a different day than it happened"
            />
          </section>

          <ReportPanel title="Activity Log">
            {data.days.length === 0 ? (
              <EmptyState label="No notes or updates were logged in this window." />
            ) : (
              <div className="space-y-6">
                {data.days.map((day) => (
                  <div key={day.date}>
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-slate-200 pb-2">
                      <h3 className="text-sm font-black uppercase tracking-tight text-slate-950">
                        {formatDayHeading(day.date)}
                      </h3>
                      <span className="text-xs text-slate-500">
                        {formatNumber(day.entryCount)} {day.entryCount === 1 ? "entry" : "entries"}
                        {" · "}{formatNumber(day.noteCount)} notes
                        {" · "}{formatNumber(day.repCount)} {day.repCount === 1 ? "rep" : "reps"}
                      </span>
                      {day.offDayLoggedCount > 0 ? (
                        <span className="text-xs font-semibold text-amber-700">
                          {formatNumber(day.offDayLoggedCount)} logged on another day
                        </span>
                      ) : null}
                      {/* The day header counts the WHOLE day; this page may hold only part of it. */}
                      {day.entries.length < day.entryCount ? (
                        <span className="text-xs text-slate-500">
                          (showing {formatNumber(day.entries.length)} of them on this page)
                        </span>
                      ) : null}
                    </div>

                    <ul className="divide-y divide-slate-100">
                      {day.entries.map((entry) => (
                        <li key={entry.id} className="py-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full bg-slate-950 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.12em] text-white">
                              {entry.typeLabel}
                            </span>
                            <span className="text-xs font-semibold text-slate-500">{formatClock(entry.occurredAt)}</span>
                            <span className="text-sm font-bold text-slate-900">{entry.responsibleName}</span>
                            {entry.performedByName ? (
                              <span className="text-xs text-slate-500">logged by {entry.performedByName}</span>
                            ) : null}
                            <LoggedOffDayBadge entry={entry} />
                          </div>

                          <div className="mt-1 text-sm text-slate-600">
                            {entry.dealId ? (
                              <Link
                                to={dealHref(entry.dealId)}
                                className="font-bold text-slate-950 underline decoration-brand-red/40 underline-offset-4 hover:text-brand-red"
                              >
                                {entry.dealName || "Deal"}
                                {entry.dealNumber ? ` (${entry.dealNumber})` : ""}
                              </Link>
                            ) : entry.targetName ? (
                              <span>
                                <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
                                  {entry.targetType}
                                </span>{" "}
                                <span className="font-semibold text-slate-800">{entry.targetName}</span>
                              </span>
                            ) : (
                              <span className="text-slate-400">No linked record</span>
                            )}
                          </div>

                          {entry.subject ? (
                            <p className="mt-1 text-sm font-semibold text-slate-900">{entry.subject}</p>
                          ) : null}
                          {entry.body ? (
                            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{entry.body}</p>
                          ) : null}

                          <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-slate-500">
                            {entry.outcome ? <span>Outcome: {entry.outcome}</span> : null}
                            {entry.nextStep ? <span>Next: {entry.nextStep}</span> : null}
                            {entry.durationMinutes ? <span>{formatNumber(entry.durationMinutes)} min</span> : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}

            {pagination && pagination.total > 0 ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-3">
                {/* Never let a partial list read as the whole story: always state the range and total. */}
                <p className="text-xs text-slate-600">
                  Showing <span className="font-bold text-slate-900">{formatNumber(rangeStart)}–{formatNumber(rangeEnd)}</span>{" "}
                  of <span className="font-bold text-slate-900">{formatNumber(pagination.total)}</span> entries
                  {pagination.totalPages > 1 ? ` · page ${pagination.page} of ${pagination.totalPages}` : ""}
                  {pagination.totalPages > 1 ? " · Excel export covers this page only" : ""}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={pagination.page <= 1}
                    onClick={() => setParam("page", String(pagination.page - 1))}
                    className="rounded-lg border border-slate-200 px-3 py-1 text-xs font-bold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40 hover:border-slate-400"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    disabled={!pagination.hasMore}
                    onClick={() => setParam("page", String(pagination.page + 1))}
                    className="rounded-lg border border-slate-200 px-3 py-1 text-xs font-bold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40 hover:border-slate-400"
                  >
                    Next
                  </button>
                </div>
              </div>
            ) : null}
          </ReportPanel>

          <p className="text-xs text-slate-500">
            Days are grouped by when the work <span className="font-semibold">occurred</span>, matching the{" "}
            <Link to={{ pathname: "/reports/performance/rep-activity", search }} className="underline underline-offset-2">
              Rep Activity
            </Link>{" "}
            timeline. Entries written up on a different day carry a badge showing when they were actually logged.
          </p>
        </>
      ) : null}
    </div>
  );
}
