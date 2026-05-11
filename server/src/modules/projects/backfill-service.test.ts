import { beforeEach, describe, expect, it, vi } from "vitest";
import { runProjectsBackfill } from "./backfill-service.js";
import { procoreClient } from "../../lib/procore-client.js";

vi.mock("../../lib/procore-client.js", () => ({
  procoreClient: {
    get: vi.fn(),
  },
}));

function createClient(responder: (sql: string, params: unknown[] | undefined) => unknown) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => responder(sql, params));
  return { query };
}

describe("projects backfill service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is idempotent when Procore updated_at already matches the local mirror", async () => {
    vi.mocked(procoreClient.get).mockResolvedValueOnce([
      {
        id: 1001,
        project_number: "DFW-1-00001-aa",
        name: "Already mirrored",
        updated_at: "2026-05-01T12:00:00.000Z",
      },
      {
        id: 1002,
        project_number: "ATL-1-00002-aa",
        name: "Different office",
        project_stage_name: "Warranty",
        updated_at: "2026-05-02T12:00:00.000Z",
      },
      {
        id: 1003,
        project_number: "DFW-1-00003-aa",
        name: "New mirror",
        project_stage_name: "Warranty",
        updated_at: "2026-05-03T12:00:00.000Z",
      },
    ]);

    const client = createClient((sql, params) => {
      if (sql.includes("SELECT id, procore_updated_at")) {
        if (params?.[0] === "1001") {
          return { rows: [{ id: "project-1", procore_updated_at: "2026-05-01T12:00:00.000Z" }] };
        }
        return { rows: [] };
      }
      if (sql.includes("FROM deals")) {
        return params?.[1] === "DFW-1-00003-aa" ? { rows: [{ id: "deal-3" }] } : { rows: [] };
      }
      if (sql.includes("SELECT id, current_phase_id, current_phase_name")) return { rows: [] };
      if (sql.includes("INSERT INTO \"office_dallas\".projects")) return { rows: [{ id: "project-2" }] };
      return { rows: [] };
    });

    const result = await runProjectsBackfill(client as any, "office_dallas", "dallas", "598134325683880");

    expect(result).toMatchObject({ backfilled: 1, skipped: 2, errored: 0 });
    const sqlText = client.query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).toContain('INSERT INTO "office_dallas".projects');
    expect(sqlText.match(/INSERT INTO "office_dallas"\.projects/g)).toHaveLength(1);
  });

  it("mirrors unmatched projects only when their project number belongs to the current office", async () => {
    vi.mocked(procoreClient.get).mockResolvedValueOnce([
      {
        id: 1004,
        project_number: "DFW-1-00004-aa",
        name: "Dallas unmatched",
        project_stage_name: "Warranty",
      },
      {
        id: 1005,
        project_number: "ATL-1-00005-aa",
        name: "Atlanta unmatched",
        project_stage_name: "Warranty",
      },
    ]);

    const client = createClient((sql) => {
      if (sql.includes("SELECT id, procore_updated_at")) return { rows: [] };
      if (sql.includes("FROM deals")) return { rows: [] };
      if (sql.includes("SELECT id, current_phase_id, current_phase_name")) return { rows: [] };
      if (sql.includes("INSERT INTO \"office_dallas\".projects")) return { rows: [{ id: "project-4", inserted: true }] };
      return { rows: [] };
    });

    const result = await runProjectsBackfill(client as any, "office_dallas", "dallas", "598134325683880");

    expect(result).toMatchObject({ backfilled: 1, skipped: 1, errored: 0 });
    expect(client.query.mock.calls.map((call) => String(call[0])).join("\n").match(/INSERT INTO "office_dallas"\.projects/g)).toHaveLength(1);
  });
});
