import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const release = vi.fn();

vi.mock("../../../src/db.js", () => ({
  pool: {
    connect: vi.fn(async () => ({ query, release })),
  },
}));

const { ingestBidBoardRows } = await import("../../../src/modules/bid-board-sync/service.js");

function successfulRunBase(sql: string) {
  const normalizedSql = sql.toLowerCase();
  if (normalizedSql === "begin" || normalizedSql === "commit" || normalizedSql === "rollback") {
    return { rows: [], rowCount: 0 };
  }
  if (normalizedSql.includes("insert into office_dallas.bid_board_sync_runs")) {
    return { rows: [{ id: "run-123" }], rowCount: 1 };
  }
  if (normalizedSql.includes("update office_dallas.bid_board_sync_runs")) {
    return { rows: [], rowCount: 1 };
  }
  if (normalizedSql.includes("from public.users")) {
    return { rows: [{ id: "system-user" }], rowCount: 1 };
  }
  return null;
}

function matchedDeal(overrides: Record<string, unknown> = {}) {
  return {
    id: "deal-123",
    stage_id: "stage-opportunity",
    stage_slug: "opportunity",
    stage_display_order: 1,
    stage_is_terminal: false,
    stage_entered_at: "2026-05-01T00:00:00.000Z",
    workflow_route: "normal",
    deal_number: "DFW-4-11826-ab",
    project_number: null,
    bid_board_project_number: null,
    ...overrides,
  };
}

describe("Bid Board sync stage writeback", () => {
  beforeEach(() => {
    query.mockReset();
    release.mockReset();
  });

  it("matches Bid Board Project # against CRM deal_number and advances CRM stage safely", async () => {
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const base = successfulRunBase(sql);
      if (base) return base;

      const normalizedSql = sql.toLowerCase();
      if (normalizedSql.includes("from office_dallas.deals") && normalizedSql.includes("lower(trim(d.project_number))")) {
        expect(params).toEqual(["dfw-4-11826-ab"]);
        return { rows: [matchedDeal()], rowCount: 1 };
      }
      if (normalizedSql.includes("from public.pipeline_stage_config") && normalizedSql.includes("slug = $1")) {
        expect(params).toEqual(["estimate_under_review"]);
        return {
          rows: [
            {
              id: "stage-under-review",
              slug: "estimate_under_review",
              display_order: 4,
              is_terminal: false,
            },
          ],
          rowCount: 1,
        };
      }
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("stage_id = $1")) {
        expect(params.slice(0, 6)).toEqual([
          "stage-under-review",
          "estimate_under_review",
          "estimating",
          "Estimate Under Review",
          "deal-123",
          "stage-opportunity",
        ]);
        return { rows: [{ id: "deal-123" }], rowCount: 1 };
      }
      if (normalizedSql.includes("insert into office_dallas.deal_stage_history")) {
        expect(params).toEqual([
          "deal-123",
          "stage-opportunity",
          "stage-under-review",
          "system-user",
          "Bid Board export sync - Status Estimate Under Review -> Stage estimate_under_review",
          "2026-05-01T00:00:00.000Z",
        ]);
        return { rows: [], rowCount: 1 };
      }
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("bid_board_project_number")) {
        return { rows: [], rowCount: 1 };
      }
      if (normalizedSql.includes("insert into office_dallas.job_queue")) {
        throw new Error("Bid Board sync must not enqueue rep stage-change notifications");
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await ingestBidBoardRows({
      office_slug: "dallas",
      provenance: { extractedAt: "2026-05-12T16:00:00.000Z", sourceFilename: "ProjectList.xlsx" },
      rows: [
        {
          Name: "Palm Villas",
          Status: "Estimate Under Review",
          "Project #": " DFW-4-11826-ab ",
        },
      ],
    });

    expect(result.metrics.matched).toBe(1);
    expect(result.metrics.stageUpdated).toBe(1);
    expect(result.metrics.noMatch).toBe(0);
    expect(query.mock.calls.some(([sql]) => String(sql).toLowerCase().includes("insert into office_dallas.deal_stage_history"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).toLowerCase().includes("insert into office_dallas.job_queue"))).toBe(false);
  });

  it("routes service estimating statuses to the service_estimating stage for service deals", async () => {
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const base = successfulRunBase(sql);
      if (base) return base;

      const normalizedSql = sql.toLowerCase();
      if (normalizedSql.includes("from office_dallas.deals") && normalizedSql.includes("lower(trim(d.project_number))")) {
        return { rows: [matchedDeal({ workflow_route: "service", deal_number: "DFW-4-22222-ab" })], rowCount: 1 };
      }
      if (normalizedSql.includes("from public.pipeline_stage_config") && normalizedSql.includes("slug = $1")) {
        expect(params).toEqual(["service_estimating"]);
        return {
          rows: [
            {
              id: "stage-service-estimating",
              slug: "service_estimating",
              display_order: 3,
              is_terminal: false,
            },
          ],
          rowCount: 1,
        };
      }
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("stage_id = $1")) {
        expect(params.slice(0, 4)).toEqual([
          "stage-service-estimating",
          "service_estimating",
          "estimating",
          "Service - Estimating",
        ]);
        return { rows: [{ id: "deal-123" }], rowCount: 1 };
      }
      if (normalizedSql.includes("insert into office_dallas.deal_stage_history")) {
        return { rows: [], rowCount: 1 };
      }
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("bid_board_project_number")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await ingestBidBoardRows({
      office_slug: "dallas",
      rows: [
        {
          Name: "Service Project",
          Status: "Service - Estimating",
          "Project #": "DFW-4-22222-ab",
        },
      ],
    });

    expect(result.metrics.stageUpdated).toBe(1);
  });

  it("refreshes Bid Board stage metadata on same-stage no-op without writing stage history", async () => {
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const base = successfulRunBase(sql);
      if (base) return base;

      const normalizedSql = sql.toLowerCase();
      if (normalizedSql.includes("from office_dallas.deals") && normalizedSql.includes("lower(trim(d.project_number))")) {
        return {
          rows: [matchedDeal({ stage_id: "stage-estimating", stage_slug: "estimating", stage_display_order: 3 })],
          rowCount: 1,
        };
      }
      if (normalizedSql.includes("from public.pipeline_stage_config") && normalizedSql.includes("slug = $1")) {
        expect(params).toEqual(["estimating"]);
        return {
          rows: [{ id: "stage-estimating", slug: "estimating", display_order: 3, is_terminal: false }],
          rowCount: 1,
        };
      }
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("bid_board_stage_slug = $2")) {
        expect(normalizedSql).not.toContain("stage_id = $1");
        expect(params).toEqual(["deal-123", "estimating", "estimating", "Estimate in Progress", "stage-estimating"]);
        return { rows: [], rowCount: 1 };
      }
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("bid_board_project_number")) {
        return { rows: [], rowCount: 0 };
      }
      if (normalizedSql.includes("insert into office_dallas.deal_stage_history")) {
        throw new Error("same-stage Bid Board sync must not write stage history");
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await ingestBidBoardRows({
      office_slug: "dallas",
      rows: [
        {
          Name: "Same Stage Project",
          Status: "Estimate in Progress",
          "Project #": "DFW-4-11826-ab",
        },
      ],
    });

    expect(result.metrics.stageUpdated).toBe(0);
    expect(result.metrics.skippedNoStageChange).toBe(1);
  });



  it("casts stage metadata parameters in update SQL for production Postgres", async () => {
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const base = successfulRunBase(sql);
      if (base) return base;

      const normalizedSql = sql.toLowerCase();
      if (normalizedSql.includes("from office_dallas.deals") && normalizedSql.includes("lower(trim(d.project_number))")) {
        return { rows: [matchedDeal()], rowCount: 1 };
      }
      if (normalizedSql.includes("from public.pipeline_stage_config") && normalizedSql.includes("slug = $1")) {
        return { rows: [{ id: "stage-won", slug: "won", display_order: 7, is_terminal: true }], rowCount: 1 };
      }
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("stage_id = $1")) {
        expect(normalizedSql).toContain("bid_board_stage_slug = $2::text");
        expect(normalizedSql).toContain("case when $2::text = 'won'");
        expect(normalizedSql).toContain("coalesce(bid_board_loss_outcome, $4::text)");
        expect(params.slice(0, 4)).toEqual(["stage-won", "won", "terminal_won", "Won"]);
        return { rows: [{ id: "deal-123" }], rowCount: 1 };
      }
      if (normalizedSql.includes("insert into office_dallas.deal_stage_history")) return { rows: [], rowCount: 1 };
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("bid_board_project_number")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await ingestBidBoardRows({
      office_slug: "dallas",
      rows: [{ Name: "Won Project", Status: "Won", "Project #": "DFW-4-11826-ab" }],
    });

    expect(result.metrics.stageUpdated).toBe(1);
  });

  it("does not move a later-stage CRM deal backward from the Bid Board export", async () => {
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const base = successfulRunBase(sql);
      if (base) return base;

      const normalizedSql = sql.toLowerCase();
      if (normalizedSql.includes("from office_dallas.deals") && normalizedSql.includes("lower(trim(d.project_number))")) {
        return {
          rows: [
            matchedDeal({
              id: "deal-contract",
              stage_id: "stage-contract",
              stage_slug: "contract",
              stage_display_order: 6,
              deal_number: "DFW-6-12345-ab",
            }),
          ],
          rowCount: 1,
        };
      }
      if (normalizedSql.includes("from public.pipeline_stage_config") && normalizedSql.includes("slug = $1")) {
        expect(params).toEqual(["estimate_under_review"]);
        return {
          rows: [{ id: "stage-under-review", slug: "estimate_under_review", display_order: 4, is_terminal: false }],
          rowCount: 1,
        };
      }
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("bid_board_project_number")) {
        return { rows: [], rowCount: 1 };
      }
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("stage_id = $1")) {
        throw new Error("backward Bid Board sync must not update CRM stage");
      }
      if (normalizedSql.includes("insert into office_dallas.deal_stage_history")) {
        throw new Error("backward Bid Board sync must not write stage history");
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await ingestBidBoardRows({
      office_slug: "dallas",
      rows: [
        {
          Name: "Contract Project",
          Status: "Estimate Under Review",
          "Project #": "DFW-6-12345-ab",
        },
      ],
    });

    expect(result.metrics.matched).toBe(1);
    expect(result.metrics.stageUpdated).toBe(0);
    expect(result.metrics.skippedBackward).toBe(1);
    expect(result.warnings.join("\n")).toContain("backward");
  });

  it("does not downgrade a terminal CRM deal from Bid Board export status", async () => {
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const base = successfulRunBase(sql);
      if (base) return base;

      const normalizedSql = sql.toLowerCase();
      if (normalizedSql.includes("from office_dallas.deals") && normalizedSql.includes("lower(trim(d.project_number))")) {
        return {
          rows: [
            matchedDeal({
              id: "deal-won",
              stage_id: "stage-won",
              stage_slug: "won",
              stage_display_order: 7,
              stage_is_terminal: true,
              deal_number: "DFW-5-99999-ab",
            }),
          ],
          rowCount: 1,
        };
      }
      if (normalizedSql.includes("from public.pipeline_stage_config") && normalizedSql.includes("slug = $1")) {
        expect(params).toEqual(["estimating"]);
        return {
          rows: [
            {
              id: "stage-estimating",
              slug: "estimating",
              display_order: 3,
              is_terminal: false,
            },
          ],
          rowCount: 1,
        };
      }
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("bid_board_project_number")) {
        return { rows: [], rowCount: 1 };
      }
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("stage_id = $1")) {
        throw new Error("terminal deals must not be downgraded by Bid Board sync");
      }
      if (normalizedSql.includes("insert into office_dallas.deal_stage_history")) {
        throw new Error("terminal downgrade skips must not write stage history");
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await ingestBidBoardRows({
      office_slug: "dallas",
      provenance: { extractedAt: "2026-05-12T16:00:00.000Z", sourceFilename: "ProjectList.xlsx" },
      rows: [
        {
          Name: "Already Won Project",
          Status: "Estimate in Progress",
          "Project #": "DFW-5-99999-ab",
        },
      ],
    });

    expect(result.metrics.matched).toBe(1);
    expect(result.metrics.stageUpdated).toBe(0);
    expect(result.metrics.skippedTerminal).toBe(1);
    expect(result.warnings.join("\n")).toContain("terminal");
  });
});
