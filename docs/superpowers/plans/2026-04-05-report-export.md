# Report Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real report export for the Reports page so users can export the currently selected report as PDF and CSV using the actual executed dataset.

**Architecture:** Keep export logic in the client because report execution already happens there and the data is already loaded in-memory. Add a small pure utility module for filename generation, table normalization, CSV serialization, and printable HTML generation; then wire export actions into the existing Reports page and report drawer so exporting reuses live report metadata instead of rebuilding report queries.

**Tech Stack:** React, TypeScript, Vite, Vitest

---

### Task 1: Export Utility Module

**Files:**
- Create: `client/src/lib/report-export.ts`
- Create: `client/src/lib/report-export.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  buildReportExportFilename,
  normalizeReportRows,
  serializeRowsToCsv,
} from "./report-export";

describe("report export helpers", () => {
  it("builds a stable filename from the report name", () => {
    expect(buildReportExportFilename("Pipeline Summary", "pdf", new Date("2026-04-05T15:00:00Z")))
      .toBe("pipeline-summary-2026-04-05.pdf");
  });

  it("normalizes object and array report data into row arrays", () => {
    expect(normalizeReportRows({ totalValue: 1200, dealCount: 3 })).toEqual([
      { totalValue: 1200, dealCount: 3 },
    ]);
  });

  it("serializes rows to csv with escaped values", () => {
    expect(
      serializeRowsToCsv([
        { stage: "Bid Sent", value: 10 },
        { stage: "Closed, Won", value: 20 },
      ]),
    ).toContain("\"Closed, Won\"");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/lib/report-export.test.ts`
Expected: FAIL because `client/src/lib/report-export.ts` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
export function buildReportExportFilename(name: string, ext: "pdf" | "csv", now = new Date()) {
  const date = now.toISOString().slice(0, 10);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${slug || "report"}-${date}.${ext}`;
}

export function normalizeReportRows(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
  if (data && typeof data === "object") return [data as Record<string, unknown>];
  return [];
}

export function serializeRowsToCsv(rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]);
  const escape = (value: unknown) => {
    const text = value == null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
  };
  return [
    columns.map(escape).join(","),
    ...rows.map((row) => columns.map((column) => escape(row[column])).join(",")),
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/lib/report-export.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/report-export.ts client/src/lib/report-export.test.ts
git commit -m "feat: add report export helpers"
```

### Task 2: Reports Page Export Actions

**Files:**
- Modify: `client/src/pages/reports/reports-page.tsx`
- Modify: `client/src/hooks/use-reports.ts`
- Test: `client/src/lib/report-export.test.ts`

- [ ] **Step 1: Write the failing test**

Extend `client/src/lib/report-export.test.ts` with an HTML export test:

```ts
import { buildPrintableReportHtml } from "./report-export";

it("renders printable html with report title and tabular rows", () => {
  const html = buildPrintableReportHtml({
    reportName: "Pipeline Summary",
    rows: [{ stageName: "Bid Sent", totalValue: 100000 }],
    generatedAtLabel: "Apr 5, 2026 3:00 PM",
  });

  expect(html).toContain("Pipeline Summary");
  expect(html).toContain("Bid Sent");
  expect(html).toContain("Apr 5, 2026 3:00 PM");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/lib/report-export.test.ts`
Expected: FAIL because `buildPrintableReportHtml` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Add `buildPrintableReportHtml` plus page wiring that:
- exports CSV from the active report dataset
- opens a print-friendly window for PDF export
- disables export actions when there is no loaded report data
- changes the top-level `Export PDF` button from placeholder behavior to real export behavior for the active report
- adds explicit export actions in the report drawer so the user can export the selected report after preview

- [ ] **Step 4: Run verification**

Run:
- `npx vitest run client/src/lib/report-export.test.ts`
- `npm run typecheck --workspace=client`
- `npm run build --workspace=client`

Expected:
- tests PASS
- client typecheck PASS
- client build PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/reports/reports-page.tsx client/src/hooks/use-reports.ts client/src/lib/report-export.ts client/src/lib/report-export.test.ts
git commit -m "feat: add reports export actions"
```

### Task 3: Review and Deploy

**Files:**
- Review current diff only

- [ ] **Step 1: Run code review**

Use reviewer agents to check:
- contract alignment for report export
- UI behavior and edge cases
- test coverage gaps

- [ ] **Step 2: Fix review findings**

Address only concrete findings and rerun:
- `npx vitest run client/src/lib/report-export.test.ts`
- `npm run typecheck --workspace=client`
- `npm run build --workspace=client`

- [ ] **Step 3: Push and redeploy**

Run:
- `git push origin main`
- `railway deployment redeploy -s API -y`

- [ ] **Step 4: Verify production**

Run:
- `railway deployment list -s API`
- `curl -sSI https://api-production-ad218.up.railway.app`
- live browser check on `/reports`

- [ ] **Step 5: If review finds issues, repeat until clean**

No completion claim until:
- review returns no actionable issues
- local verification passes
- deploy succeeds
- live report export path is confirmed
