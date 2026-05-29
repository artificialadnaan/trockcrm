import { describe, expect, it, vi } from "vitest";

import {
  TIDES_PARK_LANE_DEAL_ID,
  TIDES_PARK_LANE_PROJECT_NUMBER,
  UPDATE_PROJECT_NUMBER_SQL,
  buildProjectNumberPlan,
  buildSeedSelection,
  buildSeedTargets,
  parseSeedCrosscheckCsv,
  parseSeedProjectNumbersArgs,
  runSeedProjectNumbers,
  type ExistingProjectNumberRow,
  type LiveDealRow,
  type QueryableClient,
  type SeedTarget,
} from "../../../scripts/seed-project-numbers.js";

const DEAL_1 = "11111111-1111-5111-9111-111111111111";
const DEAL_2 = "22222222-2222-5222-9222-222222222222";
const DEAL_3 = "33333333-3333-5333-9333-333333333333";
const STAGE3_CARSON_DEAL_ID = "9d43ff52-4791-5d8d-bad3-0606f7bd1425";

function csvFixture(): string {
  return [
    [
      "rep",
      "source_record_id",
      "confirmed_project_number",
      "project_number_match_key",
      "deal_name",
      "amount",
      "stage_from_sheet",
      "exclude_flag",
      "classification",
      "matched_by",
      "crm_deal_id",
      "crm_deal_number",
      "crm_stage",
      "crm_current_project_number",
      "collision_with",
      "note_pn_discrepancy",
      "notes",
    ].join(","),
    [
      "Example Rep",
      "HS-1",
      "DFW-1-00001-aa",
      "",
      "Placeholder Safe Deal",
      '"$1,000"',
      "Open",
      "false",
      "SAFE_TO_SEED",
      "deal_id(uuid)",
      DEAL_1,
      "HS-1",
      "Open",
      "",
      "",
      "false",
      "",
    ].join(","),
    [
      "Example Rep",
      "HS-2",
      "DFW-1-00002-aa",
      "",
      "Placeholder Collision Deal",
      '"$2,000"',
      "Open",
      "false",
      "COLLISION",
      "deal_id(uuid)",
      DEAL_2,
      "HS-2",
      "Open",
      "",
      "",
      "false",
      "",
    ].join(","),
    [
      "Example Rep",
      "HS-3",
      "",
      "",
      "Placeholder Discrepancy Deal",
      '"$3,000"',
      "Won",
      "false",
      "NO_PROJECT_NUMBER",
      "deal_id(uuid)",
      TIDES_PARK_LANE_DEAL_ID,
      "HS-3",
      "Won",
      "",
      "",
      "true",
      `"Correct project number: ${TIDES_PARK_LANE_PROJECT_NUMBER}."`,
    ].join(","),
  ].join("\n");
}

function targetFixture(overrides: Partial<SeedTarget> = {}): SeedTarget {
  return {
    dealId: DEAL_1,
    sourceRecordId: "HS-1",
    dealName: "Placeholder Safe Deal",
    crmDealNumber: "HS-1",
    crmStage: "Open",
    rep: "Example Rep",
    proposedProjectNumber: "DFW-1-00001-aa",
    source: "SAFE_TO_SEED",
    ...overrides,
  };
}

function makeClient(input: {
  liveDeals?: LiveDealRow[];
  existingProjectNumbers?: ExistingProjectNumberRow[];
  updateRowCount?: number;
} = {}) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const liveDeals =
    input.liveDeals ??
    ([
      { id: DEAL_1, deal_number: "HS-1", name: "Placeholder Safe Deal", project_number: null },
      {
        id: TIDES_PARK_LANE_DEAL_ID,
        deal_number: "HS-3",
        name: "Placeholder Discrepancy Deal",
        project_number: null,
      },
    ] satisfies LiveDealRow[]);
  const existingProjectNumbers = input.existingProjectNumbers ?? [];

  const query = vi.fn(async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    if (text.includes("FROM office_dallas.deals") && text.includes("id = ANY")) {
      return { rows: liveDeals };
    }
    if (text.includes("FROM office_dallas.deals") && text.includes("lower(btrim(project_number))")) {
      return { rows: existingProjectNumbers };
    }
    if (text === UPDATE_PROJECT_NUMBER_SQL) {
      return { rows: [], rowCount: input.updateRowCount ?? 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  return { client: { query } as QueryableClient, query, calls };
}

const silentLogger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe("seed-project-numbers args", () => {
  it("defaults to dry-run and accepts explicit --commit / --csv", () => {
    expect(parseSeedProjectNumbersArgs([])).toEqual({ commit: false, csvPath: null });
    expect(parseSeedProjectNumbersArgs(["--dry-run"])).toEqual({ commit: false, csvPath: null });
    expect(parseSeedProjectNumbersArgs(["--commit", "--csv=/tmp/source.csv"])).toEqual({
      commit: true,
      csvPath: "/tmp/source.csv",
    });
    expect(() => parseSeedProjectNumbersArgs(["--commit", "--dry-run"])).toThrow(/either --dry-run or --commit/);
    expect(() => parseSeedProjectNumbersArgs(["--bogus"])).toThrow(/Unknown argument/);
  });
});

describe("seed-project-numbers CSV targeting", () => {
  it("selects SAFE_TO_SEED rows plus the confirmed Tides discrepancy only", () => {
    const rows = parseSeedCrosscheckCsv(csvFixture());
    const targets = buildSeedTargets(rows);

    expect(targets).toHaveLength(2);
    expect(targets).toEqual([
      expect.objectContaining({
        dealId: DEAL_1,
        proposedProjectNumber: "DFW-1-00001-aa",
        source: "SAFE_TO_SEED",
      }),
      expect.objectContaining({
        dealId: TIDES_PARK_LANE_DEAL_ID,
        proposedProjectNumber: TIDES_PARK_LANE_PROJECT_NUMBER,
        source: "TIDES_DISCREPANCY",
      }),
    ]);
    expect(targets.find((target) => target.dealId === DEAL_2)).toBeUndefined();
  });

  it("rejects invalid UUID targets instead of fuzzy matching", () => {
    const rows = parseSeedCrosscheckCsv(csvFixture().replace(DEAL_1, "HS-1-NOT-A-UUID"));
    expect(() => buildSeedTargets(rows)).toThrow(/invalid UUID/);
  });

  it("excludes explicit Stage 3 rows even when the CSV classification is SAFE_TO_SEED", () => {
    const contents = `${csvFixture()}\n${[
      "Example Rep",
      "HS-4",
      "2-CPC.1-121225",
      "",
      "Placeholder Stage 3 Deal",
      '"$4,000"',
      "Won",
      "false",
      "SAFE_TO_SEED",
      "deal_id(uuid)",
      STAGE3_CARSON_DEAL_ID,
      "HS-4",
      "Won",
      "",
      "",
      "false",
      "",
    ].join(",")}`;
    const selection = buildSeedSelection(parseSeedCrosscheckCsv(contents));

    expect(selection.targets.find((target) => target.dealId === STAGE3_CARSON_DEAL_ID)).toBeUndefined();
    expect(selection.excluded).toEqual([
      expect.objectContaining({
        dealId: STAGE3_CARSON_DEAL_ID,
        proposedProjectNumber: "2-CPC.1-121225",
        reason: expect.stringContaining("Stage 3 Carson"),
      }),
    ]);
  });
});

describe("seed-project-numbers planning", () => {
  it("plans only NULL current values and excludes non-null/collision/not-found rows", () => {
    const targets = [
      targetFixture({ dealId: DEAL_1, proposedProjectNumber: "DFW-1-00001-aa" }),
      targetFixture({ dealId: DEAL_2, proposedProjectNumber: "DFW-1-00002-aa" }),
      targetFixture({ dealId: DEAL_3, proposedProjectNumber: "DFW-1-00003-aa" }),
      targetFixture({ dealId: TIDES_PARK_LANE_DEAL_ID, proposedProjectNumber: TIDES_PARK_LANE_PROJECT_NUMBER }),
    ];
    const plan = buildProjectNumberPlan({
      mode: "DRY-RUN",
      csvPath: "/tmp/source.csv",
      targets,
      liveDeals: [
        { id: DEAL_1, deal_number: "HS-1", name: "Placeholder One", project_number: null },
        { id: DEAL_2, deal_number: "HS-2", name: "Placeholder Two", project_number: "DFW-EXISTING" },
        { id: TIDES_PARK_LANE_DEAL_ID, deal_number: "HS-4", name: "Placeholder Four", project_number: null },
      ],
      existingProjectNumbers: [
        {
          id: "99999999-9999-5999-9999-999999999999",
          deal_number: "HS-999",
          name: "Placeholder Existing",
          project_number: TIDES_PARK_LANE_PROJECT_NUMBER,
        },
      ],
      snapshotPath: "/tmp/snapshot.json",
    });

    expect(plan.toWrite.map((row) => row.target.dealId)).toEqual([DEAL_1]);
    expect(plan.skipped).toEqual([
      expect.objectContaining({ status: "SKIP_EXISTING_PROJECT_NUMBER", target: expect.objectContaining({ dealId: DEAL_2 }) }),
      expect.objectContaining({ status: "SKIP_NOT_FOUND", target: expect.objectContaining({ dealId: DEAL_3 }) }),
      expect.objectContaining({
        status: "SKIP_PROJECT_NUMBER_COLLISION",
        target: expect.objectContaining({ dealId: TIDES_PARK_LANE_DEAL_ID }),
      }),
    ]);
  });
});

describe("seed-project-numbers orchestrator", () => {
  it("dry-run revalidates live state, writes a snapshot, and performs zero UPDATEs", async () => {
    const { client, calls } = makeClient();
    const writeSnapshot = vi.fn();
    const result = await runSeedProjectNumbers({
      client,
      argv: ["--dry-run", "--csv=/tmp/source.csv"],
      readFile: () => csvFixture(),
      writeSnapshot,
      now: () => new Date("2026-05-28T12:00:00.000Z"),
      tmpDir: "/tmp",
      logger: silentLogger(),
    });

    expect(result.mode).toBe("DRY-RUN");
    expect(result.toWrite).toHaveLength(2);
    expect(writeSnapshot).toHaveBeenCalledWith(
      "/tmp/seed-project-numbers-2026-05-28T12-00-00-000Z.json",
      expect.stringContaining('"toWriteCount": 2')
    );
    expect(calls.some((call) => /^UPDATE/i.test(call.text.trim()))).toBe(false);
    expect(calls.some((call) => call.text === "BEGIN")).toBe(false);
  });

  it("commit mode refuses unless SKIP_PROJECT_NUMBER_EMAIL=true", async () => {
    const { client } = makeClient();
    await expect(
      runSeedProjectNumbers({
        client,
        argv: ["--commit", "--csv=/tmp/source.csv"],
        readFile: () => csvFixture(),
        logger: silentLogger(),
        env: {} as NodeJS.ProcessEnv,
      })
    ).rejects.toThrow(/SKIP_PROJECT_NUMBER_EMAIL=true/);
  });

  it("commit mode sets the transaction-local email suppression GUC before NULL-only updates", async () => {
    const { client, calls } = makeClient();
    const result = await runSeedProjectNumbers({
      client,
      argv: ["--commit", "--csv=/tmp/source.csv"],
      readFile: () => csvFixture(),
      writeSnapshot: vi.fn(),
      now: () => new Date("2026-05-28T12:00:00.000Z"),
      tmpDir: "/tmp",
      logger: silentLogger(),
      env: { SKIP_PROJECT_NUMBER_EMAIL: "true" } as NodeJS.ProcessEnv,
    });

    expect(result.mode).toBe("COMMIT");
    expect(calls.map((call) => call.text)).toContain("BEGIN");
    expect(calls.map((call) => call.text)).toContain("SELECT set_config('app.skip_project_number_email', 'true', true)");
    expect(calls.map((call) => call.text)).toContain("COMMIT");

    const beginIndex = calls.findIndex((call) => call.text === "BEGIN");
    const skipIndex = calls.findIndex((call) => call.text.includes("app.skip_project_number_email"));
    const firstUpdateIndex = calls.findIndex((call) => call.text === UPDATE_PROJECT_NUMBER_SQL);
    expect(beginIndex).toBeLessThan(skipIndex);
    expect(skipIndex).toBeLessThan(firstUpdateIndex);
    expect(UPDATE_PROJECT_NUMBER_SQL).toContain("WHERE id = $1::uuid");
    expect(UPDATE_PROJECT_NUMBER_SQL).toContain("AND project_number IS NULL");
  });
});
