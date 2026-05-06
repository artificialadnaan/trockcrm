import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  processSyncHubProcoreProjectCreated,
  validateSyncHubProjectCreatedPayload,
} from "./procore-project-relay-service.js";

const release = vi.fn();

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    eventType: "procore.project.created",
    source: "synchub",
    procore: {
      companyId: "598134325683880",
      portfolioProjectId: "123456789",
      projectNumber: "DFW-1-02326-ad",
      projectName: "T Rock Portfolio Project",
    },
    synchub: {
      webhookLogId: "wh-1",
      syncMappingId: "map-1",
      bidboardProjectId: "bid-1",
      hubspotDealId: null,
      receivedAt: "2026-05-01T12:00:00.000Z",
      enrichedAt: "2026-05-01T12:00:05.000Z",
    },
    rawProcoreWebhook: {
      id: "raw-1",
      reason: "create",
      resource_type: "Projects",
      resource_id: "123456789",
    },
    ...overrides,
  };
}

function createClient(responder: (sql: string, params: unknown[] | undefined) => unknown) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => responder(sql, params));
  return {
    client: { query, release },
    query,
  };
}

function expectDealQueriesUseActiveFilter(query: ReturnType<typeof vi.fn>) {
  const sqlText = query.mock.calls.map((call) => String(call[0])).join("\n");
  expect(sqlText).not.toContain("deleted_at");
  expect(sqlText).toContain("is_active = true");
}

describe("SyncHub Procore project relay service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("validates the supported event shape", () => {
    expect(validateSyncHubProjectCreatedPayload(validPayload()).procore.projectNumber).toBe("DFW-1-02326-ad");
    expect(() => validateSyncHubProjectCreatedPayload({ eventType: "procore.project.updated" })).toThrow("unsupported event type");
    expect(() => validateSyncHubProjectCreatedPayload(validPayload({ procore: { portfolioProjectId: "1" } }))).toThrow("projectNumber is required");
    expect(() => validateSyncHubProjectCreatedPayload(validPayload({ procore: { projectNumber: "DFW-1" } }))).toThrow("portfolioProjectId is required");
  });

  it("links a single matching deal, creates sync state, and enqueues post-creation work", async () => {
    const { client, query } = createClient((sql) => {
      if (sql.includes("procore_project_id = $1") && sql.includes("UNION ALL")) return { rows: [] };
      if (sql.includes("FROM public.synchub_webhook_orphans")) return { rows: [] };
      if (sql.includes("FROM public.offices")) return { rows: [{ id: "office-1", slug: "main" }] };
      if (sql.includes("deal_number = $1")) return { rows: [{ office_id: "office-1", office_slug: "main", schema_name: "office_main", deal_id: "deal-1", deal_number: "DFW-1-02326-ad", procore_project_id: null }] };
      if (sql.includes("FOR UPDATE")) return { rows: [{ id: "deal-1", procore_project_id: null }] };
      if (sql.includes("INSERT INTO public.job_queue")) return { rows: [{ id: 77 }] };
      return { rows: [] };
    });

    const result = await processSyncHubProcoreProjectCreated(validPayload(), { client: client as any });

    const sqlText = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(result).toEqual({ status: "linked", dealId: "deal-1", officeId: "office-1", jobId: 77 });
    expect(sqlText).toContain('UPDATE "office_main".deals');
    expect(sqlText).toContain("INSERT INTO public.procore_sync_state");
    expect(query.mock.calls.some((call) => String(call[1]?.[0]).includes("\"action\":\"create_project\""))).toBe(true);
    expect(query.mock.calls.some((call) => String(call[1]?.[0]).includes("\"projectAlreadyExists\":true"))).toBe(true);
    expect(sqlText).toContain("INSERT INTO public.job_queue");
    expect(sqlText).not.toContain("rest/v1.0/companies");
    expectDealQueriesUseActiveFilter(query);
  });

  it("treats duplicate relays for an already-linked Procore project as idempotent", async () => {
    const { client, query } = createClient((sql) => {
      if (sql.includes("FROM public.offices")) return { rows: [{ id: "office-1", slug: "main" }] };
      if (sql.includes("procore_project_id = $1")) {
        return { rows: [{ office_id: "office-1", schema_name: "office_main", deal_id: "deal-1" }] };
      }
      return { rows: [] };
    });

    const result = await processSyncHubProcoreProjectCreated(validPayload(), { client: client as any });

    expect(result).toEqual({ status: "already_linked", dealId: "deal-1", officeId: "office-1" });
    expect(query.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("INSERT INTO public.job_queue");
    expectDealQueriesUseActiveFilter(query);
  });

  it("persists an orphan when no CRM deal matches the project number", async () => {
    const { client, query } = createClient((sql) => {
      if (sql.includes("procore_project_id = $1") && sql.includes("UNION ALL")) return { rows: [] };
      if (sql.includes("FROM public.synchub_webhook_orphans")) return { rows: [] };
      if (sql.includes("FROM public.offices")) return { rows: [{ id: "office-1", slug: "main" }] };
      if (sql.includes("deal_number = $1")) return { rows: [] };
      if (sql.includes("INSERT INTO public.synchub_webhook_orphans")) return { rows: [{ id: "orphan-1" }] };
      return { rows: [] };
    });

    const result = await processSyncHubProcoreProjectCreated(validPayload(), { client: client as any });

    expect(result).toEqual({ status: "orphaned", orphanId: "orphan-1", reason: "no_match" });
    const sqlText = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).toContain("INSERT INTO public.synchub_webhook_orphans");
    expect(sqlText).not.toContain("UPDATE office_main.deals");
    expectDealQueriesUseActiveFilter(query);
  });

  it("persists an ambiguous orphan when the project number matches multiple tenant deals", async () => {
    const { client, query } = createClient((sql) => {
      if (sql.includes("procore_project_id = $1") && sql.includes("UNION ALL")) return { rows: [] };
      if (sql.includes("FROM public.synchub_webhook_orphans")) return { rows: [] };
      if (sql.includes("FROM public.offices")) return { rows: [{ id: "office-1", slug: "main" }, { id: "office-2", slug: "atlanta" }] };
      if (sql.includes('"office_main".deals') && sql.includes("deal_number = $1")) return { rows: [{ office_id: "office-1", office_slug: "main", schema_name: "office_main", deal_id: "deal-1", deal_number: "DFW-1-02326-ad", procore_project_id: null }] };
      if (sql.includes('"office_atlanta".deals') && sql.includes("deal_number = $1")) return { rows: [{ office_id: "office-2", office_slug: "atlanta", schema_name: "office_atlanta", deal_id: "deal-2", deal_number: "DFW-1-02326-ad", procore_project_id: null }] };
      if (sql.includes("INSERT INTO public.synchub_webhook_orphans")) return { rows: [{ id: "orphan-2" }] };
      return { rows: [] };
    });

    const result = await processSyncHubProcoreProjectCreated(validPayload(), { client: client as any });

    expect(result).toEqual({ status: "ambiguous", orphanId: "orphan-2", reason: "multiple_matches" });
    expectDealQueriesUseActiveFilter(query);
  });

  it("does not overwrite a matched deal linked to a different Procore project", async () => {
    const { client, query } = createClient((sql) => {
      if (sql.includes("procore_project_id = $1") && sql.includes("UNION ALL")) return { rows: [] };
      if (sql.includes("FROM public.synchub_webhook_orphans")) return { rows: [] };
      if (sql.includes("FROM public.offices")) return { rows: [{ id: "office-1", slug: "main" }] };
      if (sql.includes("deal_number = $1")) return { rows: [{ office_id: "office-1", office_slug: "main", schema_name: "office_main", deal_id: "deal-1", deal_number: "DFW-1-02326-ad", procore_project_id: 999 }] };
      if (sql.includes("FOR UPDATE")) return { rows: [{ id: "deal-1", procore_project_id: 999 }] };
      if (sql.includes("INSERT INTO public.synchub_webhook_orphans")) return { rows: [{ id: "orphan-3" }] };
      return { rows: [] };
    });

    const result = await processSyncHubProcoreProjectCreated(validPayload(), { client: client as any });

    expect(result).toEqual({ status: "ambiguous", orphanId: "orphan-3", reason: "matched_deal_has_different_procore_project" });
    expect(query.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("SET procore_project_id = $1");
    expectDealQueriesUseActiveFilter(query);
  });
});
