import { useCallback, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, CalendarClock, ChevronsUpDown, Download, ExternalLink, Loader2 } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { resolveDealDisplayNumber } from "@/lib/deal-utils";
import { useShowcaseEvidence } from "@/hooks/use-reports";
import { MoveCloseDateDialog } from "@/components/deals/move-close-date-dialog";
import { useAuth } from "@/lib/auth";
import { downloadTextFile } from "@/lib/report-export";
import { usd, int, winPct } from "../format";
import { ScrollSyncX } from "../scroll-sync-x";
import { EVIDENCE_COLUMNS, visibleEvidenceColumns, type SortKey } from "./evidence-columns";
import { buildEvidenceCsv, buildEvidenceCsvFilename } from "./evidence-csv";
import type { EvidenceRecord, EvidenceRequest, MondayShowcaseEvidence } from "./types";
import type { WeekMode } from "../week-mode";

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
// SortKey + the column set come from the shared evidence-columns source, so the table and the CSV export
// stay in lockstep. NUMERIC_KEYS (numeric default-sort-descending) is derived from those defs.
interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}
const NUMERIC_KEYS: ReadonlySet<SortKey> = new Set(
  EVIDENCE_COLUMNS.filter((c) => c.numeric).map((c) => c.key)
);

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

// Per-column React renderers (display only). Keyed by SortKey so they pair with the shared column defs;
// the column SET + order + headers + show-filter live in evidence-columns.ts (shared with the CSV), and
// these are only how each cell looks on screen.
const RENDERERS: Record<SortKey, (r: EvidenceRecord) => ReactNode> = {
  name: (r) => {
    // Canonical DFW/ATL number via the shared resolver — never the meaningless HubSpot id. Null = no real
    // number (Pending): omit the identifier line entirely rather than show a chip or the HS id.
    const displayNumber = resolveDealDisplayNumber({ projectNumber: r.projectNumber, dealNumber: r.dealNumber });
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="min-w-0">
          <div className="max-w-[260px] truncate font-medium text-sky-700 group-hover:underline">{r.name}</div>
          {displayNumber ? <div className="text-xs text-slate-400">#{displayNumber}</div> : null}
        </div>
        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-slate-300 opacity-0 transition group-hover:opacity-100" />
      </div>
    );
  },
  company: (r) => <span className="text-slate-700">{r.companyName ?? "—"}</span>,
  owner: (r) => <span className="text-slate-600">{r.repName}</span>,
  value: (r) => (r.value == null ? "—" : usd(r.value)),
  // The deal's real win_probability, shown as-is. Blank renders an em dash via winPct — a missing value is
  // "unknown", never "0%"/"NaN%".
  date: (r) => <span className="whitespace-nowrap text-slate-600">{formatCohortDate(r.cohortDate)}</span>,
  winprob: (r) => <span className="text-slate-600">{winPct(r.winProbability)}</span>,
  region: (r) => <span className="text-slate-600">{r.region ?? "—"}</span>,
  type: (r) => <span className="text-slate-600">{r.dealType ?? "—"}</span>,
  stage: (r) => (
    <span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
      {r.stageLabel || "—"}
    </span>
  ),
  age: (r) => (r.daysInStage == null ? "—" : `${int(r.daysInStage)}d`),
};

interface DisplayColumn {
  key: SortKey;
  header: string;
  numeric?: boolean;
  minWidth: number;
  render: (r: EvidenceRecord) => ReactNode;
}

// Resolve the shared (visible) columns into display columns: header text + per-column min-width come from
// the shared source, the render from RENDERERS. Same set/order the CSV exports.
function columnsFor(ev: MondayShowcaseEvidence): DisplayColumn[] {
  return visibleEvidenceColumns(ev).map((col) => ({
    key: col.key,
    header: col.header(ev),
    numeric: col.numeric,
    minWidth: col.minWidth,
    render: RENDERERS[col.key],
  }));
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

function EvidenceTable({
  ev,
  onOpenRecord,
  onSetDate,
  canEditRecord,
}: {
  ev: MondayShowcaseEvidence;
  onOpenRecord: (r: EvidenceRecord) => void;
  /** present only for the `undated` metric: opens the inline close-date editor for that deal. */
  onSetDate?: (r: EvidenceRecord) => void;
  /** Per-row edit gate: the inline close-date write hits the OWNER-ONLY PATCH /deals/:id, so the action
   *  is offered only on rows the viewer owns. Mirrors deal-detail's canMoveCloseDate={viewerOwnsDeal}. */
  canEditRecord?: (r: EvidenceRecord) => boolean;
}) {
  const hasValue = ev.metric !== "leads";
  const [sort, setSort] = useState<SortState>({
    key: hasValue ? "value" : "age",
    dir: "desc",
  });
  const columns = columnsFor(ev);
  const rows = sortRecords(ev.records, sort);
  const canEdit = canEditRecord ?? (() => false);
  // The undated ("No future close date") list gets a trailing action column to set a close date inline.
  // It lives OUTSIDE the shared EVIDENCE_COLUMNS (so the CSV export is unaffected) — a display-only column.
  // The inline write hits the owner-only PATCH /deals/:id, and the office-wide undated drawer (which a rep
  // can open on the rep-accessible Showcase) lists EVERY rep's undated deals — so the column appears only
  // when the viewer owns at least one row here, and the button renders per-row only on owned rows. This
  // prevents the "click a coworker's row → 403" trap (hide the action rather than show-then-403).
  const showAction = ev.metric === "undated" && !!onSetDate && ev.records.some((r) => canEdit(r));
  const ACTION_COL_WIDTH = 150;
  // Sum of the visible columns' floor widths (+ the action column when present). Applied as the table's
  // min-width so the columns keep their legible widths and the table OVERFLOWS the dialog instead of
  // compressing — which is what gives ScrollSyncX's body something to scroll (right-edge columns reachable).
  const tableMinWidth = columns.reduce((sum, col) => sum + col.minWidth, 0) + (showAction ? ACTION_COL_WIDTH : 0);

  function toggleSort(key: SortKey) {
    setSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : { key, dir: NUMERIC_KEYS.has(key) ? "desc" : "asc" }
    );
  }

  // Plain <table> (not the shadcn <Table> wrapper): that wrapper adds its OWN overflow-x-auto div, which
  // would compete with — and defeat — ScrollSyncX's scroll container (and its synced top rail). Rendering
  // the sub-components in a bare <table> leaves ScrollSyncX's body as the single horizontal scroller.
  return (
    <table className="w-full caption-bottom text-sm" style={{ minWidth: tableMinWidth }}>
      <TableHeader className="sticky top-0 z-10 bg-popover">
        <TableRow className="hover:bg-transparent">
          {/* Disciplined alignment: numeric columns right / text left, with a uniform px-3 gutter on
              every header + cell so spacing reads as a grid, not random. The header alignment mirrors
              its column's data (flex-row-reverse keeps the sort caret on the edge the numbers align to). */}
          {columns.map((col) => (
            <TableHead
              key={col.key}
              style={{ minWidth: col.minWidth }}
              className={cn("whitespace-nowrap px-3", col.numeric ? "text-right" : "text-left")}
            >
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
          {showAction ? (
            <TableHead style={{ minWidth: ACTION_COL_WIDTH }} className="whitespace-nowrap px-3 text-right">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Action</span>
            </TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          // Empty cohort (e.g. an empty 0–30d projection band): keep the headers above so the column
          // set — including Win % — stays consistent with non-empty cohorts, and show the empty-state
          // copy as a single spanning row instead of swapping the whole table out.
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={columns.length + (showAction ? 1 : 0)} className="px-3 py-6 text-center text-sm text-muted-foreground">
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
                <TableCell
                  key={col.key}
                  style={{ minWidth: col.minWidth }}
                  className={cn("whitespace-nowrap px-3", col.numeric ? "text-right tabular-nums" : "text-left")}
                >
                  {col.render(r)}
                </TableCell>
              ))}
              {showAction ? (
                <TableCell style={{ minWidth: ACTION_COL_WIDTH }} className="whitespace-nowrap px-3 text-right">
                  {/* Owner-only: a non-owned row (e.g. a coworker's deal on the office-wide undated list)
                      gets a blank action cell — the close-date write would 403, so don't offer the button. */}
                  {canEdit(r) ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation(); // don't also navigate to the deal — this is the inline edit
                        onSetDate!(r);
                      }}
                      className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 transition hover:bg-amber-100"
                      title="Set a close date for this deal"
                    >
                      <CalendarClock className="h-3.5 w-3.5" />
                      Set close date
                    </button>
                  ) : null}
                </TableCell>
              ) : null}
            </TableRow>
          ))
        )}
      </TableBody>
    </table>
  );
}

export function EvidenceDrawer({
  request,
  mode,
  onClose,
  onMutated,
}: {
  request: EvidenceRequest | null;
  mode: WeekMode;
  onClose: () => void;
  /** Called after an inline edit lands (a close-date move on the undated list) so the parent showcase
   *  can refetch — the edited deal then re-bands and leaves the "No future close date" card. */
  onMutated?: () => void | Promise<void>;
}) {
  const navigate = useNavigate();
  const { search } = useLocation();
  const { user } = useAuth();
  const { data, loading, error, refetch } = useShowcaseEvidence(request, mode);
  // The row whose close date is being set inline (undated list only); null = the editor is closed.
  const [editing, setEditing] = useState<EvidenceRecord | null>(null);
  // The inline close-date editor writes through the OWNER-ONLY PATCH /deals/:id (the same gate the deal
  // detail uses: canMoveCloseDate={viewerOwnsDeal}). The Monday Showcase is rep-accessible and its
  // office-wide undated drawer lists EVERY rep's undated deals, so offer "Set close date" only on rows the
  // viewer owns — a coworker's row would only 403. Directors/admins are not special here: the field PATCH
  // has no leadership bypass, so the gate is ownership for everyone. (CodeRabbit P2)
  const canEditRecord = useCallback(
    (r: EvidenceRecord) => user?.id != null && r.repId === user.id,
    [user?.id]
  );
  // The office the report is scoped to (cross-office views carry ?officeId=); thread it into the PATCH so
  // the write targets the same tenant the evidence was read from — matching openRecord's navigation.
  const officeId = new URLSearchParams(search).get("officeId");

  function openRecord(r: EvidenceRecord) {
    if (!data) return;
    // Carry the current query string (notably ?officeId=) so the detail page's API calls stay scoped to the
    // office whose report produced this evidence — matching the at-risk watchlist's row navigation.
    navigate({ pathname: data.metric === "leads" ? `/leads/${r.id}` : `/deals/${r.id}`, search });
    onClose();
  }

  // Export the WHOLE cohort (data.records is the full reconciling set, not a page) with every column —
  // exactly what the popup shows, reconciling to the clicked number by construction. Header-only when empty.
  function exportCsv() {
    if (!data || !request) return;
    downloadTextFile(buildEvidenceCsv(data), buildEvidenceCsvFilename(request, data), "text/csv;charset=utf-8");
  }

  return (
    <>
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
            {/* Toolbar: the reconciliation banner + the CSV export, side by side near the count. */}
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <ReconciliationBanner ev={data} />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={exportCsv}
                className="shrink-0 gap-1.5"
                title="Download every record in this popup (all columns) as a CSV"
              >
                <Download className="h-4 w-4" />
                Export CSV
              </Button>
            </div>
            {/* Always render the table (with headers) — even for an empty cohort — so the column set,
                notably the Win % column, stays consistent across bands. The empty-state message lives
                inside the table body (EvidenceTable) instead of swapping the whole table out. */}
            <ScrollSyncX
              className="flex min-h-0 flex-1 flex-col rounded-lg border border-slate-100"
              bodyClassName="min-h-0 flex-1 overflow-auto"
            >
              <EvidenceTable
                ev={data}
                onOpenRecord={openRecord}
                onSetDate={data.metric === "undated" ? setEditing : undefined}
                canEditRecord={canEditRecord}
              />
            </ScrollSyncX>
            <p className="px-1 text-xs text-muted-foreground">
              Shown on the {data.dateAxisLabel.toLowerCase()} axis — the cohort this number is defined on.
              Click a column to sort; click a row to open the record.
            </p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>

    {/* Inline close-date editor for the undated list. Reuses the deal detail's MoveCloseDateDialog so the
        write path + activity-note audit are identical. On save we refetch the evidence list (the now-dated
        deal drops out of this M − N set) AND notify the parent so the showcase re-bands it; the dialog
        closes itself via onOpenChange. */}
      <MoveCloseDateDialog
        open={editing != null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        dealId={editing?.id ?? ""}
        currentDate={editing?.cohortDate ?? null}
        officeId={officeId}
        onSaved={async () => {
          await refetch?.();
          await onMutated?.();
        }}
      />
    </>
  );
}
