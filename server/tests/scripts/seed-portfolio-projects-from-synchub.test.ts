import { describe, expect, it } from "vitest";
import {
  runPortfolioProjectsSeed,
  splitSeedCandidates,
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

  constructor(existing: Array<{ procoreCompanyId: string; procoreProjectId: string; stage?: string; enteredAt?: string }> = []) {
    for (const row of existing) {
      this.rows.set(this.key(row.procoreCompanyId, row.procoreProjectId), {
        procore_project_id: row.procoreProjectId,
        project_number: "EXISTING",
        name: "Existing Project",
        current_stage: row.stage ?? "Closed",
        current_stage_entered_at: row.enteredAt ?? "2026-05-20T00:00:00.000Z",
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
    if (sql.includes("FROM \"office_dallas\".portfolio_projects")) {
      const row = this.rows.get(this.key(String(params[0]), String(params[1])));
      return { rows: row ? [row] : [] };
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
        first_seen_at: params[6],
        last_stage_event_key: params[7],
        raw_snapshot: JSON.parse(String(params[8])),
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
