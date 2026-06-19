// CSV export for the reports/Monday-Showcase drill-down drawer. Builds from the SAME column source the
// table renders (evidence-columns.ts) and the SAME `ev.records` the drawer shows — which is the full
// reconciling cohort (not a page) — so the export covers every record and every column, reconciling to
// the clicked number by construction. Pure (no DOM/React): the drawer wires the download.
import { buildReportExportFilename, serializeCsvTable } from "@/lib/report-export";
import { visibleEvidenceColumns } from "./evidence-columns";
import type { EvidenceRequest, MondayShowcaseEvidence } from "./types";

/**
 * Serialize the drawer's full cohort to CSV: header row = the visible columns' labels (exactly the
 * popup's headers, in order); one row per record (RAW values — numbers unformatted, dates as ISO,
 * null → empty cell). Rows are in the cohort's natural order. An empty cohort still emits the header row.
 */
export function buildEvidenceCsv(ev: MondayShowcaseEvidence): string {
  const columns = visibleEvidenceColumns(ev);
  const header = columns.map((c) => c.header(ev));
  const rows = ev.records.map((r) => columns.map((c) => c.csv(r)));
  return serializeCsvTable(header, rows);
}

function scopeLabel(ev: MondayShowcaseEvidence): string {
  switch (ev.scope.kind) {
    case "office":
      return "office";
    case "rep":
      return ev.scope.repName || "rep";
    case "region":
      return ev.scope.regionName || "region";
  }
}

/**
 * Filename for the exported cohort, reflecting the popup: `<title>-<scope>-<YYYY-MM-DD>.csv`
 * (e.g. `projected-31-60d-office-2026-06-19.csv`). Reuses the shared slug+date builder.
 */
export function buildEvidenceCsvFilename(
  request: EvidenceRequest,
  ev: MondayShowcaseEvidence,
  now = new Date(),
): string {
  return buildReportExportFilename(`${request.title} ${scopeLabel(ev)}`, "csv", now);
}
