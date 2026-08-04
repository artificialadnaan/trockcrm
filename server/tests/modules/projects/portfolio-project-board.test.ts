import { describe, expect, it, vi } from "vitest";
import {
  getPortfolioProjectDetail,
  groupPortfolioProjectsForBoard,
  listPortfolioProjectBoard,
} from "../../../src/modules/projects/service.js";

const boardRows = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    procore_project_id: "598134326469086",
    procore_company_id: "598134325683880",
    project_number: "DFW-4-07826-ac",
    name: "Portfolio Roof Replacement",
    current_stage: "closed",
    current_stage_normalized: "closed",
    current_stage_entered_at: "2026-05-20T12:00:00.000Z",
    total_value: "9716.67",
    value_synced_at: "2026-05-25T09:34:15.318Z",
    first_seen_at: "2026-05-18T12:00:00.000Z",
    updated_at: "2026-05-21T12:00:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    procore_project_id: "598134326469087",
    procore_company_id: "598134325683880",
    project_number: "DFW-4-07826-ad",
    name: "Legacy Hold Project",
    current_stage: "hold (legacy)",
    current_stage_normalized: "hold (legacy)",
    current_stage_entered_at: "2026-05-20T12:00:00.000Z",
    total_value: null,
    value_synced_at: null,
    first_seen_at: "2026-05-18T12:00:00.000Z",
    updated_at: "2026-05-21T12:00:00.000Z",
  },
];

describe("portfolio project board service", () => {
  it("groups projects into the shared board stages in construction-then-service order", () => {
    const board = groupPortfolioProjectsForBoard(boardRows);

    // Construction lifecycle first, then the service track, then the catch-all column (present
    // here only because the "hold (legacy)" fixture row has no column of its own).
    expect(board.stages.map((stage) => stage.stage)).toEqual([
      "bidding",
      "estimating",
      "pre-construction",
      "buyout",
      "contract executed",
      "in production",
      "close out",
      "close out - final invoice",
      "closed",
      "service - estimating",
      "service - in production",
      "service - close out",
      "service - close out final invoice",
      "service - lost",
      "unmapped",
    ]);
    // BOTH rows survive now. The legacy-stage row used to be dropped from this array entirely.
    expect(board.projects).toHaveLength(2);
    expect(board.stages.find((stage) => stage.stage === "unmapped")?.projects).toEqual([
      expect.objectContaining({
        id: "00000000-0000-4000-8000-000000000002",
        currentStageNormalized: "hold (legacy)",
      }),
    ]);
    expect(board.stages.find((stage) => stage.stage === "closed")?.projects).toEqual([
      expect.objectContaining({
        id: "00000000-0000-4000-8000-000000000001",
        name: "Portfolio Roof Replacement",
        projectNumber: "DFW-4-07826-ac",
        currentStageNormalized: "closed",
        totalValue: 9716.67,
        valueSyncedAt: "2026-05-25T09:34:15.318Z",
      }),
    ]);
    expect(board.stages.find((stage) => stage.stage === "bidding")?.projects).toEqual([]);
  });

  it("queries the tenant-scoped portfolio_projects table and filters to board-relevant rows", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [boardRows[0]] }));

    const board = await listPortfolioProjectBoard({ query } as any);

    const sql = String(query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("FROM portfolio_projects");
    expect(sql).toContain("total_value");
    expect(sql).toContain("value_synced_at");
    expect(sql).toContain("WHERE is_board_relevant = true");
    expect(sql).toContain("ORDER BY current_stage_entered_at DESC");
    expect(sql).not.toContain("office_dallas.portfolio_projects");
    expect(board.projects).toHaveLength(1);
    expect(board.stages.find((stage) => stage.stage === "closed")?.projects).toHaveLength(1);
  });

  it("derives a stage entry's board-relevance from its stage, not the cached column", async () => {
    // The stored is_board_relevant is whatever the classifier said the day the event was relayed, and
    // the detail page renders it as "Board stage" / "Legacy stage". After this release a backfilled
    // Pre-Construction / Service project was reachable but every history row still read "Legacy stage".
    const staleRows = [
      // Newly-mapped stages, stamped false by the OLD classifier -> must now read as board stages.
      { id: "e1", stage: "Pre-Construction", stage_normalized: "pre - construction", is_board_relevant: false, expected: true },
      { id: "e2", stage: "Service - In Production", stage_normalized: "service - in production", is_board_relevant: false, expected: true },
      // Genuinely dead work stays "Legacy stage" whatever the column says.
      { id: "e3", stage: "Hold (LEGACY)", stage_normalized: "hold (legacy)", is_board_relevant: true, expected: false },
      // A stage nobody anticipated is not a decision to exclude.
      { id: "e4", stage: "Warranty - Punch List", stage_normalized: "warranty - punch list", is_board_relevant: false, expected: true },
    ];

    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM portfolio_projects")) {
        return { rows: [{ ...boardRows[0], is_board_relevant: true, last_stage_event_key: null, raw_snapshot: {}, created_at: "2026-05-18T12:00:00.000Z" }] };
      }
      if (sql.includes("FROM portfolio_project_stage_entries")) {
        return {
          rows: staleRows.map((row) => ({
            id: row.id,
            event_key: `key-${row.id}`,
            previous_stage: null,
            previous_stage_normalized: null,
            stage: row.stage,
            stage_normalized: row.stage_normalized,
            is_board_relevant: row.is_board_relevant,
            entered_at: "2026-05-20T12:00:00.000Z",
            relay_detected_at: null,
            webhook_timestamp: null,
            created_at: "2026-05-20T12:01:05.000Z",
          })),
        };
      }
      return { rows: [] };
    });

    const detail = await getPortfolioProjectDetail({ query } as any, "00000000-0000-4000-8000-000000000001");

    expect(detail!.stageHistory.map((entry) => ({ id: entry.id, isBoardRelevant: entry.isBoardRelevant })))
      .toEqual(staleRows.map((row) => ({ id: row.id, isBoardRelevant: row.expected })));
  });

  it("returns portfolio project detail with stage history using sequential tenant queries", async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("FROM portfolio_projects")) {
        return {
          rows: [
            {
              ...boardRows[0],
              is_board_relevant: true,
              last_stage_event_key: "receipt-closed",
              raw_snapshot: { id: 598134326469086 },
              created_at: "2026-05-18T12:00:00.000Z",
            },
          ],
        };
      }
      if (sql.includes("FROM portfolio_project_stage_entries")) {
        return {
          rows: [
            {
              id: "00000000-0000-4000-8000-000000000101",
              event_key: "receipt-closed",
              previous_stage: "close out",
              previous_stage_normalized: "close out",
              stage: "closed",
              stage_normalized: "closed",
              is_board_relevant: true,
              entered_at: "2026-05-20T12:00:00.000Z",
              relay_detected_at: "2026-05-20T12:01:00.000Z",
              webhook_timestamp: "2026-05-20T12:00:30.000Z",
              created_at: "2026-05-20T12:01:05.000Z",
            },
          ],
        };
      }
      return { rows: [] };
    });

    const detail = await getPortfolioProjectDetail(
      { query } as any,
      "00000000-0000-4000-8000-000000000001",
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toEqual(["00000000-0000-4000-8000-000000000001"]);
    expect(query.mock.calls[1][1]).toEqual(["00000000-0000-4000-8000-000000000001"]);
    expect(String(query.mock.calls[0][0])).toContain("AND is_board_relevant = true");
    expect(detail).toEqual(
      expect.objectContaining({
        id: "00000000-0000-4000-8000-000000000001",
        lastStageEventKey: "receipt-closed",
        rawSnapshot: { id: 598134326469086 },
        totalValue: 9716.67,
        valueSyncedAt: "2026-05-25T09:34:15.318Z",
        stageHistory: [
          expect.objectContaining({
            stage: "closed",
            previousStage: "close out",
            isBoardRelevant: true,
          }),
        ],
      }),
    );
  });

  it("returns null for missing or non-board-relevant detail rows", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));

    const detail = await getPortfolioProjectDetail(
      { query } as any,
      "00000000-0000-4000-8000-000000000003",
    );

    expect(detail).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
