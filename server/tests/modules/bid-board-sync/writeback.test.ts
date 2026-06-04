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
  if (normalizedSql.includes("insert into") && normalizedSql.includes(".audit_log")) {
    return { rows: [], rowCount: 1 };
  }
  return null;
}

function matchedDeal(overrides: Record<string, unknown> = {}) {
  return {
    id: "deal-123",
    name: "Palm Villas",
    stage_id: "stage-opportunity",
    stage_slug: "opportunity",
    stage_display_order: 1,
    stage_is_terminal: false,
    stage_entered_at: "2026-05-01T00:00:00.000Z",
    on_hold: false,
    on_hold_started_at: null,
    on_hold_accumulated_seconds: 0,
    on_hold_accumulated_seconds_at_stage_entry: 0,
    workflow_route: "normal",
    deal_number: "DFW-4-11826-ab",
    project_number: null,
    bid_board_project_number: null,
    bid_estimate: null,
    won_closed_date: null,
    contract_signed_date: null,
    contract_signed_at: null,
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
      if (normalizedSql.includes("from office_dallas.deals") && normalizedSql.includes("translate(normalize(d.project_number")) {
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
        expect(params[0]).toBe("stage-under-review");
        expect(params[1]).toBeInstanceOf(Date);
        expect(params.slice(2, 11)).toEqual([
          null,
          0,
          0,
          "estimate_under_review",
          "estimating",
          "Estimate Under Review",
          null, // won_closed_date — null for a non-Won target (lockstep)
          "deal-123",
          "stage-opportunity",
        ]);
        return {
          rows: [{
            id: "deal-123",
            name: "Palm Villas",
            deal_number: "DFW-4-11826-ab",
            project_number: null,
            old_stage_id: "stage-opportunity",
            new_stage_id: "stage-under-review",
            old_bid_board_stage_slug: null,
            new_bid_board_stage_slug: "estimate_under_review",
          }],
          rowCount: 1,
        };
      }
      if (normalizedSql.includes("insert into office_dallas.deal_stage_history")) {
        expect(params).toEqual([
          "deal-123",
          "stage-opportunity",
          "stage-under-review",
          "system-user",
          false,
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
      if (String(sql).toLowerCase().includes("app.skip_stage_history_trigger")) {
        return { rows: [] };
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
    const auditCall = query.mock.calls.find(([sql]) => String(sql).toLowerCase().includes(".audit_log"));
    expect(auditCall?.[1]).toEqual(expect.arrayContaining([
      "deals",
      "deal-123",
      "update",
      "Bid Board Sync",
      "Palm Villas",
      "DFW-4-11826-ab",
    ]));
  });

  it("routes service estimating statuses to the service_estimating stage for service deals", async () => {
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const base = successfulRunBase(sql);
      if (base) return base;

      const normalizedSql = sql.toLowerCase();
      if (normalizedSql.includes("from office_dallas.deals") && normalizedSql.includes("translate(normalize(d.project_number")) {
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
        expect(params[0]).toBe("stage-service-estimating");
        expect(params[1]).toBeInstanceOf(Date);
        expect(params.slice(2, 8)).toEqual([
          null,
          0,
          0,
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
      if (String(sql).toLowerCase().includes("app.skip_stage_history_trigger")) {
        return { rows: [] };
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
      if (normalizedSql.includes("from office_dallas.deals") && normalizedSql.includes("translate(normalize(d.project_number")) {
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
        expect(normalizedSql).not.toContain("on_hold_started_at");
        expect(normalizedSql).not.toContain("on_hold_accumulated_seconds");
        expect(normalizedSql).not.toContain("on_hold_accumulated_seconds_at_stage_entry");
        expect(params).toEqual(["deal-123", "estimating", "estimating", "Estimate in Progress", "stage-estimating"]);
        return { rows: [], rowCount: 1 };
      }
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("bid_board_project_number")) {
        return { rows: [], rowCount: 0 };
      }
      if (normalizedSql.includes("insert into office_dallas.deal_stage_history")) {
        throw new Error("same-stage Bid Board sync must not write stage history");
      }
      if (String(sql).toLowerCase().includes("app.skip_stage_history_trigger")) {
        return { rows: [] };
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
      if (normalizedSql.includes("from office_dallas.deals") && normalizedSql.includes("translate(normalize(d.project_number")) {
        return { rows: [matchedDeal()], rowCount: 1 };
      }
      if (normalizedSql.includes("from public.pipeline_stage_config") && normalizedSql.includes("slug = $1")) {
        return { rows: [{ id: "stage-won", slug: "won", display_order: 7, is_terminal: true }], rowCount: 1 };
      }
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("stage_id = $1")) {
        expect(normalizedSql).toContain("bid_board_stage_slug = $6::text");
        expect(normalizedSql).toContain("case when $6::text = 'won'");
        expect(normalizedSql).toContain("coalesce(bid_board_loss_outcome, $8::text)");
        expect(params[0]).toBe("stage-won");
        expect(params[1]).toBeInstanceOf(Date);
        expect(params.slice(2, 8)).toEqual([null, 0, 0, "won", "terminal_won", "Won"]);
        return { rows: [{ id: "deal-123" }], rowCount: 1 };
      }
      if (normalizedSql.includes("insert into office_dallas.deal_stage_history")) return { rows: [], rowCount: 1 };
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("bid_board_project_number")) return { rows: [], rowCount: 1 };
      if (String(sql).toLowerCase().includes("app.skip_stage_history_trigger")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await ingestBidBoardRows({
      office_slug: "dallas",
      rows: [{ Name: "Won Project", Status: "Won", "Project #": "DFW-4-11826-ab" }],
    });

    expect(result.metrics.stageUpdated).toBe(1);
  });

  it("applies a backward Bid Board stage move (board is source of truth) and resets the stage clock", async () => {
    let stageEnteredAtParam: Date | undefined;
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const base = successfulRunBase(sql);
      if (base) return base;

      const normalizedSql = sql.toLowerCase();
      if (normalizedSql.includes("from office_dallas.deals") && normalizedSql.includes("translate(normalize(d.project_number")) {
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
      // Bid Board is authoritative: the backward move IS applied, writing the earlier stage_id
      // with a FRESH stage_entered_at (the SLA clock resets on re-entry, exactly like a forward move).
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("stage_id = $1")) {
        expect(params[0]).toBe("stage-under-review");
        expect(params[1]).toBeInstanceOf(Date);
        stageEnteredAtParam = params[1] as Date;
        expect(params.slice(2, 11)).toEqual([
          null,
          0,
          0,
          "estimate_under_review",
          "estimating",
          "Estimate Under Review",
          null, // won_closed_date — null for a non-Won target (lockstep)
          "deal-contract",
          "stage-contract",
        ]);
        return { rows: [{ id: "deal-contract" }], rowCount: 1 };
      }
      // The stage-history row records the move as backward (is_backward_move = true).
      if (normalizedSql.includes("insert into office_dallas.deal_stage_history")) {
        expect(params).toEqual([
          "deal-contract",
          "stage-contract",
          "stage-under-review",
          "system-user",
          true,
          "Bid Board export sync (backward) - Status Estimate Under Review -> Stage estimate_under_review",
          "2026-05-01T00:00:00.000Z",
        ]);
        return { rows: [], rowCount: 1 };
      }
      if (String(sql).toLowerCase().includes("app.skip_stage_history_trigger")) {
        return { rows: [] };
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
    expect(result.metrics.stageUpdated).toBe(1);
    expect(result.metrics.appliedBackward).toBe(1);
    // The stage clock RESET to ~now, not the deal's original 2026-05-01 entry — SLA age recomputes from re-entry.
    expect(stageEnteredAtParam).toBeInstanceOf(Date);
    expect(Date.now() - stageEnteredAtParam!.getTime()).toBeLessThan(10_000);
    expect(stageEnteredAtParam!.getTime()).toBeGreaterThan(new Date("2026-05-01T00:00:00.000Z").getTime());
  });

  it("mirrors a terminal CRM deal back to the Bid Board stage (terminal exit) and clears won_closed_date", async () => {
    let stageHistoryParams: unknown[] | null = null;
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const base = successfulRunBase(sql);
      if (base) return base;

      const normalizedSql = sql.toLowerCase();
      if (normalizedSql.includes("from office_dallas.deals") && normalizedSql.includes("translate(normalize(d.project_number")) {
        return {
          rows: [
            matchedDeal({
              id: "deal-won",
              stage_id: "stage-won",
              stage_slug: "won",
              stage_display_order: 7,
              stage_is_terminal: true,
              won_closed_date: "2026-05-01", // was Won; mirror must CLEAR it on exit
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
      // Bid Board is authoritative: the terminal Won deal IS mirrored back to its Bid Board stage,
      // and won_closed_date is CLEARED in lockstep (the $9::date param is null for a non-Won target).
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("stage_id = $1")) {
        expect(params[0]).toBe("stage-estimating");
        expect(normalizedSql).toContain("won_closed_date = $9::date");
        expect(params[8]).toBeNull();
        return { rows: [{ id: "deal-won" }], rowCount: 1 };
      }
      if (normalizedSql.includes("insert into office_dallas.deal_stage_history")) {
        stageHistoryParams = params;
        return { rows: [], rowCount: 1 };
      }
      if (String(sql).toLowerCase().includes("app.skip_stage_history_trigger")) {
        return { rows: [] };
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
    expect(result.metrics.stageUpdated).toBe(1);
    expect(result.metrics.appliedTerminalExit).toBe(1);
    expect(result.metrics.skippedTerminal).toBe(0);
    // won (order 7) -> estimating (order 3) is recorded as a backward move.
    expect(stageHistoryParams?.[4]).toBe(true);
  });

  it("does not rewrite bid estimates for terminal CRM deals", async () => {
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const normalizedSql = sql.toLowerCase();
      const base = successfulRunBase(sql);
      if (base) {
        if (normalizedSql.includes("update office_dallas.bid_board_sync_runs")) {
          expect(params[23]).toBe(1);
        }
        return base;
      }

      if (normalizedSql.includes("from office_dallas.deals") && normalizedSql.includes("translate(normalize(d.project_number")) {
        return {
          rows: [
            matchedDeal({
              id: "deal-terminal-estimate",
              stage_id: "stage-won",
              stage_slug: "won",
              stage_display_order: 7,
              stage_is_terminal: true,
              bid_estimate: "425000.00",
              deal_number: "DFW-5-99998-aa",
            }),
          ],
          rowCount: 1,
        };
      }
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("bid_board_project_number")) {
        return { rows: [], rowCount: 1 };
      }
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("bid_estimate = $2::numeric")) {
        throw new Error("terminal deals must not receive Bid Board estimate writes");
      }
      if (normalizedSql.includes("insert into office_dallas.deal_history")) {
        throw new Error("terminal estimate skips must not write deal history");
      }
      // The terminal Won deal is now MIRRORED to its Bid Board stage (terminal exit): the STAGE path
      // writes the stage + deal_stage_history. The ESTIMATE path still skips terminal (the
      // bid_estimate write above stays guarded and is never reached).
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("stage_id = $1")) {
        return { rows: [{ id: "deal-terminal-estimate" }], rowCount: 1 };
      }
      if (normalizedSql.includes("insert into office_dallas.deal_stage_history")) {
        return { rows: [], rowCount: 1 };
      }
      if (normalizedSql.includes("from public.pipeline_stage_config")) {
        return { rows: [{ id: "stage-estimating", slug: "estimating", display_order: 3, is_terminal: false }], rowCount: 1 };
      }
      if (String(sql).toLowerCase().includes("app.skip_stage_history_trigger")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await ingestBidBoardRows({
      office_slug: "dallas",
      rows: [
        {
          Name: "Already Won Estimate Project",
          Status: "Estimate in Progress",
          "Project #": "DFW-5-99998-aa",
          "Total Sales": "850000",
        },
      ],
    });

    expect(result.metrics.estimateUpdated).toBe(0);
    expect(result.metrics.estimateSkippedTerminal).toBe(1);
    expect(result.metrics.estimateSkippedNoChange).toBe(0);
    expect(result.warnings.join("\n")).toContain("terminal Bid Board estimate update");
  });

  it("writes non-zero Bid Board Total Sales to bid_estimate even when it revises the CRM value downward", async () => {
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const base = successfulRunBase(sql);
      if (base) return base;

      const normalizedSql = sql.toLowerCase();
      if (normalizedSql.includes("from office_dallas.deals") && normalizedSql.includes("translate(normalize(d.project_number")) {
        return {
          rows: [
            matchedDeal({
              id: "deal-down-revision",
              stage_id: "stage-estimating",
              stage_slug: "estimating",
              stage_display_order: 3,
              bid_estimate: "1200000.00",
              deal_number: "DFW-9-55555-aa",
            }),
          ],
          rowCount: 1,
        };
      }
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("bid_board_project_number")) {
        return { rows: [], rowCount: 1 };
      }
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("bid_estimate = $2::numeric")) {
        expect(params).toEqual(["deal-down-revision", "850000.00"]);
        return { rows: [{ old_bid_estimate: "1200000.00", new_bid_estimate: "850000.00" }], rowCount: 1 };
      }
      if (normalizedSql.includes("insert into office_dallas.deal_history")) {
        expect(params).toEqual([
          "deal-down-revision",
          "bid_estimate",
          "1200000.00",
          "850000.00",
          "system-user",
          "bid_board_sync",
          "Bid Board export sync - Total Sales -> Bid Estimate",
        ]);
        return { rows: [], rowCount: 1 };
      }
      if (normalizedSql.includes("from public.pipeline_stage_config")) {
        return { rows: [{ id: "stage-estimating", slug: "estimating", display_order: 3, is_terminal: false }], rowCount: 1 };
      }
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("bid_board_stage_slug = $2")) {
        return { rows: [], rowCount: 1 };
      }
      if (normalizedSql.includes("insert into office_dallas.job_queue")) {
        throw new Error("Bid Board estimate sync must not enqueue rep notifications");
      }
      if (String(sql).toLowerCase().includes("app.skip_stage_history_trigger")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await ingestBidBoardRows({
      office_slug: "dallas",
      rows: [
        {
          Name: "Down Revision Project",
          Status: "Estimate in Progress",
          "Project #": "DFW-9-55555-aa",
          "Total Sales": "$850,000.00",
        },
      ],
    });

    expect(result.metrics.estimateUpdated).toBe(1);
    expect(result.metrics.estimateUpdatedLower).toBe(1);
    expect(result.metrics.estimateSkippedNoValue).toBe(0);
    expect(result.metrics.estimateSkippedNoChange).toBe(0);
    expect(query.mock.calls.some(([sql]) => String(sql).toLowerCase().includes("insert into office_dallas.deal_history"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).toLowerCase().includes("insert into office_dallas.job_queue"))).toBe(false);
  });

  it("skips zero Bid Board Total Sales and same-value estimates without audit churn", async () => {
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const base = successfulRunBase(sql);
      if (base) return base;

      const normalizedSql = sql.toLowerCase();
      if (normalizedSql.includes("from office_dallas.deals") && normalizedSql.includes("translate(normalize(d.project_number")) {
        const projectNumber = params[0];
        if (projectNumber === "dfw-9-00000-aa") {
          return {
            rows: [
              matchedDeal({
                id: "deal-zero",
                stage_id: "stage-estimating",
                stage_slug: "estimating",
                stage_display_order: 3,
                bid_estimate: "500000.00",
                deal_number: "DFW-9-00000-aa",
              }),
            ],
            rowCount: 1,
          };
        }
        return {
          rows: [
            matchedDeal({
              id: "deal-same",
              stage_id: "stage-estimating",
              stage_slug: "estimating",
              stage_display_order: 3,
              bid_estimate: "250000.00",
              deal_number: "DFW-9-00001-aa",
            }),
          ],
          rowCount: 1,
        };
      }
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("bid_board_project_number")) {
        return { rows: [], rowCount: 1 };
      }
      if (normalizedSql.includes("from public.pipeline_stage_config")) {
        return { rows: [{ id: "stage-estimating", slug: "estimating", display_order: 3, is_terminal: false }], rowCount: 1 };
      }
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("bid_board_stage_slug = $2")) {
        return { rows: [], rowCount: 1 };
      }
      if (normalizedSql.includes("update office_dallas.deals") && normalizedSql.includes("bid_estimate = $2::numeric")) {
        expect(params).toEqual(["deal-same", "250000.00"]);
        return { rows: [{ current_bid_estimate: "250000.00", old_bid_estimate: null, new_bid_estimate: null }], rowCount: 1 };
      }
      if (normalizedSql.includes("insert into office_dallas.deal_history")) {
        throw new Error("zero and same-value estimate rows must not write deal history");
      }
      if (String(sql).toLowerCase().includes("app.skip_stage_history_trigger")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await ingestBidBoardRows({
      office_slug: "dallas",
      rows: [
        {
          Name: "Zero Estimate Project",
          Status: "Estimate in Progress",
          "Project #": "DFW-9-00000-aa",
          "Total Sales": "0",
        },
        {
          Name: "Same Estimate Project",
          Status: "Estimate in Progress",
          "Project #": "DFW-9-00001-aa",
          "Total Sales": "250000.00",
        },
      ],
    });

    expect(result.metrics.estimateUpdated).toBe(0);
    expect(result.metrics.estimateSkippedNoValue).toBe(1);
    expect(result.metrics.estimateSkippedNoChange).toBe(1);
  });
});
