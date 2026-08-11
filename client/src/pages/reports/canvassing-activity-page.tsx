// Canvassing Activity — who is putting NEW names into the CRM, per person, per period.
//
// Built for the Atlanta lead-generation push: companies, properties, contacts and leads entered by each
// person, bucketed by week / month / quarter, plus the notes they logged.
//
// The one thing this page must never do is let a zero be misread. Attribution only exists from migration
// 0220 forward, so a period before that has no creators recorded at all — not "nobody worked". Every
// surface here therefore prints the unattributed count beside the attributed one, and the header carries
// the date attribution actually starts.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { PageHeader } from "@/components/layout/page-header";
import { ReportFilterBar, useReportFilters } from "@/components/reports/report-filter-bar";
import { ExportExcelButton } from "@/components/reports/export-excel-button";
import { useAuth } from "@/lib/auth";
import { useOfficeScopeId } from "@/hooks/use-office-scope";
import {
  CANVASSING_KINDS,
  useCanvassingActivityReport,
  type CanvassingBucket,
  type CanvassingCounts,
  type CanvassingKind,
} from "@/hooks/use-reports";
import {
  EmptyState,
  ErrorState,
  KpiCard,
  LoadingState,
  ReportPanel,
  formatNumber,
} from "./performance-report-ui";

/** Plurals, spelled out — `${kind}s` produced "companys" and "propertys". */
/** The zone this report windows, buckets and renders in — server/src/lib/period.ts calls it canonical. */
const BUSINESS_TIMEZONE = "America/Chicago";

const KIND_LABELS: Record<CanvassingKind, string> = {
  company: "Companies",
  property: "Properties",
  contact: "Contacts",
  lead: "Leads",
};

const BUCKETS: Array<{ value: CanvassingBucket; label: string }> = [
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
  { value: "quarter", label: "Quarterly" },
];

function formatDay(iso: string | null) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return "—";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d))
  );
}

/**
 * Note clocks render in BUSINESS time, which is the zone the server filtered and bucketed them in.
 *
 * Rendered in the browser's zone, a note at 2026-06-02T04:30Z shows as "Jun 1, 11:30 PM" to a Central
 * reader while the server counted it under Jun 1 — or, near a range edge, shows a date outside the window
 * that returned it. The Daily Activity Log hit exactly this and fixed it the same way: move the clock to
 * the bucket's zone and say so on the page.
 */
function formatClock(iso: string) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: BUSINESS_TIMEZONE,
  }).format(new Date(iso));
}

/** Full, unambiguous timestamp for the workbook: the panel caption that supplies the zone is not exported. */
function formatExportTimestamp(iso: string) {
  if (!iso) return "";
  return `${new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: BUSINESS_TIMEZONE,
  }).format(new Date(iso))} CT`;
}

function labelForType(type: string) {
  return type.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

/** Access gate. Wrapping keeps the report's hooks — and its request — from running for a denied user. */
export function CanvassingActivityPage() {
  const { user, refreshUser } = useAuth();
  const officeScopeKey = useOfficeScopeId();

  // The access flag is computed from the viewer's role in their ACTIVE office and fetched once, when
  // AuthProvider mounts. Switching ?officeId changes the effective role without refetching, so the gate
  // would keep answering for the office the session started in — hiding the report from someone who may
  // open it here, or offering it to someone the endpoint will refuse. The server is still the boundary;
  // this keeps the UI from disagreeing with it.
  const refreshedForOffice = useRef<string | null | undefined>(undefined);
  const [awaitingRefresh, setAwaitingRefresh] = useState(false);
  useEffect(() => {
    if (refreshedForOffice.current === undefined) {
      refreshedForOffice.current = officeScopeKey;
      return;
    }
    if (refreshedForOffice.current === officeScopeKey) return;
    refreshedForOffice.current = officeScopeKey;
    setAwaitingRefresh(true);
    void refreshUser().finally(() => setAwaitingRefresh(false));
  }, [officeScopeKey, refreshUser]);

  // Ordered deliberately: while a refresh is in flight after an office switch, neither answer is
  // trustworthy — the flag still describes the previous office. Showing the denial first would flash
  // "restricted" at someone who may open it here, so hold until the refreshed answer arrives.
  if (awaitingRefresh) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Performance" title="Canvassing Activity" description="Checking access…" />
        <LoadingState />
      </div>
    );
  }

  if (!user?.canViewCanvassingReport) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="Performance" title="Canvassing Activity" description="Access restricted." />
        <ReportPanel title="Not available to your account">
          <EmptyState label="The Canvassing Activity report is limited to designated viewers. Contact an administrator if you need access." />
        </ReportPanel>
      </div>
    );
  }

  return <CanvassingActivityReportView />;
}

function CanvassingActivityReportView() {
  // This report windows and buckets in America/Chicago, so its defaults are anchored there too —
  // otherwise the range offered describes a different day from the one the numbers are computed for.
  const { query } = useReportFilters({ defaultRange: "90", dateTimezone: BUSINESS_TIMEZONE });
  const [searchParams, setSearchParams] = useSearchParams();

  // The bucket lives in the URL for the same reason the filter bar's values do: the bar's Apply rewrites
  // the query string from a copy of the current params, so component state would be silently dropped.
  const bucketParam = searchParams.get("bucket");
  const bucket: CanvassingBucket = BUCKETS.some((entry) => entry.value === bucketParam)
    ? (bucketParam as CanvassingBucket)
    : "week";

  const { data, loading, error } = useCanvassingActivityReport({
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
    bucket,
    // The filter bar's owner picker writes UUIDs; they select WHOSE canvassing this is about. People
    // picked but with nothing entered still get a row — an explicit zero is the finding.
    userIds: query.ownerIds,
    // The bar ALSO supports name and email selectors, and hydrates its checkboxes from them on load. They
    // have to travel with the request or a shared ?owners=Jane link shows Jane ticked over office-wide
    // numbers until someone presses Apply. The server resolves them, bounded to this office.
    ownerNames: query.ownerNames,
    ownerEmails: query.ownerEmails,
  });

  function setBucket(next: CanvassingBucket) {
    const params = new URLSearchParams(searchParams);
    params.set("bucket", next);
    setSearchParams(params, { replace: false });
  }

  // Whether a person filter is on. It changes what several panels can honestly claim: the counts follow the
  // selection, but `unattributed` cannot — it describes records with no recorded author at all.
  const filteredToPeople =
    (query.ownerIds?.length ?? 0) > 0 ||
    (query.ownerNames?.length ?? 0) > 0 ||
    (query.ownerEmails?.length ?? 0) > 0;

  // Whether the window reaches back past the point creator tracking existed. True for the default view for
  // a while after migration 0220, and it changes what a zero in this grid is allowed to claim.
  const rangeReachesBeforeAttribution =
    !data?.attributionStartHint || (data ? data.range.from < data.attributionStartHint : false);

  // Which kind the person x period grid shows. "all" is the combined total; the rest narrow to one column
  // of the server's per-user counts, so the grid can answer "how many CONTACTS did this person add that
  // week" — which neither the whole-range person table nor the kinds-without-people period table could.
  const kindParam = searchParams.get("kind");
  const gridKind: CanvassingKind | "all" | "notes" =
    kindParam && [...CANVASSING_KINDS, "notes"].includes(kindParam)
      ? (kindParam as CanvassingKind | "notes")
      : "all";

  function setGridKind(next: CanvassingKind | "all" | "notes") {
    const params = new URLSearchParams(searchParams);
    if (next === "all") params.delete("kind");
    else params.set("kind", next);
    setSearchParams(params, { replace: false });
  }

  const chartData = useMemo(
    () =>
      (data?.buckets ?? []).map((row) => ({
        label: row.partial ? `${row.label}*` : row.label,
        Companies: row.counts.company,
        Properties: row.counts.property,
        Contacts: row.counts.contact,
        Leads: row.counts.lead,
      })),
    [data]
  );

  // Built explicitly rather than via sheetsFromReport. That helper stringifies any nested array, so each
  // bucket's `perUser` came out as "[object Object],[object Object]" and the person-by-period comparison —
  // the reason this report exists — was the one thing missing from the download.
  const exportSheets = useMemo(() => {
    if (!data) return [];
    // Keyed by bucketStart, which is unique by construction; the LABEL is only a header. Weekly labels omit
    // the year, so keying by label collapsed e.g. 2020-01-05 and 2025-01-05 into one column.
    const periodColumns = data.buckets.map((row) => ({
      key: row.bucketStart,
      // The on-screen label omits the year for weeks and says nothing about clipping. A spreadsheet has no
      // legend beside it, so the header carries the bucket start and the partial marker outright.
      header: `${row.label} (${row.bucketStart})${row.partial ? " — partial" : ""}`,
      type: "number" as const,
    }));
    return [
      {
        name: "By person",
        columns: [
          { key: "person", header: "Person" },
          { key: "companies", header: "Companies", type: "number" as const },
          { key: "properties", header: "Properties", type: "number" as const },
          { key: "contacts", header: "Contacts", type: "number" as const },
          { key: "leads", header: "Leads", type: "number" as const },
          { key: "total", header: "Total", type: "number" as const },
          { key: "notes", header: "Notes logged", type: "number" as const },
        ],
        rows: data.people.map((person) => ({
          person: person.displayName,
          companies: person.counts.company,
          properties: person.counts.property,
          contacts: person.counts.contact,
          leads: person.counts.lead,
          total: person.counts.total,
          notes: person.notesLogged,
        })),
      },
      {
        name: `Person by ${bucket}`,
        // A row per person PER KIND, plus their combined row. The grid can switch kinds on screen; a
        // workbook holding only the total cannot reconstruct that, and the whole-range sheet has no periods.
        columns: [
          { key: "person", header: "Person" },
          { key: "kind", header: "Kind" },
          ...periodColumns,
          { key: "total", header: "Total", type: "number" as const },
        ],
        rows: data.people.flatMap((person) =>
          (["all", ...CANVASSING_KINDS] as const).map((kind) => {
            const read = (counts: CanvassingCounts) => (kind === "all" ? counts.total : counts[kind]);
            const row: Record<string, unknown> = {
              person: person.displayName,
              kind: kind === "all" ? "All" : KIND_LABELS[kind],
              total: read(person.counts),
            };
            for (const period of data.buckets) {
              const cell = period.perUser.find((entry) => entry.userId === person.userId);
              row[period.bucketStart] = cell ? read(cell.counts) : 0;
            }
            return row;
          })
        ),
      },
      {
        name: filteredToPeople ? `Selected people by ${bucket}` : `Totals by ${bucket}`,
        columns: [
          { key: "period", header: "Period" },
          { key: "companies", header: "Companies", type: "number" as const },
          { key: "properties", header: "Properties", type: "number" as const },
          { key: "contacts", header: "Contacts", type: "number" as const },
          { key: "leads", header: "Leads", type: "number" as const },
          { key: "total", header: "Total", type: "number" as const },
          // Dropped under a person filter for the same reason the on-screen column is: `unattributed` is
          // always whole-office, so printing it beside person-filtered counts puts two scopes in one row.
          ...(filteredToPeople ? [] : [{ key: "unattributed", header: "No author recorded", type: "number" as const }]),
        ],
        rows: data.buckets.map((row) => ({
          period: `${row.label}${row.partial ? " (partial)" : ""}`,
          companies: row.counts.company,
          properties: row.counts.property,
          contacts: row.counts.contact,
          leads: row.counts.lead,
          total: row.counts.total,
          ...(filteredToPeople ? {} : { unattributed: row.unattributed.total }),
        })),
      },
      {
        // Named so a truncated export cannot be mistaken for the whole record — the sheet tab itself says
        // it is a slice, because a spreadsheet carries no "showing the most recent 200" caption.
        name: data.notesTruncated ? `Notes (newest ${data.notes.length})` : "Notes",
        columns: [
          { key: "when", header: "When" },
          { key: "person", header: "Person" },
          { key: "loggedBy", header: "Logged by (if not the same person)" },
          { key: "type", header: "Type" },
          { key: "subject", header: "Subject" },
          { key: "body", header: "Body" },
          { key: "target", header: "Attached to" },
        ],
        rows: data.notes.map((note) => ({
          // Central, matching the feed and the zone the server filtered in. A raw UTC ISO string put a note
          // near midnight on a different calendar day in the workbook than on the page it came from.
          // Self-contained: the feed's formatter drops the year and leans on the panel's "(times Central)"
          // caption, which a spreadsheet does not carry.
          when: formatExportTimestamp(note.occurredAt),
          person: note.userName ?? "",
          // The feed distinguishes who a note is ATTRIBUTED to from who actually entered it; a workbook
          // without that column reads every on-behalf-of note as the assignee's own work.
          loggedBy: note.performedByName ?? "",
          type: labelForType(note.type),
          subject: note.subject ?? "",
          body: note.body ?? "",
          target: note.targetName ?? "",
        })),
      },
    ];
  }, [data, bucket, filteredToPeople]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Performance"
        title="Canvassing Activity"
        description="New companies, properties, contacts and leads entered by each person — plus the notes they logged."
      />
      {/* No office select: these tables are per-office schemas with no office column, so it could not narrow anything. */}
      <ReportFilterBar
        defaultRange="90"
        showOffice={false}
        // A viewer on this report's allowlist may hold the `rep` role (Tim does). /users/sales-reps returns
        // ONLY the caller to a rep unless a purpose says otherwise, so without this the person who most
        // needs to compare the team could filter to nobody but themselves — on a report that already shows
        // them everyone's numbers. The server gates this purpose on the same allowlist.
        ownerPickerPurpose="canvassing-report"
        // This report filters created_by_user_id, not owner_id. Ownership is reassigned over an account's
        // life while authorship is not, so the shared "Owner" label named a different — and mutable —
        // column than the one the numbers come from.
        ownerLabel="Entered by"
        dateTimezone={BUSINESS_TIMEZONE}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">Group by</span>
          <div className="flex overflow-hidden rounded-lg border border-slate-200">
            {BUCKETS.map((entry) => (
              <button
                key={entry.value}
                type="button"
                onClick={() => setBucket(entry.value)}
                aria-pressed={bucket === entry.value}
                className={
                  bucket === entry.value
                    ? "bg-slate-950 px-3 py-1.5 text-xs font-black uppercase tracking-[0.14em] text-white"
                    : "bg-white px-3 py-1.5 text-xs font-black uppercase tracking-[0.14em] text-slate-600 hover:bg-slate-50"
                }
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
        <ExportExcelButton filename="canvassing-activity" sheets={exportSheets} disabled={loading || !data} />
      </div>

      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} /> : null}

      {!loading && !error && data ? (
        <>
          {/*
            The honesty banner. Attribution begins when migration 0220 shipped; before that nothing recorded
            who added a record, so any earlier period reads as zero. Saying so here is the difference between
            "the team did nothing in June" and "June cannot be answered".
          */}
          {data.rangeClamped ? (
            <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
              That range is longer than this report supports, so it is showing{" "}
              <strong>{formatDay(data.range.from)}</strong> to <strong>{formatDay(data.range.to)}</strong>. The
              filter above still shows what you asked for.
            </div>
          ) : null}

          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            {data.attributionStartHint ? (
              <>
                The earliest record naming its author is{" "}
                <strong>{formatDay(data.attributionStartHint)}</strong>, so nothing before that can be
                attributed to anyone. Companies, properties and contacts only began recording an author when
                this feature shipped, and each kind starts from its own first entry — a zero before then
                means it was never recorded, not that nothing was entered.
              </>
            ) : (
              <>
                No record in this office yet names who created it. Counts here fill in as people add companies,
                properties, contacts and leads from now on.
              </>
            )}
            {data.unattributed.total > 0 && !filteredToPeople ? (
              <>
                {" "}
                <strong>{formatNumber(data.unattributed.total)}</strong> record
                {data.unattributed.total === 1 ? "" : "s"} created in this window name no author (imported or
                system-created) and are excluded from every person's totals.
              </>
            ) : null}
          </div>

          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <KpiCard label="New Companies" value={formatNumber(data.totals.company)} />
            <KpiCard label="New Properties" value={formatNumber(data.totals.property)} />
            <KpiCard label="New Contacts" value={formatNumber(data.totals.contact)} />
            <KpiCard label="New Leads" value={formatNumber(data.totals.lead)} />
            <KpiCard label="Total Entered" value={formatNumber(data.totals.total)} />
            <KpiCard label="Notes Logged" value={formatNumber(data.notesLogged)} />
          </section>

          <ReportPanel title={`New records by ${bucket}`}>
            {chartData.length === 0 ? (
              <EmptyState label="Nothing entered in this window." />
            ) : (
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="Companies" stackId="a" fill="#CC0000" />
                    <Bar dataKey="Properties" stackId="a" fill="#111827" />
                    <Bar dataKey="Contacts" stackId="a" fill="#0f766e" />
                    <Bar dataKey="Leads" stackId="a" fill="#f97316" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </ReportPanel>

          <ReportPanel title="By person">
            {data.people.length === 0 ? (
              <EmptyState label="Nobody entered a new record in this window." />
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-xs font-black uppercase tracking-[0.14em] text-slate-500">
                    <tr>
                      <th className="py-2">Person</th>
                      <th>Companies</th>
                      <th>Properties</th>
                      <th>Contacts</th>
                      <th>Leads</th>
                      <th>Total</th>
                      <th>Notes Logged</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.people.map((person) => (
                      <tr key={person.userId}>
                        <td className="py-3 font-semibold text-slate-900">
                          {person.displayName}
                          {person.isActive ? null : (
                            <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                              Inactive
                            </span>
                          )}
                        </td>
                        <td>{formatNumber(person.counts.company)}</td>
                        <td>{formatNumber(person.counts.property)}</td>
                        <td>{formatNumber(person.counts.contact)}</td>
                        <td>{formatNumber(person.counts.lead)}</td>
                        <td className="font-semibold text-slate-900">{formatNumber(person.counts.total)}</td>
                        <td>{formatNumber(person.notesLogged)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ReportPanel>

          <ReportPanel title={`Each person, by ${bucket}`}>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">Showing</span>
              {(["all", ...CANVASSING_KINDS, "notes"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setGridKind(kind)}
                  aria-pressed={gridKind === kind}
                  className={
                    gridKind === kind
                      ? "rounded-full bg-slate-950 px-3 py-1 text-xs font-black uppercase tracking-[0.12em] text-white"
                      : "rounded-full bg-white px-3 py-1 text-xs font-black uppercase tracking-[0.12em] text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
                  }
                >
                  {kind === "all" ? "All" : kind === "notes" ? "Notes" : KIND_LABELS[kind]}
                </button>
              ))}
            </div>
            {data.buckets.length === 0 || data.people.length === 0 ? (
              <EmptyState label="Nothing entered in this window." />
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-xs font-black uppercase tracking-[0.14em] text-slate-500">
                    <tr>
                      <th className="py-2 pr-4">Person</th>
                      {data.buckets.map((row) => (
                        <th key={row.bucketStart} className="px-2 text-right">
                          {row.label}
                          {row.partial ? <span className="font-normal text-slate-400"> *</span> : null}
                        </th>
                      ))}
                      <th className="px-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.people.map((person) => (
                      <tr key={person.userId}>
                        <td className="py-3 pr-4 font-semibold text-slate-900">{person.displayName}</td>
                        {data.buckets.map((row) => {
                          const cell = row.perUser.find((entry) => entry.userId === person.userId);
                          const value = cell
                            ? gridKind === "notes"
                              ? cell.notesLogged
                              : cell.counts[gridKind === "all" ? "total" : gridKind]
                            : 0;
                          return (
                            <td
                              key={row.bucketStart}
                              className={value === 0 ? "px-2 text-right text-slate-400" : "px-2 text-right text-slate-900"}
                            >
                              {formatNumber(value)}
                            </td>
                          );
                        })}
                        <td className="px-2 text-right font-semibold text-slate-900">
                          {formatNumber(
                            gridKind === "notes"
                              ? person.notesLogged
                              : person.counts[gridKind === "all" ? "total" : gridKind]
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-xs font-semibold text-slate-500">
                  {gridKind === "all"
                    ? "New companies, properties, contacts and leads combined."
                    : gridKind === "notes"
                      ? "Notes logged, not records created."
                      : `New ${KIND_LABELS[gridKind].toLowerCase()} only.`}{" "}
                  {/*
                    The attribution caveat is about CREATED RECORDS. Activities have always recorded who
                    logged them, so in notes mode a zero means nobody logged anything — applying the
                    "not recorded" explanation there would excuse a real gap.
                  */}
                  {gridKind === "notes" ? (
                    <>A zero is a real zero — that person logged no notes in that period.</>
                  ) : rangeReachesBeforeAttribution ? (
                    data.attributionStartHint ? (
                      <>
                        Periods before {formatDay(data.attributionStartHint)} read as zero because no creator
                        was recorded then — only zeros on or after that date mean the person entered nothing.
                      </>
                    ) : (
                      // Nothing has been attributed at all yet, so every zero here is "not recorded" and
                      // none of them mean anyone was idle. Naming a date would be worse than naming none.
                      <>
                        No record in this office names its author yet, so every zero below means the
                        information was never recorded — not that nothing was entered.
                      </>
                    )
                  ) : (
                    <>A zero is a real zero — that person entered nothing in that period.</>
                  )}
                </p>
              </div>
            )}
          </ReportPanel>

          <ReportPanel
            title={
              filteredToPeople
                ? `Selected people by ${bucket}`
                : `Office totals by ${bucket}`
            }
          >
            {data.buckets.length === 0 ? (
              <EmptyState label="Nothing entered in this window." />
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-xs font-black uppercase tracking-[0.14em] text-slate-500">
                    <tr>
                      <th className="py-2">Period</th>
                      <th>Companies</th>
                      <th>Properties</th>
                      <th>Contacts</th>
                      <th>Leads</th>
                      <th>Total</th>
                      {/*
                        Only shown unfiltered. `unattributed` is a property of the DATA — records whose
                        creator was never recorded — so it is always whole-office and cannot be narrowed to
                        the selected people. Printing it beside person-filtered counts would put two
                        different scopes in one row.
                      */}
                      {filteredToPeople ? null : <th>No author recorded</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.buckets.map((row) => (
                      <tr key={row.bucketStart}>
                        <td className="py-3 font-semibold text-slate-900">
                          {row.label}
                          {row.partial ? (
                            <span className="ml-2 text-xs font-semibold text-slate-500" title="The selected range covers only part of this period">
                              partial
                            </span>
                          ) : null}
                        </td>
                        <td>{formatNumber(row.counts.company)}</td>
                        <td>{formatNumber(row.counts.property)}</td>
                        <td>{formatNumber(row.counts.contact)}</td>
                        <td>{formatNumber(row.counts.lead)}</td>
                        <td className="font-semibold text-slate-900">{formatNumber(row.counts.total)}</td>
                        {filteredToPeople ? null : (
                          <td className="text-slate-500">{formatNumber(row.unattributed.total)}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ReportPanel>

          <ReportPanel title="Notes logged (times Central)">
            {data.notes.length === 0 ? (
              <EmptyState
                label={
                  data.notesLogged > 0
                    ? "Notes were logged in this window, but you can only read your own. The counts above still include everyone's."
                    : "No notes logged in this window."
                }
              />
            ) : (
              <div className="space-y-3">
                {data.notes.map((note) => (
                  <div key={note.id} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-500">
                      <span className="text-slate-900">{note.userName ?? "Unknown"}</span>
                      <span>{formatClock(note.occurredAt)}</span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5">{labelForType(note.type)}</span>
                      {note.targetName ? <span>on {note.targetName}</span> : null}
                      {note.performedByName ? <span>logged by {note.performedByName}</span> : null}
                    </div>
                    {note.subject ? <p className="mt-2 text-sm font-semibold text-slate-900">{note.subject}</p> : null}
                    {note.body ? <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{note.body}</p> : null}
                  </div>
                ))}
                {data.notesTruncated ? (
                  <p className="text-xs font-semibold text-slate-500">
                    Showing the most recent {data.notes.length} entries — narrow the date range to see the rest.
                  </p>
                ) : null}
              </div>
            )}
          </ReportPanel>
        </>
      ) : null}
    </div>
  );
}

export type { CanvassingCounts };
