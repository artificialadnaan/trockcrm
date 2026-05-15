import { describe, expect, it } from "vitest";
import { createXlsxBlob } from "./excel-export";

async function decodeBlob(blob: Blob) {
  return new TextDecoder().decode(await blob.arrayBuffer());
}

describe("excel export", () => {
  it("builds xlsx files with headers and typed currency/date cells", async () => {
    const blob = createXlsxBlob({
      sheets: [
        {
          name: "Deals",
          columns: [
            { key: "dealName", header: "Deal" },
            { key: "value", header: "Value", type: "currency" },
            { key: "wonAt", header: "Won Date", type: "date" },
          ],
          rows: [
            { dealName: "Medical Plaza", value: 1250000, wonAt: "2026-05-01" },
          ],
        },
      ],
    });

    const text = await decodeBlob(blob);

    expect(blob.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(text).toContain("PK");
    expect(text).toContain("<sheet name=\"Deals\"");
    expect(text).toContain("<t>Deal</t>");
    expect(text).toContain("<t>Value</t>");
    expect(text).toContain("<t>Won Date</t>");
    expect(text).toContain("<t>Medical Plaza</t>");
    expect(text).toContain('<c r="B2" s="1"><v>1250000</v></c>');
    expect(text).toContain("$#,##0.00;[Red]-$#,##0.00");
    expect(text).toContain('<c r="C2" s="2"><v>');
    expect(text).not.toContain("2026-05-01T");
  });

  it("normalizes inferred whole-number percentages for Excel percent cells", async () => {
    const blob = createXlsxBlob({
      sheets: [
        {
          name: "Metrics",
          columns: [{ key: "winRate", header: "Win Rate", type: "percent" }],
          rows: [{ winRate: 45 }],
        },
      ],
    });

    const text = await decodeBlob(blob);

    expect(text).toContain('<c r="A2" s="3"><v>0.45</v></c>');
    expect(text).toContain("0.0%");
  });
});

