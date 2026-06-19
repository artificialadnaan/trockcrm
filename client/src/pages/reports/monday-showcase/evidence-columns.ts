// Single source of truth for the evidence-drawer column set. The on-screen TABLE (evidence-drawer.tsx)
// and the CSV EXPORT (evidence-csv.ts) both derive their columns from this list, so the exported file
// has the exact same columns (same set, order, headers, show-filter) as the popup it came from — they
// reconcile by construction. This file is pure (no JSX) so the CSV builder + its tests stay React-free;
// the drawer attaches the per-column React `render` separately.
import type { EvidenceRecord, MondayShowcaseEvidence } from "./types";

export type SortKey =
  | "name"
  | "company"
  | "owner"
  | "value"
  | "date"
  | "winprob"
  | "region"
  | "type"
  | "stage"
  | "age";

export interface EvidenceColumn {
  key: SortKey;
  /** Header label. A function of the payload because two headers are dynamic: the name column reads
   *  "Deal"/"Lead" by metric, and the date column reads the cohort's `dateAxisLabel`. */
  header: (ev: MondayShowcaseEvidence) => string;
  /** Right-aligned numeric column (display + sort default). */
  numeric?: boolean;
  /** Per-column floor width (px) so the table keeps legible columns and overflows (horizontal scroll)
   *  instead of compressing everything to fit the dialog. The table's min-width is the sum of these. */
  minWidth: number;
  /** Whether this column shows for the given payload (leads have no Value / Win %). */
  show: (ev: MondayShowcaseEvidence) => boolean;
  /** CSV cell value — the RAW underlying datum (number/ISO date/string), null → empty cell. Numbers are
   *  unformatted on purpose so the Value column sums back to the cohort total in a spreadsheet and so the
   *  CSV sidesteps display formatting. The UI's em-dash placeholders become empty cells here. */
  csv: (r: EvidenceRecord) => string | number | null;
}

const hasValue = (ev: MondayShowcaseEvidence) => ev.metric !== "leads";
const always = () => true;

// Order MUST match the on-screen table. Header labels MUST match the table's headers (the date header is
// the cohort's dateAxisLabel; the name header is Deal/Lead). minWidths are display floors only.
export const EVIDENCE_COLUMNS: readonly EvidenceColumn[] = [
  { key: "name", header: (ev) => (ev.metric === "leads" ? "Lead" : "Deal"), minWidth: 220, show: always, csv: (r) => r.name },
  { key: "company", header: () => "Company", minWidth: 160, show: always, csv: (r) => r.companyName },
  { key: "owner", header: () => "Owner", minWidth: 130, show: always, csv: (r) => r.repName },
  { key: "value", header: () => "Value", numeric: true, minWidth: 110, show: hasValue, csv: (r) => r.value },
  { key: "date", header: (ev) => ev.dateAxisLabel, minWidth: 150, show: always, csv: (r) => r.cohortDate },
  { key: "winprob", header: () => "Win %", numeric: true, minWidth: 90, show: hasValue, csv: (r) => r.winProbability },
  { key: "region", header: () => "Region", minWidth: 120, show: always, csv: (r) => r.region },
  { key: "type", header: () => "Type", minWidth: 120, show: always, csv: (r) => r.dealType },
  { key: "stage", header: () => "Stage", minWidth: 140, show: always, csv: (r) => r.stageLabel },
  { key: "age", header: () => "Age", numeric: true, minWidth: 80, show: always, csv: (r) => r.daysInStage },
];

/** The columns shown for this payload, in order — the shared basis for the table AND the CSV. */
export function visibleEvidenceColumns(ev: MondayShowcaseEvidence): EvidenceColumn[] {
  return EVIDENCE_COLUMNS.filter((c) => c.show(ev));
}
