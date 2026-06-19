# Reports drill-down popups: horizontal scroll + CSV export

Branch: `feat/reports-evidence-scroll-csv` (off main @ a8351595, which includes #770).

## Phase 0 — Discovery (verified)

- **ONE shared component**: `client/src/pages/reports/monday-showcase/evidence-drawer.tsx`
  (`EvidenceDrawer`), re-exported via `evidence-kit.tsx:10`. Consumers: monday-showcase-page,
  region-report-page (direct), forecast-confidence-page, rep-pack-page (via evidence-kit).
  → Fix once, both features land on every reports/Monday-Showcase drill-down. (at-risk-page uses
  only the formatters, not the drawer.)
- **Full cohort is client-side, not paginated**: `useShowcaseEvidence` (use-reports.ts:1401) sets
  `data = result.data` with all `records: EvidenceRecord[]` (no limit/page param). Drawer line 31
  comment: "the records are the full reconciling set". → CSV exports `data.records` directly = the
  full reconciling cohort **by construction**.
- **Columns**: `columnsFor(ev)` → ordered, `show`-filtered: Deal/Lead, Company, Owner, Value(deals),
  `dateAxisLabel`, Win %(deals), Region, Type, Stage, Age.
- **Horizontal-scroll root cause**: `ScrollSyncX` (PR #689 top rail) is present but **inert** — the
  shadcn `<Table>` wraps `<table class="w-full">` in its *own* `overflow-x-auto` div AND the table
  has no `min-width`, so 10 columns compress to fit instead of overflowing. Nothing scrolls.
- **Reusable CSV util**: `client/src/lib/report-export.ts` — canonical escaper (CSV-injection
  `'`-prefix + quote-doubling), `downloadTextFile()`, `buildReportExportFilename(name,"csv",now)`.

## Build

1. **`evidence-columns.ts`** (new, pure — no JSX): single source of truth for the column set —
   `key`, `header(ev)`, `numeric`, `minWidth`, `show(ev)`, and a **`csv(r)`** accessor. Shared by the
   table (display) and the CSV (export) so the CSV column set === the popup's column set by
   construction (R2). Move `SortKey` here.
2. **`evidence-csv.ts`** (new, pure): `buildEvidenceCsv(ev)` (header row from `header(ev)` + one row
   per `ev.records` via `csv(r)`, full cohort, header-only when empty) and
   `buildEvidenceCsvFilename(request, ev, now?)` (`<title>-<scope>-<YYYY-MM-DD>.csv`, e.g.
   `projected-31-60d-office-2026-06-19.csv`). Reuses report-export's escaper +
   `buildReportExportFilename`. Adds `serializeCsvTable(header, rows)` to report-export.ts (explicit
   header array → handles the empty cohort; existing `serializeRowsToCsv` shares the extracted
   `escapeCsvValue`).
3. **Drawer table**: drop the shadcn `<Table>` wrapper; render a plain `<table style={{minWidth}}>`
   using the sub-components (TableHeader/Body/Row/Head/Cell keep their classes — `px-3`,
   `text-right/left`, `tabular-nums` — so existing tests hold). Per-column `minWidth` + `whitespace-
   nowrap` keep columns legible; the table overflows so **ScrollSyncX's body is the sole scroll
   container** → top rail + horizontal scroll go live. Name cell keeps `truncate` (max-w cap).
4. **Export CSV button**: in the drawer toolbar next to the reconciliation banner (only when `data`).
   `downloadTextFile(buildEvidenceCsv(data), buildEvidenceCsvFilename(request,data), "text/csv;charset=utf-8")`.

## Decisions (documented)

- **CSV values are RAW** (Value/Win%/Age as numbers, date as ISO `YYYY-MM-DD`, text as-is, null→empty
  cell). Rationale: the Value column sums back to `total.value` in a spreadsheet (reconciles); avoids
  the formatCurrency hazard entirely. The task explicitly permits raw numbers.
- **CSV order** = `ev.records` natural (server) order — deterministic, decoupled from the table's live
  sort. Completeness (all rows), not order, is the reconciliation criterion.
- **Empty cohort**: button stays enabled; export is a header-only CSV (columns still discoverable).
- Tests named `*.runtime.test.*` to gate-execute.
