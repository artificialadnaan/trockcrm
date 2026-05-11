import { beforeEach, describe, expect, it, vi } from "vitest";
import { runProjectsBackfill } from "./backfill-service.js";
import { procoreClient } from "../../lib/procore-client.js";

vi.mock("../../lib/procore-client.js", () => ({
  procoreClient: {
    get: vi.fn(),
  },
}));

type Responder = (sql: string, params: unknown[] | undefined) => unknown;

function createPool(responder: Responder) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => responder(sql, params));
  const release = vi.fn();
  const client = { query, release };
  const connect = vi.fn(async () => client);
  return { pool: { connect } as any, client, query, release };
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

    const { pool, query } = createPool((sql, params) => {
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

    const result = await runProjectsBackfill(pool, "office_dallas", "dallas", { companyId: "598134325683880" });

    expect(result).toMatchObject({ backfilled: 1, skipped: 2, errored: 0 });
    const sqlText = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).toContain('INSERT INTO "office_dallas".projects');
    expect(sqlText.match(/INSERT INTO "office_dallas"\.projects/g)).toHaveLength(1);
    expect(sqlText).toMatch(/SET search_path TO "office_dallas"/);
  });

  it("isolates a failing row in its own transaction so later rows still backfill", async () => {
    vi.mocked(procoreClient.get).mockResolvedValueOnce([
      {
        id: 2001,
        project_number: "DFW-1-02001-aa",
        name: "Bad row",
        project_stage_name: "Warranty",
      },
      {
        id: 2002,
        project_number: "DFW-1-02002-aa",
        name: "Good row",
        project_stage_name: "Warranty",
      },
    ]);

    let txnAborted = false;
    let inTxn = false;

    const responder: Responder = (sql, params) => {
      const trimmed = sql.trim().toUpperCase();

      if (trimmed === "BEGIN") {
        inTxn = true;
        txnAborted = false;
        return { rows: [] };
      }
      if (trimmed === "COMMIT" || trimmed === "ROLLBACK") {
        inTxn = false;
        txnAborted = false;
        return { rows: [] };
      }

      // After a failure inside an active txn, Postgres rejects every
      // subsequent statement until ROLLBACK clears the aborted state.
      if (inTxn && txnAborted) {
        throw Object.assign(
          new Error("current transaction is aborted, commands ignored until end of transaction block"),
          { code: "25P02" }
        );
      }

      if (sql.includes("SELECT id, procore_updated_at")) return { rows: [] };
      if (sql.includes("FROM deals")) return { rows: [] };
      if (sql.includes("SELECT id, current_phase_id, current_phase_name")) return { rows: [] };
      if (sql.includes("INSERT INTO \"office_dallas\".projects")) {
        if (params?.[1] === "2001") {
          txnAborted = true;
          throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
        }
        return { rows: [{ id: "project-2002", inserted: true }] };
      }
      return { rows: [] };
    };

    const { pool, query } = createPool(responder);
    const result = await runProjectsBackfill(pool, "office_dallas", "dallas", { companyId: "598134325683880" });

    expect(result).toMatchObject({ backfilled: 1, errored: 1, skipped: 0 });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].procoreProjectId).toBe("2001");

    const sqls = query.mock.calls.map((call) => String(call[0]));
    expect(sqls.filter((s) => s.trim().toUpperCase() === "BEGIN")).toHaveLength(2);
    expect(sqls.filter((s) => s.trim().toUpperCase() === "ROLLBACK")).toHaveLength(1);
    expect(sqls.filter((s) => s.trim().toUpperCase() === "COMMIT")).toHaveLength(1);
    expect(sqls.filter((s) => s.includes("INSERT INTO \"office_dallas\".projects"))).toHaveLength(2);
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

    const { pool, query } = createPool((sql) => {
      if (sql.includes("SELECT id, procore_updated_at")) return { rows: [] };
      if (sql.includes("FROM deals")) return { rows: [] };
      if (sql.includes("SELECT id, current_phase_id, current_phase_name")) return { rows: [] };
      if (sql.includes("INSERT INTO \"office_dallas\".projects")) return { rows: [{ id: "project-4", inserted: true }] };
      return { rows: [] };
    });

    const result = await runProjectsBackfill(pool, "office_dallas", "dallas", { companyId: "598134325683880" });

    expect(result).toMatchObject({ backfilled: 1, skipped: 1, errored: 0 });
    expect(query.mock.calls.map((call) => String(call[0])).join("\n").match(/INSERT INTO "office_dallas"\.projects/g)).toHaveLength(1);
  });

  it("releases the pool client and resets search_path even when Procore throws mid-pagination", async () => {
    vi.mocked(procoreClient.get).mockRejectedValueOnce(new Error("procore boom"));

    const { pool, query, release } = createPool(() => ({ rows: [] }));

    await expect(
      runProjectsBackfill(pool, "office_dallas", "dallas", { companyId: "598134325683880" })
    ).rejects.toThrow(/procore boom/);
    expect(release).toHaveBeenCalledTimes(1);
    const sqls = query.mock.calls.map((call) => String(call[0]));
    const resetIdx = sqls.findIndex((s) => /RESET search_path/.test(s));
    expect(resetIdx).toBeGreaterThanOrEqual(0);
    expect(release.mock.invocationCallOrder[0]).toBeGreaterThan(
      query.mock.invocationCallOrder[resetIdx]
    );
  });

  it("mirrors every project when mirrorAllProjects=true, even without office prefix or matching deal", async () => {
    vi.mocked(procoreClient.get).mockResolvedValueOnce([
      { id: 3001, project_number: "12345", name: "No-prefix one" },
      { id: 3002, project_number: "678910", name: "No-prefix two" },
    ]);

    const { pool, query } = createPool((sql) => {
      if (sql.includes("SELECT id, procore_updated_at")) return { rows: [] };
      if (sql.includes("FROM deals")) return { rows: [] };
      if (sql.includes("SELECT id, current_phase_id, current_phase_name")) return { rows: [] };
      if (sql.includes("INSERT INTO \"office_dallas\".projects")) {
        return { rows: [{ id: "uuid", inserted: true }] };
      }
      return { rows: [] };
    });

    const result = await runProjectsBackfill(pool, "office_dallas", "dallas", {
      companyId: "598134325683880",
      mirrorAllProjects: true,
    });

    expect(result).toMatchObject({ backfilled: 2, skipped: 0, errored: 0 });
    const inserts = query.mock.calls
      .map((call) => String(call[0]))
      .filter((s) => s.includes("INSERT INTO \"office_dallas\".projects"));
    expect(inserts).toHaveLength(2);
  });

  it("breaks pagination when a page returns only projects already seen this run", async () => {
    const page1 = [
      { id: 4001, project_number: "DFW-1-04001-aa", project_stage_name: "Warranty" },
      { id: 4002, project_number: "DFW-1-04002-aa", project_stage_name: "Warranty" },
    ];
    // Page 2 is identical — Procore cycling. We must NOT loop forever.
    vi.mocked(procoreClient.get)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page1);

    const { pool, query } = createPool((sql) => {
      if (sql.includes("SELECT id, procore_updated_at")) return { rows: [] };
      if (sql.includes("FROM deals")) return { rows: [] };
      if (sql.includes("SELECT id, current_phase_id, current_phase_name")) return { rows: [] };
      if (sql.includes("INSERT INTO \"office_dallas\".projects")) {
        return { rows: [{ id: "uuid", inserted: true }] };
      }
      return { rows: [] };
    });

    const result = await runProjectsBackfill(pool, "office_dallas", "dallas", {
      companyId: "598134325683880",
    });

    // Page 1 mirrors both rows; page 2 returns them again — every row is
    // already in seenProjectIds, so the loop breaks before page 3.
    expect(result).toMatchObject({ backfilled: 2, errored: 0 });
    expect(vi.mocked(procoreClient.get)).toHaveBeenCalledTimes(2);
    const inserts = query.mock.calls
      .map((call) => String(call[0]))
      .filter((s) => s.includes("INSERT INTO \"office_dallas\".projects"));
    expect(inserts).toHaveLength(2);
  });

  it("resets search_path before releasing the pool client so it does not leak to the next consumer", async () => {
    vi.mocked(procoreClient.get).mockResolvedValueOnce([]);

    const { pool, query, release } = createPool(() => ({ rows: [] }));
    await runProjectsBackfill(pool, "office_dallas", "dallas", { companyId: "598134325683880" });

    const sqls = query.mock.calls.map((call) => String(call[0]));
    const setIdx = sqls.findIndex((s) => /SET search_path/.test(s));
    const resetIdx = sqls.findIndex((s) => /RESET search_path/.test(s));
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBeGreaterThan(setIdx);
    expect(release).toHaveBeenCalledTimes(1);
    // release must come after RESET — verifiable via vitest invocationCallOrder
    expect(release.mock.invocationCallOrder[0]).toBeGreaterThan(
      query.mock.invocationCallOrder[resetIdx]
    );
  });
});
