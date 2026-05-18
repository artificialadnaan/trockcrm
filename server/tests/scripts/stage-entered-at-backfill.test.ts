import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  diagnoseStaleStageEnteredAt,
  parseDiagnoseArgs,
  resolveTenantSchemas as resolveDiagnosticTenantSchemas,
  type DiagnosticDealRow,
  type Queryable,
} from "../../../scripts/diagnose-stale-stage-entered-at.js";
import {
  backfillStaleStageEnteredAt,
  parseBackfillArgs,
  resolveTenantSchemas as resolveBackfillTenantSchemas,
} from "../../../scripts/backfill-stale-stage-entered-at.js";

interface DealState {
  id: string;
  name: string;
  deal_number: string;
  stage_id: string;
  stage_entered_at: string | null;
}

interface HistoryState {
  deal_id: string;
  to_stage_id: string;
  created_at: string | null;
}

class MockStageEnteredAtDb implements Queryable {
  readonly deals: DealState[];
  readonly history: HistoryState[];
  readonly queries: string[] = [];
  readonly transactionEvents: string[] = [];

  constructor(input: { deals: DealState[]; history: HistoryState[] }) {
    this.deals = input.deals.map((deal) => ({ ...deal }));
    this.history = input.history.map((row) => ({ ...row }));
  }

  async query(input: string | { text: string; values?: unknown[] }, params?: unknown[]) {
    const text = typeof input === "string" ? input : input.text;
    const values = (typeof input === "string" ? params : input.values) ?? [];
    this.queries.push(text);

    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
      this.transactionEvents.push(text);
      return { rows: [] };
    }

    if (text.includes("FROM information_schema.schemata")) {
      return { rows: [{ schema_name: "office_atlanta" }, { schema_name: "office_dallas" }] };
    }

    if (text.includes("COUNT(*)::int AS affected_count")) {
      return { rows: [{ affected_count: this.staleRows().length }] };
    }

    if (text.includes("WHERE (d.deal_number = $1 OR LOWER(d.name) = LOWER($2))")) {
      const [dealNumber, name] = values as [string, string];
      const matching = this.staleRows({ useIntervalDayComponent: text.includes("EXTRACT(DAY FROM") }).filter(
        (row) => row.deal_number === dealNumber || row.name.toLowerCase() === name.toLowerCase(),
      );
      return { rows: matching };
    }

    if (text.includes("UPDATE") && text.includes("RETURNING")) {
      const limit = Number(values[0] ?? 500);
      const staleRows = this.staleRows().slice(0, limit);
      for (const row of staleRows) {
        const deal = this.deals.find((candidate) => candidate.id === row.id);
        if (deal) deal.stage_entered_at = row.latest_history_entry;
      }
      return {
        rows: staleRows.map((row) => ({
          id: row.id,
          stage_id: row.stage_id,
          deal_number: row.deal_number,
          name: row.name,
          old_value: row.stored_stage_entered_at,
          new_value: row.latest_history_entry,
        })),
      };
    }

    if (text.includes("FROM stale_deals") && text.includes("LIMIT")) {
      const limit = Number(values[0] ?? 50);
      return { rows: this.staleRows({ useIntervalDayComponent: text.includes("EXTRACT(DAY FROM") }).slice(0, limit) };
    }

    throw new Error(`Unexpected query: ${text}`);
  }

  private staleRows(options: { useIntervalDayComponent?: boolean } = {}): DiagnosticDealRow[] {
    return this.deals
      .map((deal) => {
        const latest = this.history
          .filter((row) => row.deal_id === deal.id && row.to_stage_id === deal.stage_id && row.created_at)
          .map((row) => row.created_at as string)
          .sort()
          .at(-1);
        if (!latest) return null;
        if (deal.stage_entered_at !== null && deal.stage_entered_at >= latest) return null;
        const storedDate = deal.stage_entered_at ? new Date(deal.stage_entered_at) : null;
        const latestDate = new Date(latest);
        const nowDate = new Date("2026-05-18T12:00:00.000Z");
        const msPerDay = 24 * 60 * 60 * 1000;
        const totalDays = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / msPerDay);
        const maybeIntervalDayComponent = (days: number | null) => {
          if (days === null || !options.useIntervalDayComponent) return days;
          return days % 30;
        };
        return {
          id: deal.id,
          name: deal.name,
          deal_number: deal.deal_number,
          stage_id: deal.stage_id,
          stored_stage_entered_at: deal.stage_entered_at,
          latest_history_entry: latest,
          days_diff: maybeIntervalDayComponent(storedDate ? totalDays(storedDate, latestDate) : null),
          stored_days_in_stage: maybeIntervalDayComponent(storedDate ? totalDays(storedDate, nowDate) : null),
          actual_days_in_stage: maybeIntervalDayComponent(totalDays(latestDate, nowDate)),
        };
      })
      .filter((row): row is DiagnosticDealRow => row !== null)
      .sort((a, b) => Number(b.days_diff ?? 999999) - Number(a.days_diff ?? 999999));
  }
}

function makeDb() {
  return new MockStageEnteredAtDb({
    deals: [
      {
        id: "stale-1",
        name: "Avela Real Estate Partners",
        deal_number: "DFW-5-02826-AC",
        stage_id: "stage-estimating",
        stage_entered_at: "2026-01-29T00:00:00.000Z",
      },
      {
        id: "fresh-1",
        name: "Fresh Deal",
        deal_number: "DFW-1-10026-AA",
        stage_id: "stage-estimating",
        stage_entered_at: "2026-05-17T00:00:00.000Z",
      },
      {
        id: "null-1",
        name: "Null Timestamp",
        deal_number: "DFW-1-10126-AA",
        stage_id: "stage-review",
        stage_entered_at: null,
      },
      {
        id: "no-current-history",
        name: "Old No Match",
        deal_number: "DFW-1-10226-AA",
        stage_id: "stage-contract",
        stage_entered_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    history: [
      { deal_id: "stale-1", to_stage_id: "stage-estimating", created_at: "2026-05-18T09:00:00.000Z" },
      { deal_id: "fresh-1", to_stage_id: "stage-estimating", created_at: "2026-05-16T00:00:00.000Z" },
      { deal_id: "null-1", to_stage_id: "stage-review", created_at: "2026-05-10T00:00:00.000Z" },
      { deal_id: "no-current-history", to_stage_id: "stage-review", created_at: "2026-05-11T00:00:00.000Z" },
      { deal_id: "stale-1", to_stage_id: "stage-estimating", created_at: null },
    ],
  });
}

describe("stage_entered_at diagnostic", () => {
  it("identifies stale deals and Avela specifics without writes", async () => {
    const db = makeDb();
    const report = await diagnoseStaleStageEnteredAt(db, { officeName: "office_dallas", sampleSize: 50 });

    expect(report.affectedCount).toBe(2);
    expect(report.sampleRows.map((row) => row.id)).toEqual(["null-1", "stale-1"]);
    expect(report.avelaDeal).toMatchObject({
      id: "stale-1",
      deal_number: "DFW-5-02826-AC",
      stored_stage_entered_at: "2026-01-29T00:00:00.000Z",
      latest_history_entry: "2026-05-18T09:00:00.000Z",
      days_diff: 109,
      stored_days_in_stage: 109,
      actual_days_in_stage: 0,
    });
    expect(report.sampleRows.find((row) => row.id === "stale-1")).toMatchObject({
      days_diff: 109,
      stored_days_in_stage: 109,
      actual_days_in_stage: 0,
    });
    expect(db.queries.some((query) => query.includes("EXTRACT(EPOCH FROM"))).toBe(true);
    expect(db.queries.some((query) => query.includes("EXTRACT(DAY FROM"))).toBe(false);
    expect(db.queries.some((query) => /\bUPDATE\b/i.test(query))).toBe(false);
  });

  it("returns zero stale rows when stored timestamps are fresh", async () => {
    const db = new MockStageEnteredAtDb({
      deals: [
        {
          id: "fresh",
          name: "Fresh",
          deal_number: "DFW-1-00126-AA",
          stage_id: "stage-a",
          stage_entered_at: "2026-05-18T00:00:00.000Z",
        },
      ],
      history: [{ deal_id: "fresh", to_stage_id: "stage-a", created_at: "2026-05-17T00:00:00.000Z" }],
    });

    const report = await diagnoseStaleStageEnteredAt(db, { officeName: "office_dallas" });
    expect(report.affectedCount).toBe(0);
    expect(report.sampleRows).toEqual([]);
  });
});

describe("stage_entered_at backfill", () => {
  it("updates only stale deals and leaves missing current-stage history alone", async () => {
    const db = makeDb();
    const report = await backfillStaleStageEnteredAt(db, {
      officeName: "office_dallas",
      dryRun: false,
      batchSize: 500,
      logPath: null,
    });

    expect(report.updatedCount).toBe(2);
    expect(db.deals.find((deal) => deal.id === "stale-1")?.stage_entered_at).toBe("2026-05-18T09:00:00.000Z");
    expect(db.deals.find((deal) => deal.id === "null-1")?.stage_entered_at).toBe("2026-05-10T00:00:00.000Z");
    expect(db.deals.find((deal) => deal.id === "no-current-history")?.stage_entered_at).toBe("2026-01-01T00:00:00.000Z");
    expect(db.transactionEvents).toEqual(["BEGIN", "COMMIT"]);
  });

  it("processes small batches in separate transactions", async () => {
    const db = makeDb();
    const report = await backfillStaleStageEnteredAt(db, {
      officeName: "office_dallas",
      dryRun: false,
      batchSize: 1,
      logPath: null,
    });

    expect(report.updatedCount).toBe(2);
    expect(report.batches).toBe(2);
    expect(db.transactionEvents).toEqual(["BEGIN", "COMMIT", "BEGIN", "COMMIT", "BEGIN", "COMMIT"]);
  });

  it("is idempotent after the first run", async () => {
    const db = makeDb();
    await backfillStaleStageEnteredAt(db, { officeName: "office_dallas", dryRun: false, batchSize: 500, logPath: null });
    const second = await backfillStaleStageEnteredAt(db, { officeName: "office_dallas", dryRun: false, batchSize: 500, logPath: null });

    expect(second.updatedCount).toBe(0);
  });

  it("respects dry-run mode without modifying rows", async () => {
    const db = makeDb();
    const report = await backfillStaleStageEnteredAt(db, {
      officeName: "office_dallas",
      dryRun: true,
      batchSize: 500,
      logPath: null,
    });

    expect(report.updatedCount).toBe(0);
    expect(report.wouldUpdateCount).toBe(2);
    expect(db.deals.find((deal) => deal.id === "stale-1")?.stage_entered_at).toBe("2026-01-29T00:00:00.000Z");
    expect(db.queries.some((query) => /\bUPDATE\b/i.test(query))).toBe(false);
  });

  it("defaults the exported backfill helper to dry-run when dryRun is omitted", async () => {
    const db = makeDb();
    const report = await backfillStaleStageEnteredAt(db, {
      officeName: "office_dallas",
      batchSize: 500,
      logPath: null,
    });

    expect(report.dryRun).toBe(true);
    expect(report.updatedCount).toBe(0);
    expect(report.wouldUpdateCount).toBe(2);
    expect(db.deals.find((deal) => deal.id === "stale-1")?.stage_entered_at).toBe("2026-01-29T00:00:00.000Z");
    expect(db.queries.some((query) => /\bUPDATE\b/i.test(query))).toBe(false);
  });

  it("writes an audit CSV with tenant, deal, stage, old value, and new value", async () => {
    const db = makeDb();
    const logPath = path.join(os.tmpdir(), "stage-entered-at-backfill-test.csv");
    fs.rmSync(logPath, { force: true });

    await backfillStaleStageEnteredAt(db, {
      officeName: "office_dallas",
      dryRun: false,
      batchSize: 500,
      logPath,
    });

    const log = fs.readFileSync(logPath, "utf8");
    expect(log.split("\n")[0]).toBe("tenant,deal_id,stage_id,deal_number,name,old_value,new_value,executed_at");
    expect(log).toContain('"office_dallas","stale-1","stage-estimating","DFW-5-02826-AC","Avela Real Estate Partners","2026-01-29T00:00:00.000Z","2026-05-18T09:00:00.000Z"');
    expect(log).toContain('"office_dallas","null-1","stage-review","DFW-1-10126-AA","Null Timestamp","","2026-05-10T00:00:00.000Z"');

    fs.rmSync(logPath, { force: true });
  });

  it("uses the platform temp directory for the default audit CSV path", async () => {
    const db = makeDb();
    const report = await backfillStaleStageEnteredAt(db, {
      officeName: "office_dallas",
      dryRun: false,
      batchSize: 500,
    });

    expect(report.logPath).not.toBeNull();
    expect(path.dirname(report.logPath as string)).toBe(os.tmpdir());
    expect(fs.existsSync(report.logPath as string)).toBe(true);

    fs.rmSync(report.logPath as string, { force: true });
  });
});

describe("stage_entered_at CLI helpers", () => {
  it("parses --all, --office, --dry-run, and batch options", () => {
    expect(parseDiagnoseArgs(["--all"])).toMatchObject({ all: true, office: null, sampleSize: 50 });
    expect(parseDiagnoseArgs(["--office=office_dallas", "--sample-size=10"])).toMatchObject({
      all: false,
      office: "office_dallas",
      sampleSize: 10,
    });

    expect(parseBackfillArgs(["--all", "--batch-size=25"])).toMatchObject({
      all: true,
      dryRun: true,
      batchSize: 25,
    });
    expect(parseBackfillArgs(["--all", "--execute"])).toMatchObject({
      all: true,
      dryRun: false,
      batchSize: 500,
    });
    expect(() => parseBackfillArgs(["--all", "--execute", "--dry-run"])).toThrow(
      "Cannot specify both --execute and --dry-run",
    );
    expect(() => parseBackfillArgs(["--office=public"])).toThrow("--office must match office_<name>");
    expect(() => parseBackfillArgs([])).toThrow("Specify either --all or --office=office_<name>");
  });

  it("discovers office schemas with the escaped office underscore query", async () => {
    const db = makeDb();

    await resolveDiagnosticTenantSchemas(db, { all: true, office: null });
    await resolveBackfillTenantSchemas(db, { all: true, office: null });

    const schemaQueries = db.queries.filter((query) => query.includes("information_schema.schemata"));
    expect(schemaQueries).toHaveLength(2);
    expect(schemaQueries.every((query) => query.includes("LIKE 'office\\_%'"))).toBe(true);
    expect(schemaQueries.every((query) => query.includes("ESCAPE '\\'"))).toBe(true);
  });
});
