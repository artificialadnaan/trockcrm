import { describe, expect, it } from "vitest";
import {
  runPortfolioProjectValueRefresh,
  runPortfolioProjectsSeed,
  splitSeedCandidates,
  summarizeSyncHubValueFreshness,
  type SyncHubProcoreProjectRow,
} from "../../../scripts/seed-portfolio-projects-from-synchub.js";
import { normalizePortfolioProjectStage } from "../../../shared/src/types/portfolio-project-stages.js";

function project(overrides: Partial<SyncHubProcoreProjectRow>): SyncHubProcoreProjectRow {
  return {
    procore_id: "project-1",
    project_number: "DFW-1",
    name: "Project One",
    display_name: null,
    stage: null,
    project_stage_name: "Buy Out",
    active: true,
    company_id: "598134325683880",
    company_name: "T-Rock Construction",
    estimated_value: "1000",
    total_value: "1000",
    last_synced_at: "2026-05-25T00:00:00.000Z",
    procore_updated_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-25T00:00:00.000Z",
    properties: {},
    ...overrides,
  };
}

class FakeSyncHubClient {
  constructor(private readonly rows: SyncHubProcoreProjectRow[]) {}

  async query() {
    return { rows: this.rows.filter((row) => row.active === true) };
  }
}

class FakeCrmClient {
  readonly queries: string[] = [];
  readonly rows = new Map<string, any>();
  transactionOpen = false;

  constructor(existing: Array<{
    procoreCompanyId: string;
    procoreProjectId: string;
    stage?: string;
    enteredAt?: string;
    totalValue?: string | null;
    valueSyncedAt?: string | null;
  }> = []) {
    for (const row of existing) {
      this.rows.set(this.key(row.procoreCompanyId, row.procoreProjectId), {
        procore_project_id: row.procoreProjectId,
        project_number: "EXISTING",
        name: "Existing Project",
        current_stage: row.stage ?? "Closed",
        current_stage_entered_at: row.enteredAt ?? "2026-05-20T00:00:00.000Z",
        total_value: row.totalValue ?? null,
        value_synced_at: row.valueSyncedAt ?? null,
      });
    }
  }

  key(companyId: string, projectId: string) {
    return `${companyId}:${projectId}`;
  }

  async query(sql: string, params: unknown[] = []) {
    this.queries.push(sql);

    if (sql === "BEGIN") {
      this.transactionOpen = true;
      return { rows: [] };
    }
    if (sql === "COMMIT") {
      this.transactionOpen = false;
      return { rows: [] };
    }
    if (sql === "ROLLBACK") {
      this.transactionOpen = false;
      return { rows: [] };
    }
    if (sql.includes("FROM public.offices")) {
      return { rows: [{ id: "office-id", slug: "dallas" }] };
    }
    if (sql.includes("FROM information_schema.columns")) {
      return { rows: [{ column_name: "total_value" }, { column_name: "value_synced_at" }] };
    }
    if (sql.includes("FROM \"office_dallas\".portfolio_projects")) {
      const row = this.rows.get(this.key(String(params[0]), String(params[1])));
      return { rows: row ? [row] : [] };
    }
    if (sql.includes("UPDATE \"office_dallas\".portfolio_projects")) {
      const key = this.key(String(params[0]), String(params[1]));
      const row = this.rows.get(key);
      if (!row) return { rows: [] };
      const nextTotalValue = params[2] == null ? null : Number(params[2]).toFixed(2);
      const nextValueSyncedAt = params[3] == null ? null : new Date(String(params[3])).toISOString();
      const currentTotalValue = row.total_value == null ? null : Number(row.total_value).toFixed(2);
      const currentValueSyncedAt = row.value_synced_at == null ? null : new Date(String(row.value_synced_at)).toISOString();
      if (currentTotalValue === nextTotalValue && currentValueSyncedAt === nextValueSyncedAt) {
        return { rows: [] };
      }
      row.total_value = nextTotalValue;
      row.value_synced_at = nextValueSyncedAt;
      return { rows: [{ id: "updated-id" }] };
    }
    if (sql.includes("INSERT INTO \"office_dallas\".portfolio_projects")) {
      const key = this.key(String(params[0]), String(params[1]));
      if (this.rows.has(key)) return { rows: [] };
      this.rows.set(key, {
        procore_company_id: params[0],
        procore_project_id: params[1],
        project_number: params[2],
        name: params[3],
        current_stage: params[4],
        current_stage_normalized: params[5],
        current_stage_entered_at: params[6],
        is_board_relevant: true,
        total_value: params[7],
        value_synced_at: params[8],
        first_seen_at: params[6],
        last_stage_event_key: params[9],
        raw_snapshot: JSON.parse(String(params[10])),
        created_at: params[6],
        updated_at: params[6],
      });
      return { rows: [{ id: "inserted-id" }] };
    }

    throw new Error(`Unhandled SQL: ${sql}`);
  }
}

const mappings = [{ procoreCompanyId: "598134325683880", officeSchema: "office_dallas" }];

describe("seed-portfolio-projects-from-synchub", () => {
  it("selects only active projects in board-relevant stages using the shared stage classifier", () => {
    const { candidates, excluded } = splitSeedCandidates([
      project({ procore_id: "active-board", project_stage_name: "Buy Out" }),
      project({ procore_id: "alias-board", project_stage_name: "Close-Out Final Invoice" }),
      project({ procore_id: "inactive-board", project_stage_name: "Closed", active: false }),
      project({ procore_id: "active-non-board", project_stage_name: "Hold (LEGACY)" }),
    ]);

    expect(candidates.map((candidate) => candidate.procoreProjectId)).toEqual([
      "active-board",
      "alias-board",
    ]);
    expect(candidates[1].currentStageNormalized).toBe(
      normalizePortfolioProjectStage("Close-Out Final Invoice")
    );
    expect(excluded.map((row) => row.reason)).toEqual([
      "inactive",
      "non_board_relevant_stage",
    ]);
  });

  it("summarizes SyncHub value freshness for PR-ready dry-run evidence", () => {
    const summary = summarizeSyncHubValueFreshness(
      [
        project({
          total_value: "1000",
          estimated_value: "900",
          last_synced_at: "2026-05-25T00:00:00.000Z",
        }),
        project({
          total_value: null,
          estimated_value: null,
          last_synced_at: "2026-05-10T00:00:00.000Z",
        }),
        project({
          total_value: "2500",
          estimated_value: "2500",
          last_synced_at: "2026-04-01T00:00:00.000Z",
        }),
        project({
          total_value: "bad",
          estimated_value: "bad",
          last_synced_at: null,
        }),
      ],
      new Date("2026-05-26T00:00:00.000Z"),
    );

    expect(summary).toEqual({
      totalRows: 4,
      withTotalValue: 2,
      withEstimatedValue: 2,
      minLastSyncedAt: "2026-04-01T00:00:00.000Z",
      maxLastSyncedAt: "2026-05-25T00:00:00.000Z",
      within1Day: 1,
      within7Days: 1,
      within30Days: 2,
      olderThan30Days: 1,
      nullLastSyncedAt: 1,
    });
  });

  it("dry-runs inserts without writing and reports existing relay rows as skipped", async () => {
    const crmClient = new FakeCrmClient([
      {
        procoreCompanyId: "598134325683880",
        procoreProjectId: "existing-relay",
        stage: "Closed",
        enteredAt: "2026-05-20T10:00:00.000Z",
      },
    ]);
    const syncHubClient = new FakeSyncHubClient([
      project({ procore_id: "existing-relay", project_stage_name: "Buy Out" }),
      project({ procore_id: "new-project", project_stage_name: "In Production" }),
      project({ procore_id: "legacy-project", project_stage_name: "Hold (LEGACY)" }),
    ]);

    const result = await runPortfolioProjectsSeed({
      mode: "dry-run",
      crmClient: crmClient as any,
      syncHubClient: syncHubClient as any,
      seedTime: new Date("2026-05-25T12:00:00.000Z"),
      mappings,
    });

    expect(result.source.activeRowsRead).toBe(3);
    expect(result.source.boardRelevantCandidates).toBe(2);
    expect(result.source.freshness.boardRelevantRows.totalRows).toBe(2);
    expect(result.crm.existingSkipped).toBe(1);
    expect(result.crm.wouldInsert).toBe(1);
    expect(result.crm.inserted).toBe(0);
    expect(crmClient.rows.has(crmClient.key("598134325683880", "new-project"))).toBe(false);
    expect(result.samples.existingSkipped[0]).toMatchObject({
      procoreProjectId: "existing-relay",
      currentStage: "Closed",
      currentStageEnteredAt: "2026-05-20T10:00:00.000Z",
    });
  });

  it("commits new rows with seed-time current_stage_entered_at and does not overwrite existing timing", async () => {
    const seedTime = new Date("2026-05-25T12:34:56.000Z");
    const crmClient = new FakeCrmClient([
      {
        procoreCompanyId: "598134325683880",
        procoreProjectId: "existing-relay",
        stage: "Close Out",
        enteredAt: "2026-05-20T10:00:00.000Z",
      },
    ]);
    const syncHubClient = new FakeSyncHubClient([
      project({ procore_id: "existing-relay", project_stage_name: "Closed" }),
      project({ procore_id: "new-project", project_stage_name: "In Production" }),
    ]);

    const result = await runPortfolioProjectsSeed({
      mode: "commit",
      crmClient: crmClient as any,
      syncHubClient: syncHubClient as any,
      seedTime,
      mappings,
    });

    const existing = crmClient.rows.get(crmClient.key("598134325683880", "existing-relay"));
    const inserted = crmClient.rows.get(crmClient.key("598134325683880", "new-project"));
    expect(result.crm.inserted).toBe(1);
    expect(existing.current_stage).toBe("Close Out");
    expect(existing.current_stage_entered_at).toBe("2026-05-20T10:00:00.000Z");
    expect(inserted.current_stage).toBe("In Production");
    expect(inserted.current_stage_normalized).toBe("in production");
    expect(inserted.current_stage_entered_at).toBe(seedTime.toISOString());
    expect(inserted.first_seen_at).toBe(seedTime.toISOString());
    expect(inserted.raw_snapshot.source).toBe("synchub_procore_projects_seed");
    expect(crmClient.transactionOpen).toBe(false);
  });

  it("is idempotent when run a second time", async () => {
    const crmClient = new FakeCrmClient();
    const syncHubClient = new FakeSyncHubClient([
      project({ procore_id: "new-project", project_stage_name: "Bidding" }),
    ]);

    const first = await runPortfolioProjectsSeed({
      mode: "commit",
      crmClient: crmClient as any,
      syncHubClient: syncHubClient as any,
      seedTime: new Date("2026-05-25T12:00:00.000Z"),
      mappings,
    });
    const second = await runPortfolioProjectsSeed({
      mode: "commit",
      crmClient: crmClient as any,
      syncHubClient: syncHubClient as any,
      seedTime: new Date("2026-05-26T12:00:00.000Z"),
      mappings,
    });

    const inserted = crmClient.rows.get(crmClient.key("598134325683880", "new-project"));
    expect(first.crm.inserted).toBe(1);
    expect(second.crm.inserted).toBe(0);
    expect(second.crm.existingSkipped).toBe(1);
    expect(inserted.current_stage_entered_at).toBe("2026-05-25T12:00:00.000Z");
  });

  it("stores SyncHub total_value and value_synced_at when seeding new projects", async () => {
    const crmClient = new FakeCrmClient();
    const syncHubClient = new FakeSyncHubClient([
      project({
        procore_id: "new-project",
        total_value: "125000.75",
        last_synced_at: "2026-05-25T09:30:00.000Z",
      }),
    ]);

    await runPortfolioProjectsSeed({
      mode: "commit",
      crmClient: crmClient as any,
      syncHubClient: syncHubClient as any,
      seedTime: new Date("2026-05-25T12:00:00.000Z"),
      mappings,
    });

    const inserted = crmClient.rows.get(crmClient.key("598134325683880", "new-project"));
    expect(inserted.total_value).toBe("125000.75");
    expect(inserted.value_synced_at).toBe("2026-05-25T09:30:00.000Z");
  });

  it("dry-runs project value refresh without writing existing portfolio rows", async () => {
    const crmClient = new FakeCrmClient([
      {
        procoreCompanyId: "598134325683880",
        procoreProjectId: "existing-relay",
        totalValue: "1000.00",
        valueSyncedAt: "2026-05-20T00:00:00.000Z",
      },
    ]);
    const syncHubClient = new FakeSyncHubClient([
      project({
        procore_id: "existing-relay",
        total_value: "1500",
        last_synced_at: "2026-05-25T00:00:00.000Z",
      }),
    ]);

    const result = await runPortfolioProjectValueRefresh({
      mode: "dry-run",
      crmClient: crmClient as any,
      syncHubClient: syncHubClient as any,
      mappings,
    });

    const existing = crmClient.rows.get(crmClient.key("598134325683880", "existing-relay"));
    expect(result.crm.matched).toBe(1);
    expect(result.source.freshness.boardRelevantRows.withTotalValue).toBe(1);
    expect(result.crm.wouldUpdate).toBe(1);
    expect(result.crm.updated).toBe(0);
    expect(existing.total_value).toBe("1000.00");
    expect(result.samples.updates[0]).toMatchObject({
      previousTotalValue: "1000.00",
      nextTotalValue: "1500.00",
      previousValueSyncedAt: "2026-05-20T00:00:00.000Z",
      nextValueSyncedAt: "2026-05-25T00:00:00.000Z",
    });
  });

  it("commits project value refresh idempotently", async () => {
    const crmClient = new FakeCrmClient([
      {
        procoreCompanyId: "598134325683880",
        procoreProjectId: "existing-relay",
        totalValue: null,
        valueSyncedAt: null,
      },
    ]);
    const syncHubClient = new FakeSyncHubClient([
      project({
        procore_id: "existing-relay",
        total_value: "2500",
        last_synced_at: "2026-05-25T00:00:00.000Z",
      }),
    ]);

    const first = await runPortfolioProjectValueRefresh({
      mode: "commit",
      crmClient: crmClient as any,
      syncHubClient: syncHubClient as any,
      mappings,
    });
    const second = await runPortfolioProjectValueRefresh({
      mode: "commit",
      crmClient: crmClient as any,
      syncHubClient: syncHubClient as any,
      mappings,
    });

    const existing = crmClient.rows.get(crmClient.key("598134325683880", "existing-relay"));
    expect(first.crm.updated).toBe(1);
    expect(second.crm.updated).toBe(0);
    expect(second.crm.alreadyCurrent).toBe(1);
    expect(existing.total_value).toBe("2500.00");
    expect(existing.value_synced_at).toBe("2026-05-25T00:00:00.000Z");
  });

  it("skips projects that cannot resolve through the relay company-to-office mapping", async () => {
    const crmClient = new FakeCrmClient();
    const syncHubClient = new FakeSyncHubClient([
      project({ procore_id: "unknown-company", company_id: "unknown", project_stage_name: "Closed" }),
    ]);

    const result = await runPortfolioProjectsSeed({
      mode: "dry-run",
      crmClient: crmClient as any,
      syncHubClient: syncHubClient as any,
      mappings,
    });

    expect(result.crm.missingOfficeSkipped).toBe(1);
    expect(result.crm.wouldInsert).toBe(0);
  });
});
