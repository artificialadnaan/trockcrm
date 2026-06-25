import { type ReactNode } from "react";
import { Download, ExternalLink, Loader2 } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { useTableSort, SortHeaderButton, type SortColumn } from "@/components/reports/sortable";
import { usdExact, int } from "@/pages/reports/format";
import { downloadTextFile, serializeCsvTable } from "@/lib/report-export";
import { ScrollSyncX } from "@/pages/reports/scroll-sync-x";
import {
  useCommissionEvidence,
  type CommissionDrillRequest,
  type CommissionEvidence,
  type CommissionEvidenceRecord,
} from "@/hooks/use-director-dashboard";

type Rec = CommissionEvidenceRecord;

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

interface DrillColumn {
  key: string;
  header: string;
  numeric: boolean;
  sort: SortColumn<Rec>;
  cell: (r: Rec) => ReactNode;
}

/** CSV of every record in the popup, columns matching the on-screen table (raw values, dates ISO). Uses
 *  the canonical escaper (formula-injection guard + bare-CR quoting + numbers raw), like all other exports. */
function buildCsv(ev: CommissionEvidence): string {
  const cols = columnsFor(ev);
  return serializeCsvTable(
    cols.map((c) => c.header),
    ev.records.map((r) => cols.map((c) => c.sort.accessor(r))),
  );
}

function csvFilename(ev: CommissionEvidence): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `commission-${ev.metric}-${slug(ev.repName) || "rep"}.csv`;
}

function columnsFor(ev: CommissionEvidence): DrillColumn[] {
  const cols: DrillColumn[] = [];
  if (ev.kind === "deal") {
    cols.push({
      key: "deal", header: "Deal #", numeric: false,
      sort: { key: "deal", type: "text", accessor: (r) => r.primary ?? "" },
      cell: (r) => <span className="font-medium text-slate-700">{r.primary ?? "—"}</span>,
    });
  }
  cols.push({
    key: "name", header: ev.kind === "activity" ? "Activity" : ev.kind === "lead" ? "Lead" : "Name", numeric: false,
    sort: { key: "name", type: "text", accessor: (r) => r.name },
    cell: (r) => <span className="text-slate-800">{r.name}</span>,
  });
  cols.push({
    key: "stage", header: ev.kind === "activity" ? "Linked to" : ev.kind === "deal" && ev.metric === "earned" ? "Role" : "Stage", numeric: false,
    sort: { key: "stage", type: "text", accessor: (r) => r.stageLabel },
    cell: (r) => <span className="text-slate-500">{r.stageLabel || "—"}</span>,
  });
  if (ev.kind !== "activity") {
    cols.push({
      key: "company", header: "Company", numeric: false,
      sort: { key: "company", type: "text", accessor: (r) => r.companyName ?? "" },
      cell: (r) => <span className="text-slate-500">{r.companyName ?? "—"}</span>,
    });
  }
  if (ev.valueLabel) {
    cols.push({
      key: "value", header: ev.valueLabel, numeric: true,
      sort: { key: "value", type: "number", accessor: (r) => r.value },
      cell: (r) => <span className="font-semibold tabular-nums text-emerald-700">{usdExact(r.value)}</span>,
    });
  }
  cols.push({
    key: "date", header: "Date", numeric: true,
    sort: { key: "date", type: "date", accessor: (r) => r.date },
    cell: (r) => <span className="tabular-nums text-slate-500">{formatDate(r.date)}</span>,
  });
  return cols;
}

function EvidenceTable({ ev }: { ev: CommissionEvidence }) {
  const navigate = useNavigate();
  const location = useLocation();
  const columns = columnsFor(ev);
  const { sortedRows, toggle, getHeaderProps } = useTableSort(
    ev.records,
    columns.map((c) => c.sort),
  );

  if (ev.records.length === 0) {
    return <div className="px-3 py-10 text-center text-sm text-slate-400">No supporting records for this number.</div>;
  }

  return (
    // Bare <table> (not the ui <Table>, which adds its own overflow-x) + a min-width, so ScrollSyncX's body
    // is the single horizontal scroller and the right-edge columns stay reachable on a narrow popup.
    <table className="w-full min-w-[680px] caption-bottom text-sm">
      <TableHeader className="sticky top-0 z-10 bg-white">
        <TableRow className="border-b border-slate-200">
          {columns.map((col) => {
            const hp = getHeaderProps(col.key);
            return (
              <TableHead
                key={col.key}
                className={col.numeric ? "text-right" : ""}
                aria-sort={hp.active ? (hp.dir === "asc" ? "ascending" : "descending") : "none"}
              >
                <SortHeaderButton
                  label={col.header}
                  numeric={col.numeric}
                  active={hp.active}
                  dir={hp.dir}
                  onClick={() => toggle(col.key)}
                  className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500"
                />
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody className="divide-y divide-slate-100">
        {sortedRows.map((r) => {
          const navigable = r.navKind !== null && r.navId !== null;
          return (
            <TableRow
              key={r.id}
              className={navigable ? "group cursor-pointer hover:bg-sky-50/60" : ""}
              // Carry the current query string (notably ?officeId=) so the detail page's API calls stay
              // scoped to the office that produced this record — matches the shared evidence drawer.
              onClick={navigable ? () => navigate({ pathname: `/${r.navKind === "lead" ? "leads" : "deals"}/${r.navId}`, search: location.search }) : undefined}
            >
              {columns.map((col) => (
                <TableCell key={col.key} className={col.numeric ? "py-2 text-right" : "py-2"}>
                  {col.key === "name" && navigable ? (
                    <span className="inline-flex items-center gap-1 group-hover:underline">
                      {col.cell(r)}
                      <ExternalLink className="h-3 w-3 text-slate-300" />
                    </span>
                  ) : (
                    col.cell(r)
                  )}
                </TableCell>
              ))}
            </TableRow>
          );
        })}
      </TableBody>
    </table>
  );
}

/** The popup behind a Team Commissions number — its supporting deal/lead/activity records. */
export function CommissionEvidenceDrawer({
  request,
  onClose,
}: {
  request: CommissionDrillRequest | null;
  onClose: () => void;
}) {
  const { data, loading, error } = useCommissionEvidence(request);

  return (
    <Dialog open={request != null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[85vh] w-[min(96vw,1040px)] flex-col gap-3 sm:max-w-[min(96vw,1040px)]">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {data?.title ?? request?.repName ?? "Supporting records"}
            {data ? (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-slate-600">
                {int(data.total.count)} {data.total.count === 1 ? "record" : "records"}
                {data.total.value != null ? ` · ${usdExact(data.total.value)}` : ""}
              </span>
            ) : null}
          </DialogTitle>
          <DialogDescription>{data?.subtitle ?? "Loading the records behind this number…"}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex flex-1 items-center justify-center gap-2 py-16 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading records…
          </div>
        ) : error ? (
          <div className="flex-1 px-3 py-10 text-center text-sm text-red-600">{error}</div>
        ) : data ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex items-center justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={data.records.length === 0}
                onClick={() => downloadTextFile(buildCsv(data), csvFilename(data), "text/csv;charset=utf-8;")}
                title="Download every record in this popup as a CSV"
              >
                <Download className="h-4 w-4" /> Export CSV
              </Button>
            </div>
            {/* ScrollSyncX adds a synced top scrollbar rail + horizontal scroll for the wide table. */}
            <ScrollSyncX
              className="flex min-h-0 flex-1 flex-col rounded-lg border border-slate-200"
              bodyClassName="min-h-0 flex-1 overflow-auto"
            >
              <EvidenceTable ev={data} />
            </ScrollSyncX>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
