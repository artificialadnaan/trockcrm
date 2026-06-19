import { describe, expect, it } from "vitest";
import { buildEvidenceCsv, buildEvidenceCsvFilename } from "./evidence-csv";
import type {
  EvidenceMetric,
  EvidenceRecord,
  EvidenceScope,
  MondayShowcaseEvidence,
} from "./types";

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
    winProbability: 65,
    ...over,
  };
}

function evidence(
  metric: EvidenceMetric,
  records: EvidenceRecord[],
  over: Partial<MondayShowcaseEvidence> = {},
): MondayShowcaseEvidence {
  return {
    metric,
    metricLabel: "Projected (open)",
    dateAxisLabel: "Expected close date",
    period: { from: "2026-06-01", to: "2026-06-12", mode: "to_date", label: "2026-06-01 → 2026-06-12" },
    scope: { kind: "office" },
    band: null,
    leadStage: null,
    total: { count: records.length, value: records.reduce((s, r) => s + (r.value ?? 0), 0), basisLabel: "Best current estimate" },
    records,
    ...over,
  };
}

function lines(csv: string): string[] {
  return csv.split("\n");
}
// Split a CSV line honoring quoted fields (so a quoted "Acme, Inc." stays one cell).
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const DEAL_HEADERS = ["Deal", "Company", "Owner", "Value", "Expected close date", "Win %", "Region", "Type", "Stage", "Age"];

describe("buildEvidenceCsv — columns + values", () => {
  it("emits a header row of exactly the popup's visible columns, in order (deals)", () => {
    const csv = buildEvidenceCsv(evidence("projection", [record({})]));
    expect(cells(lines(csv)[0])).toEqual(DEAL_HEADERS);
  });

  it("drops Value and Win % for the leads metric (leads have neither)", () => {
    const csv = buildEvidenceCsv(evidence("leads", [record({ value: null, winProbability: null })]));
    const header = cells(lines(csv)[0]);
    expect(header).toEqual(["Lead", "Company", "Owner", "Expected close date", "Region", "Type", "Stage", "Age"]);
    expect(header).not.toContain("Value");
    expect(header).not.toContain("Win %");
  });

  it("exports one row per record (the FULL cohort) — header + N rows", () => {
    const recs = [record({ id: "a" }), record({ id: "b" }), record({ id: "c" })];
    const csv = buildEvidenceCsv(evidence("projection", recs));
    expect(lines(csv)).toHaveLength(recs.length + 1);
  });

  it("exports RAW values — Value/Win %/Age as numbers, date as ISO (not the UI's $/%/d formatting)", () => {
    const csv = buildEvidenceCsv(evidence("projection", [record({ value: 12345, winProbability: 65, daysInStage: 4, cohortDate: "2026-06-20" })]));
    const row = cells(lines(csv)[1]);
    const h = cells(lines(csv)[0]);
    expect(row[h.indexOf("Value")]).toBe("12345");
    expect(row[h.indexOf("Win %")]).toBe("65");
    expect(row[h.indexOf("Age")]).toBe("4");
    expect(row[h.indexOf("Expected close date")]).toBe("2026-06-20");
    expect(csv).not.toContain("$");
    expect(csv).not.toContain("65%");
  });

  it("renders null cells as empty (the UI's em dash becomes a blank cell)", () => {
    const csv = buildEvidenceCsv(evidence("projection", [record({ companyName: null, region: null, winProbability: null, daysInStage: null })]));
    const h = cells(lines(csv)[0]);
    const row = cells(lines(csv)[1]);
    expect(row[h.indexOf("Company")]).toBe("");
    expect(row[h.indexOf("Region")]).toBe("");
    expect(row[h.indexOf("Win %")]).toBe("");
    expect(row[h.indexOf("Age")]).toBe("");
  });
});

describe("buildEvidenceCsv — escaping + edge cases", () => {
  it("quotes cells containing commas, quotes, or newlines", () => {
    const csv = buildEvidenceCsv(evidence("projection", [record({ companyName: "Acme, Inc.", name: 'He said "hi"' })]));
    const row = cells(lines(csv)[1]);
    const h = cells(lines(csv)[0]);
    // round-trips through the quote-aware splitter to the original values
    expect(row[h.indexOf("Company")]).toBe("Acme, Inc.");
    expect(row[h.indexOf("Deal")]).toBe('He said "hi"');
    // and the raw CSV actually quoted/doubled them
    expect(csv).toContain('"Acme, Inc."');
    expect(csv).toContain('"He said ""hi"""');
  });

  it("neutralizes spreadsheet-formula injection (leading = + - @)", () => {
    const csv = buildEvidenceCsv(evidence("projection", [record({ name: "=cmd()|' /C calc" })]));
    // a single quote is prefixed so the cell is not evaluated as a formula
    expect(csv).toContain("'=cmd()");
  });

  it("quotes a carriage return in a name so the record does not split (row count stays reconciled)", () => {
    const csv = buildEvidenceCsv(evidence("projection", [record({ name: "Acme\rWest" })]));
    // The CR cell is wrapped in quotes, so CSV parsers keep it as ONE field of ONE record (not two rows).
    expect(csv).toContain('"Acme\rWest"');
    // And there is exactly one record after the header (no \n-introduced split either).
    expect(lines(csv)).toHaveLength(2);
  });

  it("an EMPTY cohort still produces a valid header-only CSV (export never breaks)", () => {
    const csv = buildEvidenceCsv(evidence("projection", []));
    expect(lines(csv)).toHaveLength(1);
    expect(cells(lines(csv)[0])).toEqual(DEAL_HEADERS);
  });

  it("RECONCILES: the Value column sums to the cohort total.value", () => {
    const recs = [record({ id: "a", value: 1000 }), record({ id: "b", value: 2500 }), record({ id: "c", value: 750 })];
    const ev = evidence("projection", recs); // total.value = 4250 by construction
    const csv = buildEvidenceCsv(ev);
    const h = cells(lines(csv)[0]);
    const valueIdx = h.indexOf("Value");
    const sum = lines(csv).slice(1).reduce((acc, line) => acc + Number(cells(line)[valueIdx]), 0);
    expect(sum).toBe(ev.total.value);
  });

  it("RECONCILES even with a NEGATIVE value — the number is not formula-guarded into text", () => {
    // A negative Value (e.g. an adjustment) must stay a parseable number so the column still sums to the
    // total; the formula-injection guard must not turn -5000 into the text "'-5000".
    const recs = [record({ id: "a", value: 8000 }), record({ id: "b", value: -5000 })];
    const ev = evidence("projection", recs); // total.value = 3000
    const csv = buildEvidenceCsv(ev);
    const h = cells(lines(csv)[0]);
    const valueIdx = h.indexOf("Value");
    expect(cells(lines(csv)[2])[valueIdx]).toBe("-5000");
    const sum = lines(csv).slice(1).reduce((acc, line) => acc + Number(cells(line)[valueIdx]), 0);
    expect(sum).toBe(ev.total.value);
  });
});

describe("buildEvidenceCsvFilename", () => {
  const now = new Date("2026-06-19T12:00:00Z");
  const scoped = (scope: EvidenceScope) => evidence("projection", [record({})], { scope });

  it("builds <title>-<scope>-<date>.csv for an office-scoped popup", () => {
    expect(
      buildEvidenceCsvFilename({ metric: "projection", title: "Projected 31–60d" }, scoped({ kind: "office" }), now),
    ).toBe("projected-31-60d-office-2026-06-19.csv");
  });

  it("uses the rep name for a rep-scoped popup", () => {
    expect(
      buildEvidenceCsvFilename(
        { metric: "won", title: "Won this week" },
        scoped({ kind: "rep", repId: "r1", repName: "Jane Doe" }),
        now,
      ),
    ).toBe("won-this-week-jane-doe-2026-06-19.csv");
  });

  it("uses the region name for a region-scoped popup", () => {
    expect(
      buildEvidenceCsvFilename(
        { metric: "pipeline", title: "Pipeline" },
        scoped({ kind: "region", regionName: "North Texas" }),
        now,
      ),
    ).toBe("pipeline-north-texas-2026-06-19.csv");
  });
});
