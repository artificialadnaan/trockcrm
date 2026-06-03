import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const release = vi.fn();

vi.mock("../../../src/db.js", () => ({
  pool: {
    connect: vi.fn(async () => ({ query, release })),
  },
}));

const { ingestBidBoardRows } = await import("../../../src/modules/bid-board-sync/service.js");

// Mock that captures the persisted run-status and makes every deal lookup return no match.
function noMatchMockCapturingStatus() {
  const captured: { status?: string } = {};
  query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const s = sql.toLowerCase();
    if (s === "begin" || s === "commit" || s === "rollback") return { rows: [], rowCount: 0 };
    if (s.includes("app.skip_stage_history_trigger")) return { rows: [] };
    if (s.includes("insert into office_dallas.bid_board_sync_runs")) {
      return { rows: [{ id: "run-1" }], rowCount: 1 };
    }
    if (s.includes("update office_dallas.bid_board_sync_runs")) {
      captured.status = params[5] as string; // $6 = status
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("from public.users")) return { rows: [{ id: "sys" }], rowCount: 1 };
    if (s.includes("from office_dallas.deals")) return { rows: [], rowCount: 0 }; // never matches
    return { rows: [], rowCount: 0 };
  });
  return captured;
}

describe("Bid Board sync observability", () => {
  beforeEach(() => {
    query.mockReset();
    release.mockReset();
  });

  it("warns for EVERY unmatched row, including unstructured project numbers", async () => {
    noMatchMockCapturingStatus();
    const result = await ingestBidBoardRows({
      office_slug: "dallas",
      rows: [{ Name: "Loose Job", Status: "Estimate in Progress", "Project #": "SLG" }],
    });

    expect(result.metrics.noMatch).toBe(1);
    // Previously only STRUCTURED numbers (XXX-#-#####-xx) warned; "SLG" was silent.
    expect(result.warnings.some((w) => w.includes("SLG"))).toBe(true);
  });

  it("marks the run 'completed_with_unmatched' when any row fails to match", async () => {
    const captured = noMatchMockCapturingStatus();
    await ingestBidBoardRows({
      office_slug: "dallas",
      rows: [{ Name: "Duneville", Status: "Estimate sent to client", "Project #": "DFW-4-11826-ai" }],
    });

    expect(captured.status).toBe("completed_with_unmatched");
  });

  it("still reports 'success' when no row is unmatched", async () => {
    const captured = noMatchMockCapturingStatus();
    // A 'Templates' row is skipped (skippedTemplate), so noMatch stays 0 -> clean success.
    await ingestBidBoardRows({
      office_slug: "dallas",
      rows: [{ Name: "Tmpl", Status: "Templates", "Project #": "DFW-9-99999-zz" }],
    });

    expect(captured.status).toBe("success");
  });
});
