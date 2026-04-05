import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPrintableReportHtml,
  buildReportExportFilename,
  downloadTextFile,
  normalizeReportRows,
  openPrintableReportWindow,
  serializeRowsToCsv,
} from "./report-export";

describe("report export helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("builds a stable filename from the report name", () => {
    expect(
      buildReportExportFilename("Pipeline Summary", "pdf", new Date("2026-04-05T15:00:00Z")),
    ).toBe("pipeline-summary-2026-04-05.pdf");
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

  it("neutralizes spreadsheet formulas in csv cells", () => {
    expect(
      serializeRowsToCsv([
        { title: "=SUM(A1:A2)" },
        { title: "\t=HYPERLINK(\"https://example.com\")" },
      ]),
    ).toContain("'=SUM(A1:A2)");
    expect(
      serializeRowsToCsv([
        { title: "\t=HYPERLINK(\"https://example.com\")" },
      ]),
    ).toContain("'\t=HYPERLINK");
  });

  it("renders printable html with report title and tabular rows", () => {
    const html = buildPrintableReportHtml({
      reportName: "Pipeline Summary",
      rows: [{ stageName: "Bid Sent", totalValue: 100000 }],
      generatedAtLabel: "Apr 5, 2026 3:00 PM",
      metadata: [{ label: "Date range", value: "Apr 1, 2026 - Apr 5, 2026" }],
    });

    expect(html).toContain("Pipeline Summary");
    expect(html).toContain("Bid Sent");
    expect(html).toContain("Apr 5, 2026 3:00 PM");
    expect(html).toContain("Date range");
  });

  it("downloads text content through an anchor element", async () => {
    const click = vi.fn();
    const remove = vi.fn();
    const append = vi.fn();
    const anchor = {
      click,
      href: "",
      download: "",
    };

    const createElement = vi.fn(() => anchor);
    const createObjectURL = vi.fn(() => "blob:report");
    const revokeObjectURL = vi.fn();

    vi.stubGlobal("document", {
      createElement,
      body: {
        appendChild: append,
        removeChild: remove,
      },
    });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    vi.stubGlobal("Blob", Blob);

    downloadTextFile("a,b", "report.csv", "text/csv;charset=utf-8;");

    expect(createElement).toHaveBeenCalledWith("a");
    expect(append).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(anchor);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:report");
  });

  it("opens a printable window and writes the html", () => {
    const open = vi.fn(() => ({
      document: {
        open: vi.fn(),
        write: vi.fn(),
        close: vi.fn(),
      },
      focus: vi.fn(),
      print: vi.fn(),
    }));

    vi.stubGlobal("window", { open });

    openPrintableReportWindow("<html></html>");

    expect(open).toHaveBeenCalledWith("", "_blank");
  });
});
