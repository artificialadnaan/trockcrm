// Canvassing Activity — who is putting NEW names into the CRM, per person, per period.
//
// Built for the Atlanta lead-generation push: companies, properties, contacts and leads entered by each
// person, bucketed by week / month / quarter, plus the notes they logged.
//
// The one thing this page must never do is let a zero be misread. Attribution only exists from migration
// 0220 forward, so a period before that has no creators recorded at all — not "nobody worked". Every
// surface here therefore prints the unattributed count beside the attributed one, and the header carries
// the date attribution actually starts.

import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { PageHeader } from "@/components/layout/page-header";
import { ReportFilterBar, useReportFilters } from "@/components/reports/report-filter-bar";
import { ExportExcelButton } from "@/components/reports/export-excel-button";
import { useAuth } from "@/lib/auth";
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

function formatClock(iso: string) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(
    new Date(iso)
  );
}

function labelForType(type: string) {
  return type.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

/** Access gate. Wrapping keeps the report's hooks — and its request — from running for a denied user. */
export function CanvassingActivityPage() {
  const { user } = useAuth();

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
  const { query } = useReportFilters({ defaultRange: "90" });
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
  });

  function setBucket(next: CanvassingBucket) {
    const params = new URLSearchParams(searchParams);
    params.set("bucket", next);
    setSearchParams(params, { replace: false });
  }

  // Whether a person filter is on. It changes what several panels can honestly claim: the counts follow the
  // selection, but `unattributed` cannot — it describes records with no recorded author at all.
  const filteredToPeople = (query.ownerIds?.length ?? 0) > 0;

  // Whether the window reaches back past the point creator tracking existed. True for the default view for
  // a while after migration 0220, and it changes what a zero in this grid is allowed to claim.
  const rangeReachesBeforeAttribution =
    !data?.attributionStartHint || (data ? data.range.from < data.attributionStartHint : false);

  // Which kind the person x period grid shows. "all" is the combined total; the rest narrow to one column
  // of the server's per-user counts, so the grid can answer "how many CONTACTS did this person add that
  // week" — which neither the whole-range person table nor the kinds-without-people period table could.
  const kindParam = searchParams.get("kind");
  const gridKind: CanvassingKind | "all" =
    kindParam && (CANVASSING_KINDS as readonly string[]).includes(kindParam) ? (kindParam as CanvassingKind) : "all";

  function setGridKind(next: CanvassingKind | "all") {
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
        columns: [{ key: "person", header: "Person" }, ...periodColumns, { key: "total", header: "Total", type: "number" as const }],
        rows: data.people.map((person) => {
          const row: Record<string, unknown> = { person: person.displayName, total: person.counts.total };
          for (const period of data.buckets) {
            row[period.bucketStart] = period.perUser.find((entry) => entry.userId === person.userId)?.counts.total ?? 0;
          }
          return row;
        }),
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
        name: "Notes",
        columns: [
          { key: "when", header: "When" },
          { key: "person", header: "Person" },
          { key: "type", header: "Type" },
          { key: "subject", header: "Subject" },
          { key: "body", header: "Body" },
          { key: "target", header: "Attached to" },
        ],
        rows: data.notes.map((note) => ({
          when: note.occurredAt,
          person: note.userName ?? "",
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
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            {data.attributionStartHint ? (
              <>
                Who created a record has only been tracked since{" "}
                <strong>{formatDay(data.attributionStartHint)}</strong>. Earlier periods show zero because the
                information was never recorded, not because nothing was entered.
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
              {(["all", ...CANVASSING_KINDS] as const).map((kind) => (
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
                  {kind === "all" ? "All" : `${kind}s`}
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
                          const value = cell ? cell.counts[gridKind === "all" ? "total" : gridKind] : 0;
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
                          {formatNumber(person.counts[gridKind === "all" ? "total" : gridKind])}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-xs font-semibold text-slate-500">
                  {gridKind === "all" ? "New companies, properties, contacts and leads combined." : `New ${gridKind}s only.`}{" "}
                  {rangeReachesBeforeAttribution ? (
                    <>
                      Periods before {formatDay(data.attributionStartHint)} read as zero because no creator was
                      recorded then — only zeros on or after that date mean the person entered nothing.
                    </>
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

          <ReportPanel title="Notes logged">
            {data.notes.length === 0 ? (
              <EmptyState label="No notes logged in this window." />
            ) : (
              <div className="space-y-3">
                {data.notes.map((note) => (
                  <div key={note.id} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-500">
                      <span className="text-slate-900">{note.userName ?? "Unknown"}</span>
                      <span>{formatClock(note.occurredAt)}</span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5">{labelForType(note.type)}</span>
                      {note.targetName ? <span>on {note.targetName}</span> : null}
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
