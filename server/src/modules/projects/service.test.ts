import { describe, expect, it, vi } from "vitest";
import {
  buildProjectMirrorFields,
  deriveIsActive,
  getProjectCounts,
  getProjectDetail,
  listProjects,
  listProjectsByPhase,
  upsertProjectMirror,
} from "./service.js";

function createClient(responder: (sql: string, params: unknown[] | undefined) => unknown) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => responder(sql, params));
  return { query };
}

describe("projects mirror service", () => {
  it("normalizes Procore snapshot fields without translating phase names", () => {
    const fields = buildProjectMirrorFields({
      procoreProjectId: "598134326517540",
      procoreCompanyId: "598134325683880",
      procoreProjectNumber: "DFW-1-02326-ad",
      name: "Portfolio Roof Replacement",
      sourceDealId: "deal-1",
      syncSource: "webhook",
      snapshot: {
        id: 598134326517540,
        description: "Scope notes",
        address: { street: "123 Main St", city: "Dallas", state_code: "TX", zip: "75201", country_code: "US" },
        project_stage: { id: 44, name: "Course of Construction", position: 3 },
        active: true,
        start_date: "2026-05-01",
        completion_date: "2026-06-01",
        projected_finish_date: "2026-06-15",
        estimated_value: "100000.50",
        total_value: "125000.75",
        owner: { id: 99, name: "Pat Owner" },
        created_at: "2026-04-01T12:00:00Z",
        updated_at: "2026-05-01T12:00:00Z",
      },
    });

    expect(fields.currentPhaseId).toBe("44");
    expect(fields.currentPhaseName).toBe("Course of Construction");
    expect(fields.currentPhaseSortOrder).toBe(3);
    expect(fields.addressLine1).toBe("123 Main St");
    expect(fields.city).toBe("Dallas");
    expect(fields.contractValue).toBe("125000.75");
    expect(fields.projectOwnerId).toBe("99");
    expect(fields.projectOwnerName).toBe("Pat Owner");
  });

  it("inserts phase history only when the mirrored phase changes", async () => {
    const { query } = createClient((sql) => {
      if (sql.includes("SELECT id, current_phase_id, current_phase_name")) {
        return { rows: [{ id: "project-1", current_phase_id: "old", current_phase_name: "Pre-Construction" }] };
      }
      if (sql.includes("RETURNING id")) return { rows: [{ id: "project-1", inserted: false }] };
      return { rows: [] };
    });

    await upsertProjectMirror({ query } as any, "office_dallas", {
      procoreProjectId: "598134326517540",
      procoreCompanyId: "598134325683880",
      procoreProjectNumber: "DFW-1-02326-ad",
      name: "Portfolio Roof Replacement",
      sourceDealId: "deal-1",
      syncSource: "webhook",
      snapshot: {
        project_stage: { id: "new", name: "Course of Construction" },
      },
    });

    const sqlText = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).toContain("INSERT INTO \"office_dallas\".projects");
    expect(sqlText).toContain("INSERT INTO \"office_dallas\".project_phase_history");
    expect(query.mock.calls.some((call) => call[1]?.includes("Pre-Construction"))).toBe(true);
    expect(query.mock.calls.some((call) => call[1]?.includes("Course of Construction"))).toBe(true);
  });

  it("does not duplicate phase history when backfill sees the same phase twice", async () => {
    const { query } = createClient((sql) => {
      if (sql.includes("SELECT id, current_phase_id, current_phase_name")) {
        return { rows: [{ id: "project-1", current_phase_id: "same", current_phase_name: "Warranty" }] };
      }
      if (sql.includes("RETURNING id")) return { rows: [{ id: "project-1", inserted: false }] };
      return { rows: [] };
    });

    await upsertProjectMirror({ query } as any, "office_dallas", {
      procoreProjectId: "598134326517540",
      procoreCompanyId: "598134325683880",
      procoreProjectNumber: "DFW-1-02326-ad",
      name: "Portfolio Roof Replacement",
      syncSource: "backfill",
      snapshot: { project_stage: { id: "same", name: "Warranty" } },
    });

    const sqlText = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).toContain("INSERT INTO \"office_dallas\".projects");
    expect(sqlText).not.toContain("INSERT INTO \"office_dallas\".project_phase_history");
  });

  it("inserts missing initial phase history when a concurrent upsert won the project insert", async () => {
    const { query } = createClient((sql) => {
      if (sql.includes("SELECT id, current_phase_id, current_phase_name")) {
        return { rows: [] };
      }
      if (sql.includes("RETURNING id")) return { rows: [{ id: "project-1", inserted: false }] };
      return { rows: [] };
    });

    await upsertProjectMirror({ query } as any, "office_dallas", {
      procoreProjectId: "598134326517540",
      procoreCompanyId: "598134325683880",
      procoreProjectNumber: "DFW-1-02326-ad",
      name: "Portfolio Roof Replacement",
      syncSource: "backfill",
      snapshot: { project_stage: { id: "same", name: "Warranty" } },
    });

    const sqlText = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).toContain("RETURNING id, (xmax = 0) AS inserted");
    expect(sqlText).toContain("INSERT INTO \"office_dallas\".project_phase_history");
    expect(sqlText).toContain("ON CONFLICT DO NOTHING");
  });

  describe("active filter on list endpoints", () => {
    function captureSql() {
      const seen: { sql: string; params: unknown[] | undefined }[] = [];
      const query = vi.fn(async (sql: string, params?: unknown[]) => {
        seen.push({ sql, params });
        if (sql.includes("SELECT COUNT(*)")) return { rows: [{ total: 0 }] };
        return { rows: [] };
      });
      return { client: { query } as any, seen };
    }

    it("listProjects applies is_active = true by default", async () => {
      const { client, seen } = captureSql();
      await listProjects(client, { page: 1, perPage: 25 });
      const sqls = seen.map((entry) => entry.sql).join("\n");
      expect(sqls).toContain("p.is_active = true");
    });

    it("listProjects omits the is_active filter when includeInactive=true", async () => {
      const { client, seen } = captureSql();
      await listProjects(client, { page: 1, perPage: 25, includeInactive: true });
      const sqls = seen.map((entry) => entry.sql).join("\n");
      expect(sqls).not.toContain("p.is_active = true");
    });

    it("listProjectsByPhase applies is_active = true by default", async () => {
      const { client, seen } = captureSql();
      await listProjectsByPhase(client, {});
      const sqls = seen.map((entry) => entry.sql).join("\n");
      expect(sqls).toContain("p.is_active = true");
    });

    it("listProjectsByPhase omits the is_active filter when includeInactive=true", async () => {
      const { client, seen } = captureSql();
      await listProjectsByPhase(client, { includeInactive: true });
      const sqls = seen.map((entry) => entry.sql).join("\n");
      expect(sqls).not.toContain("p.is_active = true");
    });
  });

  describe("deriveIsActive", () => {
    it("returns null when the snapshot carries no active signal at all", () => {
      // The SyncHub webhook relay sends sparse snapshots like
      // { id, company_id, project_number, name } — no `active`, no
      // `status_name`. The mirror must treat that as 'no information'
      // and preserve the existing CRM row, not force-flip is_active.
      expect(deriveIsActive(null)).toBeNull();
      expect(deriveIsActive(undefined)).toBeNull();
      expect(deriveIsActive({})).toBeNull();
      expect(deriveIsActive({ name: "X", project_number: "DFW-1" })).toBeNull();
    });

    it("trusts snapshot.active when it is a boolean", () => {
      expect(deriveIsActive({ active: true })?.isActive).toBe(true);
      expect(deriveIsActive({ active: false })?.isActive).toBe(false);
    });

    it("falls back to status_name when active is not a boolean", () => {
      expect(deriveIsActive({ status_name: "Active" })?.isActive).toBe(true);
      expect(deriveIsActive({ status_name: "Inactive" })?.isActive).toBe(false);
    });
  });

  describe("upsert preserves is_active when the snapshot is sparse", () => {
    it("passes a null is_active param and uses COALESCE to keep the prior row state", async () => {
      const { query } = createClient((sql) => {
        if (sql.includes("SELECT id, current_phase_id, current_phase_name")) {
          return { rows: [{ id: "project-1", current_phase_id: null, current_phase_name: null }] };
        }
        if (sql.includes("RETURNING id")) return { rows: [{ id: "project-1", inserted: false }] };
        return { rows: [] };
      });

      await upsertProjectMirror({ query } as any, "office_dallas", {
        procoreProjectId: "598134326517540",
        procoreCompanyId: "598134325683880",
        procoreProjectNumber: "DFW-1-02326-ad",
        name: "Webhook relay payload",
        syncSource: "webhook",
        snapshot: {
          id: "598134326517540",
          company_id: "598134325683880",
          project_number: "DFW-1-02326-ad",
          name: "Webhook relay payload",
        },
      });

      const insertCall = query.mock.calls.find(([sql]) =>
        String(sql).includes("INSERT INTO \"office_dallas\".projects")
      );
      expect(insertCall).toBeDefined();
      // is_active param is null because the snapshot has no signal.
      expect((insertCall![1] as unknown[])[15]).toBeNull();
      const sql = String(insertCall![0]);
      expect(sql).toContain("COALESCE($16::boolean, true)");
      expect(sql).toContain("COALESCE($16::boolean, \"office_dallas\".projects.is_active)");
    });
  });

  describe("getProjectDetail does NOT filter by is_active", () => {
    it("returns the project even when is_active = false so direct links keep working", async () => {
      const { query } = createClient((sql) => {
        if (sql.includes("SELECT p.*, d.deal_number")) {
          return {
            rows: [
              {
                id: "inactive-project",
                procore_project_id: "999",
                name: "Soft-deleted project",
                is_active: false,
                procore_raw_snapshot: {},
                source_deal_id: null,
                source_deal_number: null,
                source_deal_name: null,
                address_line_1: null,
                address_line_2: null,
                city: null,
                state: null,
                postal_code: null,
                country: null,
                current_phase_id: null,
                current_phase_name: null,
                current_phase_sort_order: null,
              },
            ],
          };
        }
        return { rows: [] };
      });

      const detail = await getProjectDetail({ query } as any, "00000000-0000-0000-0000-0000000000aa");
      expect(detail).not.toBeNull();
      expect(detail!.isActive).toBe(false);
      const sqls = query.mock.calls.map((call) => String(call[0])).join("\n");
      expect(sqls).not.toContain("p.is_active = true");
    });
  });

  describe("getProjectCounts", () => {
    it("returns active / inactive / total split from a single COUNT(*) FILTER query", async () => {
      const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
        rows: [{ active: 330, inactive: 392, total: 722 }],
      }));
      const counts = await getProjectCounts({ query } as any);
      expect(counts).toEqual({ active: 330, inactive: 392, total: 722 });
      expect(String(query.mock.calls[0]?.[0] ?? "")).toMatch(/COUNT\(\*\) FILTER \(WHERE is_active = true\)/);
    });

    it("falls back to zeros when the query returns no rows", async () => {
      const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as unknown[] }));
      const counts = await getProjectCounts({ query } as any);
      expect(counts).toEqual({ active: 0, inactive: 0, total: 0 });
    });
  });

  it("creates one initial phase history row for concurrent phase-name-only upserts", async () => {
    const projectRows = new Map<string, { id: string; current_phase_id: string | null; current_phase_name: string | null }>();
    const initialHistoryKeys = new Set<string>();
    const phaseHistoryRows: unknown[][] = [];
    let projectInsertAttempts = 0;

    const { query } = createClient(async (sql, params) => {
      if (sql.includes("SELECT id, current_phase_id, current_phase_name")) {
        return { rows: projectRows.has(String(params?.[0])) ? [projectRows.get(String(params?.[0]))] : [] };
      }

      if (sql.includes("INSERT INTO \"office_dallas\".projects")) {
        projectInsertAttempts += 1;
        await new Promise((resolve) => setTimeout(resolve, projectInsertAttempts === 1 ? 10 : 0));
        const procoreProjectId = String(params?.[1]);
        const inserted = !projectRows.has(procoreProjectId);
        const row = {
          id: "project-1",
          current_phase_id: params?.[12] == null ? null : String(params[12]),
          current_phase_name: params?.[13] == null ? null : String(params[13]),
        };
        projectRows.set(procoreProjectId, row);
        return { rows: [{ id: row.id, inserted }] };
      }

      if (sql.includes("INSERT INTO \"office_dallas\".project_phase_history")) {
        const key = `${params?.[0]}:${params?.[1] ?? ""}:${params?.[2]}`;
        if (!initialHistoryKeys.has(key)) {
          initialHistoryKeys.add(key);
          phaseHistoryRows.push(params ?? []);
        }
        return { rows: [] };
      }

      return { rows: [] };
    });

    const payload = {
      procoreProjectId: "598134326517540",
      procoreCompanyId: "598134325683880",
      procoreProjectNumber: "DFW-1-02326-ad",
      name: "Portfolio Roof Replacement",
      syncSource: "backfill" as const,
      snapshot: { project_stage_name: "Pre-Construction" },
    };

    await Promise.all([
      upsertProjectMirror({ query } as any, "office_dallas", payload),
      upsertProjectMirror({ query } as any, "office_dallas", payload),
    ]);

    expect(phaseHistoryRows).toHaveLength(1);
    expect(phaseHistoryRows[0][1]).toBeNull();
    expect(phaseHistoryRows[0][2]).toBe("Pre-Construction");
  });
});
