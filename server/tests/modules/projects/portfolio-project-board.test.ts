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
    first_seen_at: "2026-05-18T12:00:00.000Z",
    updated_at: "2026-05-21T12:00:00.000Z",
  },
];

describe("portfolio project board service", () => {
  it("groups projects into the shared seven board stages in order", () => {
    const board = groupPortfolioProjectsForBoard(boardRows);

    expect(board.stages.map((stage) => stage.stage)).toEqual([
      "bidding",
      "buyout",
      "close out",
      "close out - final invoice",
      "closed",
      "contract executed",
      "in production",
    ]);
    expect(board.projects).toHaveLength(1);
    expect(board.stages.find((stage) => stage.stage === "closed")?.projects).toEqual([
      expect.objectContaining({
        id: "00000000-0000-4000-8000-000000000001",
        name: "Portfolio Roof Replacement",
        projectNumber: "DFW-4-07826-ac",
        currentStageNormalized: "closed",
      }),
    ]);
    expect(board.stages.find((stage) => stage.stage === "bidding")?.projects).toEqual([]);
  });

  it("queries the tenant-scoped portfolio_projects table and filters to board-relevant rows", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [boardRows[0]] }));

    const board = await listPortfolioProjectBoard({ query } as any);

    const sql = String(query.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("FROM portfolio_projects");
    expect(sql).toContain("WHERE is_board_relevant = true");
    expect(sql).toContain("ORDER BY current_stage_entered_at DESC");
    expect(sql).not.toContain("office_dallas.portfolio_projects");
    expect(board.projects).toHaveLength(1);
    expect(board.stages.find((stage) => stage.stage === "closed")?.projects).toHaveLength(1);
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
