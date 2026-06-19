// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceMetric, EvidenceRecord, MondayShowcaseEvidence } from "./types";

// Controllable mock of the data hook so we can render the drawer with a fixed evidence payload.
const hookState: { data: MondayShowcaseEvidence | null } = { data: null };
vi.mock("@/hooks/use-reports", () => ({
  useShowcaseEvidence: () => ({ data: hookState.data, loading: false, error: null }),
}));

import { EvidenceDrawer } from "./evidence-drawer";

function record(over: Partial<EvidenceRecord>): EvidenceRecord {
  return {
    id: "d1",
    dealNumber: "1001",
    name: "Deal One",
    repId: "r1",
    repName: "Alice",
    stageLabel: "Estimating",
    value: 1000,
    cohortDate: "2026-06-20",
    companyName: "Acme",
    region: "Central",
    dealType: "Commercial",
    daysInStage: 4,
    winProbability: null,
    ...over,
  };
}

function evidence(metric: EvidenceMetric, records: EvidenceRecord[]): MondayShowcaseEvidence {
  return {
    metric,
    metricLabel: "Projected (open)",
    dateAxisLabel: "Expected close date",
    period: { from: "2026-06-01", to: "2026-06-12", mode: "to_date", label: "2026-06-01 → 2026-06-12" },
    scope: { kind: "office" },
    band: null,
    leadStage: null,
    total: { count: records.length, value: 1000, basisLabel: "Best current estimate" },
    records,
  };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  hookState.data = null;
});

function mount(metric: EvidenceMetric, records: EvidenceRecord[]) {
  hookState.data = evidence(metric, records);
  act(() => {
    root.render(
      <MemoryRouter>
        <EvidenceDrawer request={{ metric, title: "Evidence" }} mode="to_date" onClose={() => {}} />
      </MemoryRouter>
    );
  });
}

describe("evidence drawer Win % column", () => {
  it("shows a Win % column with the real value and an em dash (never NaN%/0%) for blanks", () => {
    mount("projection", [record({ id: "a", winProbability: 65 }), record({ id: "b", winProbability: null })]);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Win %");
    expect(text).toContain("65%");
    expect(text).toContain("—"); // the blank win-prob cell renders the em dash
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("0%");
  });

  it("hides the Win % column for the leads metric (leads have no win probability)", () => {
    mount("leads", [record({ id: "c", winProbability: null, value: null })]);
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Win %");
  });

  it("still shows the Win % column header (and all headers) for an EMPTY cohort", () => {
    // An empty projection band (e.g. an empty 0–30d forecast-ladder cell) must keep its column
    // headers — including Win % — so it reads consistently with the non-empty bands. Regression:
    // the drawer used to swap the whole table for a bare message, dropping every header.
    mount("projection", []);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Win %");
    // The empty-state copy is preserved — just moved inside the table body.
    expect(text).toContain("No supporting records for this number in this period.");
    // Header row still renders all the metric's columns.
    const heads = Array.from(document.querySelectorAll("thead th"));
    const headText = heads.map((h) => h.textContent ?? "");
    for (const label of ["Deal", "Company", "Owner", "Value", "Win %", "Region", "Type", "Stage", "Age"]) {
      expect(headText.some((t) => t.includes(label))).toBe(true);
    }
    // No data rows, but the empty-state row is present.
    expect(document.querySelectorAll("tbody tr").length).toBe(1);
  });
});

describe("evidence drawer horizontal scroll + CSV export", () => {
  it("gives the table a min-width so wide column sets overflow (scroll) instead of compressing", () => {
    mount("projection", [record({ id: "a" })]);
    const table = document.querySelector("table");
    expect(table).not.toBeNull();
    // The table min-width is the sum of the visible columns' floor widths (the deal column set), so the
    // table is wider than a narrow dialog and the columns stay legible — ScrollSyncX then has something
    // to scroll. (jsdom does no layout, but the inline style is what drives the overflow in the browser.)
    const minWidth = parseInt((table as HTMLTableElement).style.minWidth || "0", 10);
    expect(minWidth).toBeGreaterThan(900);
    // Every header carries its own per-column min-width floor.
    const heads = Array.from(document.querySelectorAll("thead th")) as HTMLTableCellElement[];
    expect(heads.length).toBeGreaterThan(0);
    expect(heads.every((h) => parseInt(h.style.minWidth || "0", 10) > 0)).toBe(true);
  });

  it("does NOT wrap the table in the shadcn overflow container — one scroll container (ScrollSyncX body)", () => {
    mount("projection", [record({ id: "a" })]);
    // The shadcn <Table> wrapper would add a [data-slot=table-container] overflow-x-auto div that competes
    // with — and defeats — ScrollSyncX's synced top rail. We render a bare <table> instead.
    expect(document.querySelector('[data-slot="table-container"]')).toBeNull();
    expect(document.querySelector('[data-testid="scrollsync-body"]')).not.toBeNull();
  });

  it("renders an Export CSV button on the popup", () => {
    mount("projection", [record({ id: "a" })]);
    const button = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Export CSV")
    );
    expect(button).toBeTruthy();
  });

  it("keeps the Export CSV button available for an empty cohort (export still works)", () => {
    mount("projection", []);
    const button = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Export CSV")
    );
    expect(button).toBeTruthy();
  });
});

describe("evidence drawer column alignment", () => {
  it("right-aligns numeric columns, left-aligns text, with a uniform px-3 gutter on every column", () => {
    mount("projection", [record({ id: "a", winProbability: 65 })]);
    const heads = Array.from(document.querySelectorAll("thead th"));
    const cells = Array.from(document.querySelectorAll("tbody tr:first-child td"));
    expect(heads.length).toBeGreaterThan(0);

    // Uniform horizontal gutter on every header AND cell — even spacing, not random.
    expect(heads.every((h) => h.className.includes("px-3"))).toBe(true);
    expect(cells.every((c) => c.className.includes("px-3"))).toBe(true);

    const headByText = (label: string) => heads.find((h) => (h.textContent ?? "").includes(label));
    // Numeric → right-aligned (header matches its data).
    for (const num of ["Value", "Win %", "Age"]) {
      expect(headByText(num)?.className).toContain("text-right");
    }
    // Text → left-aligned (every text column, including Expected close date — stays left, not flush
    // against Value).
    for (const txt of ["Deal", "Company", "Owner", "Expected close date", "Region", "Type", "Stage"]) {
      expect(headByText(txt)?.className).toContain("text-left");
    }
    // Cells mirror their header: numeric right-aligned (+ tabular-nums so percentages and em dashes
    // line up on the right edge); every other cell explicitly left-aligned.
    const numericCells = cells.filter((c) => c.className.includes("text-right"));
    const textCells = cells.filter((c) => !c.className.includes("text-right"));
    expect(numericCells.length).toBeGreaterThan(0);
    expect(textCells.length).toBeGreaterThan(0);
    expect(numericCells.every((c) => c.className.includes("tabular-nums"))).toBe(true);
    expect(textCells.every((c) => c.className.includes("text-left"))).toBe(true);
  });
});
