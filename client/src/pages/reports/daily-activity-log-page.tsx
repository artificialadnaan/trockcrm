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
import { useDealHref } from "@/hooks/use-office-scope";
import { useAuth } from "@/lib/auth";
import { parseDisplayDate } from "@/lib/deal-utils";
import { EmptyState, ErrorState, KpiCard, LoadingState, ReportPanel, formatNumber } from "./performance-report-ui";

const PAGE_SIZE = 200;

/** The narrow union from the shared enum — keeps the sanitised URL list and the chips on one type. */
type LogActivityType = (typeof ACTIVITY_TYPES)[number];

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

// Row clocks render in UTC — the SAME zone the server buckets days in (`a.occurred_at::date` resolves
// against the Postgres session TimeZone, which the API never sets, so UTC in practice).
//
// This has to match the bucket or the row contradicts its own heading: rendered in browser-local time,
// an activity at 2026-06-02T00:30:00Z sits under the "Jun 2" header while displaying "7:30 PM", so a
// Central manager reads Tuesday-evening work that actually happened Monday. Since this report exists to
// answer "what did this person do on this day", a row disagreeing with its day header defeats the
// point. The bucket cannot move to local/business time without desyncing the per-day counts from Rep
// Activity (the reconciliation property), so the CLOCK moves to the bucket's zone instead. The day
// header carries a visible "times UTC" marker so a time is never mistaken for local.
const UTC_TIME = { hour: "numeric", minute: "2-digit", timeZone: "UTC" } as const;

function formatClock(iso: string) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-US", UTC_TIME).format(new Date(iso));
}

/**
 * Full date + time for the Excel export, which cannot carry a time in a "date" column. Also UTC, for
 * the same reason and so an exported row matches what the page showed.
 */
function formatDateTime(iso: string) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(iso));
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

/**
 * Readership gate. The log carries the CONTENT of what people wrote, including synced email bodies, so it is
 * limited to a named allowlist rather than a role — see shared/lib/dailyActivityLogViewers.ts.
 *
 * This wrapper exists so the denial short-circuits BEFORE the report component mounts: the fetch lives in
 * that component's hooks, and rendering it just to early-return would still fire a request that 403s. The
 * server enforces the same allowlist on the endpoint; this only avoids offering a surface that cannot load.
 */
export function DailyActivityLogPage() {
  const { user } = useAuth();

  if (!user?.canViewDailyActivityLog) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Performance" title="Daily Activity Log" description="Access restricted." />
        <ReportPanel title="Not available to your account">
          <EmptyState label="The Daily Activity Log is limited to designated viewers. Contact an administrator if you need access." />
        </ReportPanel>
      </div>
    );
  }

  return <DailyActivityLogReport />;
}

function DailyActivityLogReport() {
  const { query } = useReportFilters();
  const [searchParams, setSearchParams] = useSearchParams();
  const { search } = useLocation();

  // The type filter and the page live in the URL, not local state: ReportFilterBar's Apply rewrites
  // the query string from a copy of the current params, so URL-held filters survive an Apply while
  // component state would be silently dropped. It also makes a filtered day shareable as a link.
  //
  // Sanitised against ACTIVITY_TYPES -- the same list the server validates against. A stale bookmark
  // like ?types=retired_type is dropped server-side and the response covers ALL types, so keeping it
  // here would light up a chip and print "counts cover only this type" over data that is not filtered
  // at all. The controls must describe the data shown, not the data requested.
  const selectedTypes = useMemo(
    () =>
      (searchParams.get("types") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value): value is LogActivityType => (ACTIVITY_TYPES as readonly string[]).includes(value)),
    [searchParams]
  );
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);

  // The off-day drill lives in the URL for the same reasons the type filter does: it survives the
  // filter bar's Apply, and a "who wrote their week up on Friday" view is shareable as a link. Only
  // the exact string the page writes counts as on, so a mangled param widens rather than hides.
  const loggedOffDayOnly = searchParams.get("loggedOffDay") === "1";

  const { data, loading, error } = useDailyActivityLogReport({
    ...query,
    types: selectedTypes,
    loggedOffDay: loggedOffDayOnly,
    page,
    limit: PAGE_SIZE,
  });

  // One writer for the URL so a control that changes TWO params (the Entries card clears both
  // narrowings) cannot land as two renders with a half-cleared state in between.
  function setParams(updates: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    // Any filter change invalidates the current offset — page 4 of the unfiltered log is not page 4
    // of the note-only log.
    if (!Object.prototype.hasOwnProperty.call(updates, "page")) next.delete("page");
    setSearchParams(next);
  }

  function setParam(key: string, value: string | null) {
    setParams({ [key]: value });
  }

  function toggleType(type: LogActivityType) {
    const next = selectedTypes.includes(type)
      ? selectedTypes.filter((value) => value !== type)
      : [...selectedTypes, type];
    setParam("types", next.length ? next.join(",") : null);
  }

  // ---------------------------------------------------------------------------------------------
  // The KPI cards as drills.
  //
  // Three of the five narrow the log; two cannot and therefore do not (see below). Every narrowing a
  // card applies is written to the SAME URL params the chips below read, so the chip row always shows
  // what a card did and offers a second way to clear it — a filter you can apply but not see is how a
  // user ends up reading a subset as the whole window.
  //
  // The numbers on the cards come from `data.kpis`, which the server computes over the WINDOW scope
  // and never over the narrowing. Clicking a card therefore cannot rewrite the number that was
  // clicked; `pagination.total` under the log is the narrowed count.
  // ---------------------------------------------------------------------------------------------
  const notesOnly = selectedTypes.length === 1 && selectedTypes[0] === "note";
  const narrowed = selectedTypes.length > 0 || loggedOffDayOnly;

  // Entries is the "show everything" card, the same role "All types" plays in the chip row: it is lit
  // when nothing is narrowed and clicking it clears every narrowing at once.
  //
  // Lit, it is a STATUS and does nothing when clicked. The early return is the whole point: without
  // it, setParams would still drop `page`, so clicking a card that reads "Showing every entry" would
  // silently throw a reader on page 3 back to page 1 — a control that says it is doing nothing while
  // moving you.
  function clearNarrowing() {
    if (!narrowed) return;
    setParams({ types: null, loggedOffDay: null });
  }

  // "Notes" matches the card's own subtitle — it counts `type = 'note'`, so the drill is exactly the
  // note chip. Toggling it leaves the off-day drill alone; the two compose into "notes written up on
  // another day", which is a question a manager actually asks.
  function toggleNotesOnly() {
    setParams({ types: notesOnly ? null : "note" });
  }

  function toggleLoggedOffDay() {
    setParams({ loggedOffDay: loggedOffDayOnly ? null : "1" });
  }

  // Deal links carry the TENANT SCOPE only — ?officeId, never ?office.
  //
  // The two params look interchangeable and are not:
  //   ?officeId — the app-level cross-office SCOPE. api() turns it into the x-office-id header, which
  //               is what tenantMiddleware resolves into a search_path (`office_<slug>`). It selects
  //               WHICH SCHEMA the request reads.
  //   ?office   — ReportFilterBar's display FILTER. It is a query param this report passes to its own
  //               endpoint and nothing else; it never reaches tenantMiddleware and never changes the
  //               schema. Rows are read from the viewer's CURRENT tenant either way.
  //
  // An earlier revision resolved ?office into an officeId for these links. That was wrong, and
  // actively harmful: it promoted a report predicate into a tenant switch. The office filter matches
  // on the activity's RESPONSIBLE USER (activities are tenant tables; users/offices are PUBLIC, so
  // the join crosses schemas), and the activity route lets an elevated caller set responsibleUserId
  // freely. So a Dallas-schema deal can carry an activity whose responsible user is Atlanta; under
  // ?office=atlanta that row is shown, and linking it as ?officeId=<atlanta> pointed the detail
  // request at Atlanta's schema, where that deal id does not exist — reintroducing exactly the 404
  // this link logic exists to prevent.
  //
  // With only ?office set, the deal lives in the viewer's current tenant, which is precisely where a
  // bare /deals/:id resolves. So the correct fallback is NO officeId at all. The genuinely complete
  // fix is a per-row office/scope from the server (deals.office_code determines a deal's schema, not
  // the responsible user's office) — that remains an open follow-up, deliberately not faked here.
  // Shared with both report DealLink components so this rule is stated once, not three times.
  const dealHref = useDealHref();

  const pagination = data?.pagination;
  const rangeStart = pagination && pagination.returned > 0 ? (pagination.page - 1) * pagination.limit + 1 : 0;
  const rangeEnd = pagination ? rangeStart + Math.max(pagination.returned - 1, 0) : 0;

  // Built from the SERVER's echo (appliedTypes / appliedLoggedOffDay), never from the URL — for the
  // same reason the type caption always was: a stale bookmark can ask for a narrowing the server
  // drops, and a caption describing the REQUEST rather than the RESPONSE lies about the rows on screen.
  const appliedNarrowing = [
    ...(data?.appliedTypes ?? []).map(labelForType),
    ...(data?.appliedLoggedOffDay ? ["Logged off-day"] : []),
  ];

  // The "content private" footnote is shown only when a row on this page actually carries the flag.
  // Since the owner-approved relaxation an admin or director never sees one, and a standing note about
  // a redaction that is not happening is just as misleading as a missing one.
  const hasRestrictedContent = (data?.days ?? []).some((day) => day.entries.some((entry) => entry.contentRestricted));

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

        {/* The off-day drill's home in the filter UI. The "Logged Off-Day" card writes the same param,
            so whatever a card applies is visible — and clearable — here too. */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Logging</span>
          <button
            type="button"
            aria-pressed={loggedOffDayOnly}
            onClick={toggleLoggedOffDay}
            className={`rounded-full border px-3 py-1 text-xs font-bold transition ${loggedOffDayOnly ? "border-brand-red bg-brand-red text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"}`}
          >
            Logged off-day only
          </button>
        </div>

        {/* Describes what the SERVER actually applied, not what the URL asked for — the two differ if a
            stale bookmark carries a type the server no longer accepts. Both numbers are named on
            purpose: the narrowed count belongs next to the log, the window count is what the cards
            above show, and printing only one of them is how a subset gets read as the whole window. */}
        {data && appliedNarrowing.length > 0 ? (
          <p className="mt-2 text-xs text-slate-500">
            Log narrowed to {appliedNarrowing.join(" + ")} —{" "}
            <span className="font-bold text-slate-900">{formatNumber(data.pagination.total)}</span> of{" "}
            <span className="font-bold text-slate-900">{formatNumber(data.kpis.totalEntries)}</span> entries in this
            window. The cards above always cover the whole window, so they still line up with Rep Activity.
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
              // TEXT, not "date": normalizeCellValue routes a date column through excelDateSerial,
              // which keeps only the UTC calendar day and formats it m/d/yyyy. In a log about what
              // people did THROUGHOUT the day, a column called "Occurred At" that silently drops the
              // time is worse than useless. Exported as a preformatted local date-time string.
              { key: "occurredAtDisplay", header: "Occurred At (UTC)", type: "text" },
              { key: "loggedAtDisplay", header: "Logged At (UTC)", type: "text" },
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
            rows: data.days.flatMap((day) =>
              day.entries.map((entry) => ({
                ...entry,
                occurredAtDisplay: formatDateTime(entry.occurredAt),
                loggedAtDisplay: formatDateTime(entry.loggedAt),
                // The export is a file that leaves the app — the redaction has to hold here too,
                // otherwise "Export to Excel" becomes the way around it.
                subject: entry.contentRestricted ? "(content private)" : entry.subject,
                body: entry.contentRestricted ? "(content private)" : entry.body,
              })) as unknown as Array<Record<string, unknown>>
            ),
          }] : []}
          disabled={loading || !data}
        />
      </div>

      {loading ? <LoadingState label="Loading the activity log..." /> : null}
      {error ? <ErrorState message={error} /> : null}

      {!loading && !error && data ? (
        <>
          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <KpiCard
              label="Entries"
              value={formatNumber(data.kpis.totalEntries)}
              helper="Across the selected window"
              active={!narrowed}
              onClick={clearNarrowing}
              // This card's "on" state IS the cleared state, so the usual "click to clear" would be
              // backwards: clicking it while lit does nothing because there is nothing left to clear.
              actionHint={{ idle: "Click to show every entry", active: "Showing every entry" }}
            />
            <KpiCard
              label="Notes"
              value={formatNumber(data.kpis.notes)}
              helper="Type: note"
              active={notesOnly}
              onClick={toggleNotesOnly}
            />
            {/* Days With Activity and Reps Logging are COUNT(DISTINCT ...) cards, and they are
                deliberately NOT clickable — not as an omission, as the honest answer.
                "Filter the log to days that have activity" and "to reps who logged something" are
                both no-ops: every row already satisfies them, so the click would appear to do
                nothing and teach the user that these cards are broken. The drill that WOULD be
                useful (a per-day or per-rep breakdown) is a different report — Rep Activity already
                has the per-rep cut, and the log below already IS the per-day cut. So they render as
                plain cards: no handler, no pointer cursor, no hover, and no tab stop, because a
                keyboard user landing on a permanently dead control is the worst kind of fake
                affordance. The helper line says which cards do what so the difference is not left
                to hover.

                Note the lit Entries card is NOT the same thing, even though clicking it also does
                nothing: it is a control whose condition is currently SATISFIED, exactly like the
                selected "All types" chip below, and it announces that with aria-pressed="true". It
                stays in the tab order because a keyboard user needs to reach it to learn the state
                and to return to it once a narrowing is on. These two cards can never do anything. */}
            <KpiCard
              label="Days With Activity"
              value={formatNumber(data.kpis.daysCovered)}
              helper="Distinct days — not a filter"
            />
            <KpiCard
              label="Reps Logging"
              value={formatNumber(data.kpis.repsLogging)}
              helper="Distinct reps — not a filter"
            />
            <KpiCard
              label="Logged Off-Day"
              value={formatNumber(data.kpis.offDayLogged)}
              helper="Written up on a different day than it happened"
              active={loggedOffDayOnly}
              onClick={toggleLoggedOffDay}
            />
          </section>

          <ReportPanel title="Activity Log">
            {data.days.length === 0 ? (
              // A card drill that empties the log must not read as "nobody logged anything" — the card
              // it was clicked from is still showing a non-zero count right above.
              <EmptyState
                label={
                  appliedNarrowing.length > 0
                    ? "No entries in this window match the current narrowing. Clear it to see the whole log."
                    : "No notes or updates were logged in this window."
                }
              />
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
                        {/* The day boundary and the row clocks are both UTC — say so, so a time is
                            never read as local and made to contradict this heading. */}
                        {" · "}times UTC
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

                          {/* Someone else's email: the row is counted but its content is withheld.
                              Say so explicitly — a silently blank entry reads as missing data. */}
                          {entry.contentRestricted ? (
                            <p className="mt-1 text-sm italic text-slate-500">
                              Content private — email is only readable by its mailbox owner. This entry is still
                              counted in the totals above.
                            </p>
                          ) : (
                            <>
                              {entry.subject ? (
                                <p className="mt-1 text-sm font-semibold text-slate-900">{entry.subject}</p>
                              ) : null}
                              {entry.body ? (
                                <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{entry.body}</p>
                              ) : null}
                            </>
                          )}

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
            timeline. Days and times are both UTC, so a row's clock never contradicts the day it is filed under.
            Entries written up on a different day carry a badge showing when they were actually logged.
            Rep Activity caches for 5 minutes, so just after something is logged it can appear here first.
            {hasRestrictedContent
              ? " Email entries you do not own are counted but their content is not shown."
              : null}
          </p>
        </>
      ) : null}
    </div>
  );
}
