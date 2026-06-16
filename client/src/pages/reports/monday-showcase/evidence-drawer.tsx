import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, ExternalLink, Loader2 } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useShowcaseEvidence } from "@/hooks/use-reports";
import { usd, int, winPct } from "../format";
import { ScrollSyncX } from "../scroll-sync-x";
import type { EvidenceRecord, EvidenceRequest, MondayShowcaseEvidence } from "./types";

// Literal-day formatting (no UTC-midnight off-by-one), matching the app's date-only rendering (#572).
function formatCohortDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// ---- sorting (client-side; the records are the full reconciling set, so sorting never drops a row) ----
type SortKey = "name" | "company" | "owner" | "value" | "date" | "winprob" | "region" | "type" | "stage" | "age";
interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}
const NUMERIC_KEYS: ReadonlySet<SortKey> = new Set(["value", "winprob", "age"]);

function sortAccessor(r: EvidenceRecord, key: SortKey): string | number {
  switch (key) {
    case "name":
      return r.name?.toLowerCase() ?? "";
    case "company":
      return r.companyName?.toLowerCase() ?? "";
    case "owner":
      return r.repName?.toLowerCase() ?? "";
    case "value":
      return r.value ?? Number.NEGATIVE_INFINITY;
    case "date":
      return r.cohortDate ?? "";
    case "winprob":
      // blanks sort to the bottom on desc (the common case is "unknown") — never coerced to 0
      return r.winProbability ?? Number.NEGATIVE_INFINITY;
    case "region":
      return r.region?.toLowerCase() ?? "";
    case "type":
      return r.dealType?.toLowerCase() ?? "";
    case "stage":
      return r.stageLabel?.toLowerCase() ?? "";
    case "age":
      return r.daysInStage ?? Number.NEGATIVE_INFINITY;
  }
}

function sortRecords(records: EvidenceRecord[], sort: SortState): EvidenceRecord[] {
  return [...records].sort((a, b) => {
    const av = sortAccessor(a, sort.key);
    const bv = sortAccessor(b, sort.key);
    const cmp =
      typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return sort.dir === "asc" ? cmp : -cmp;
  });
}

interface ColumnDef {
  key: SortKey;
  header: string;
  numeric?: boolean;
  show: boolean;
  render: (r: EvidenceRecord) => ReactNode;
}

function columnsFor(ev: MondayShowcaseEvidence): ColumnDef[] {
  const hasValue = ev.metric !== "leads";
  const cols: ColumnDef[] = [
    {
      key: "name",
      header: ev.metric === "leads" ? "Lead" : "Deal",
      show: true,
      render: (r) => (
        <div className="flex min-w-0 items-center gap-1.5">
          <div className="min-w-0">
            <div className="truncate font-medium text-sky-700 group-hover:underline">{r.name}</div>
            {r.dealNumber ? <div className="text-xs text-slate-400">#{r.dealNumber}</div> : null}
          </div>
          <ExternalLink className="h-3.5 w-3.5 shrink-0 text-slate-300 opacity-0 transition group-hover:opacity-100" />
        </div>
      ),
    },
    {
      key: "company",
      header: "Company",
      show: true,
      render: (r) => <span className="text-slate-700">{r.companyName ?? "—"}</span>,
    },
    {
      key: "owner",
      header: "Owner",
      show: true,
      render: (r) => <span className="text-slate-600">{r.repName}</span>,
    },
    {
      key: "value",
      header: "Value",
      numeric: true,
      show: hasValue,
      render: (r) => (r.value == null ? "—" : usd(r.value)),
    },
    {
      key: "date",
      header: ev.dateAxisLabel,
      show: true,
      render: (r) => <span className="whitespace-nowrap text-slate-600">{formatCohortDate(r.cohortDate)}</span>,
    },
    {
      // The deal's real win_probability, shown as-is. Hidden for leads (no win prob). Blank renders an em
      // dash via winPct — a missing value is "unknown", never "0%"/"NaN%".
      key: "winprob",
      header: "Win %",
      numeric: true,
      show: hasValue,
      render: (r) => <span className="text-slate-600">{winPct(r.winProbability)}</span>,
    },
    {
      key: "region",
      header: "Region",
      show: true,
      render: (r) => <span className="text-slate-600">{r.region ?? "—"}</span>,
    },
    {
      key: "type",
      header: "Type",
      show: true,
      render: (r) => <span className="text-slate-600">{r.dealType ?? "—"}</span>,
    },
    {
      key: "stage",
      header: "Stage",
      show: true,
      render: (r) => (
        <span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
          {r.stageLabel || "—"}
        </span>
      ),
    },
    {
      key: "age",
      header: "Age",
      numeric: true,
      show: true,
      render: (r) => (r.daysInStage == null ? "—" : `${int(r.daysInStage)}d`),
    },
  ];
  return cols.filter((c) => c.show);
}

function SortIcon({ state, colKey }: { state: SortState; colKey: SortKey }) {
  if (state.key !== colKey) return <ChevronsUpDown className="h-3 w-3 text-slate-300" />;
  return state.dir === "asc" ? (
    <ArrowUp className="h-3 w-3 text-slate-600" />
  ) : (
    <ArrowDown className="h-3 w-3 text-slate-600" />
  );
}

function ReconciliationBanner({ ev }: { ev: MondayShowcaseEvidence }) {
  const { total } = ev;
  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
      <span className="font-semibold">{int(total.count)}</span> {total.count === 1 ? "record" : "records"}
      {total.value != null && (
        <>
          {" · "}
          <span className="font-semibold">{usd(total.value)}</span>
        </>
      )}
      {total.basisLabel && <span className="text-emerald-700"> · {total.basisLabel}</span>}
      <div className="mt-0.5 text-xs text-emerald-700">
        These are the exact records behind the number — they reconcile to it by construction.
      </div>
    </div>
  );
}

function EvidenceTable({ ev, onOpenRecord }: { ev: MondayShowcaseEvidence; onOpenRecord: (r: EvidenceRecord) => void }) {
  const hasValue = ev.metric !== "leads";
  const [sort, setSort] = useState<SortState>({
    key: hasValue ? "value" : "age",
    dir: "desc",
  });
  const columns = columnsFor(ev);
  const rows = sortRecords(ev.records, sort);

  function toggleSort(key: SortKey) {
    setSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : { key, dir: NUMERIC_KEYS.has(key) ? "desc" : "asc" }
    );
  }

  return (
    <Table>
      <TableHeader className="sticky top-0 z-10 bg-popover">
        <TableRow className="hover:bg-transparent">
          {/* Disciplined alignment: numeric columns right / text left, with a uniform px-3 gutter on
              every header + cell so spacing reads as a grid, not random. The header alignment mirrors
              its column's data (flex-row-reverse keeps the sort caret on the edge the numbers align to). */}
          {columns.map((col) => (
            <TableHead key={col.key} className={cn("px-3", col.numeric ? "text-right" : "text-left")}>
              <button
                type="button"
                onClick={() => toggleSort(col.key)}
                className={`inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-slate-500 transition hover:text-slate-800 ${
                  col.numeric ? "flex-row-reverse" : ""
                }`}
                title={`Sort by ${col.header}`}
              >
                {col.header}
                <SortIcon state={sort} colKey={col.key} />
              </button>
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          // Empty cohort (e.g. an empty 0–30d projection band): keep the headers above so the column
          // set — including Win % — stays consistent with non-empty cohorts, and show the empty-state
          // copy as a single spanning row instead of swapping the whole table out.
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={columns.length} className="px-3 py-6 text-center text-sm text-muted-foreground">
              No supporting records for this number in this period.
            </TableCell>
          </TableRow>
        ) : (
          rows.map((r) => (
            <TableRow
              key={r.id}
              className="group cursor-pointer"
              onClick={() => onOpenRecord(r)}
              title={`Open the ${ev.metric === "leads" ? "lead" : "deal"} record`}
            >
              {columns.map((col) => (
                <TableCell key={col.key} className={cn("px-3", col.numeric ? "text-right tabular-nums" : "text-left")}>
                  {col.render(r)}
                </TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

export function EvidenceDrawer({
  request,
  mode,
  onClose,
}: {
  request: EvidenceRequest | null;
  mode: "to_date" | "completed";
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { search } = useLocation();
  const { data, loading, error } = useShowcaseEvidence(request, mode);

  function openRecord(r: EvidenceRecord) {
    if (!data) return;
    // Carry the current query string (notably ?officeId=) so the detail page's API calls stay scoped to the
    // office whose report produced this evidence — matching the at-risk watchlist's row navigation.
    navigate({ pathname: data.metric === "leads" ? `/leads/${r.id}` : `/deals/${r.id}`, search });
    onClose();
  }

  return (
    <Dialog
      open={request != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex max-h-[85vh] w-[min(96vw,1120px)] flex-col gap-3 sm:max-w-[min(96vw,1120px)]">
        <DialogHeader className="pr-8">
          <DialogTitle>{request?.title ?? "Supporting records"}</DialogTitle>
          <DialogDescription>
            {request?.subtitle ? `${request.subtitle} · ` : ""}
            {data ? data.period.label : ""}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
        ) : data ? (
          <div className="flex min-h-0 flex-col gap-3">
            <ReconciliationBanner ev={data} />
            {/* Always render the table (with headers) — even for an empty cohort — so the column set,
                notably the Win % column, stays consistent across bands. The empty-state message lives
                inside the table body (EvidenceTable) instead of swapping the whole table out. */}
            <ScrollSyncX
              className="flex min-h-0 flex-1 flex-col rounded-lg border border-slate-100"
              bodyClassName="min-h-0 flex-1 overflow-auto"
            >
              <EvidenceTable ev={data} onOpenRecord={openRecord} />
            </ScrollSyncX>
            <p className="px-1 text-xs text-muted-foreground">
              Shown on the {data.dateAxisLabel.toLowerCase()} axis — the cohort this number is defined on.
              Click a column to sort; click a row to open the record.
            </p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
