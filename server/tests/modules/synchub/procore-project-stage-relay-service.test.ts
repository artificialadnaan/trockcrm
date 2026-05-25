import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  processSyncHubProcoreProjectStageChanged,
  validateSyncHubProjectStageChangedPayload,
} from "../../../src/modules/synchub/procore-project-stage-relay-service.js";

const release = vi.fn();

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    eventType: "procore.project.stage_changed",
    source: "synchub",
    procore: {
      companyId: "598134325683880",
      portfolioProjectId: "987654321",
      projectNumber: "DFW-1-02326-ad",
      projectName: "T Rock Portfolio Project",
      previousStage: "Bidding",
      currentStage: "Buy Out",
    },
    stageChange: {
      previousStage: "Bidding",
      newStage: "Buy Out",
      detectedAt: "2026-05-20T14:15:00.000Z",
      webhookTimestamp: "2026-05-20T14:14:55.000Z",
    },
    synchub: {
      webhookLogId: "webhook-123",
      syncMappingId: "mapping-456",
      bidboardProjectId: "bid-789",
      hubspotDealId: "deal-hs-1",
      receivedAt: "2026-05-20T14:14:56.000Z",
      enrichedAt: "2026-05-20T14:15:00.000Z",
    },
    rawProcoreWebhook: {
      id: "raw-1",
      reason: "update",
      resource_type: "Projects",
      resource_id: "987654321",
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

function createRecordingClient(options: {
  existingReceiptStatus?: "processed" | "unresolved";
  officeRows?: Array<{ id: string; slug: string }>;
  matchRows?: any[];
  linkedMatchRows?: any[];
  projectNumberMatchRows?: any[];
  stageEntryId?: string;
} = {}) {
  return createClient((sql, params) => {
    if (sql.includes("FROM public.portfolio_project_stage_event_receipts")) {
      return {
        rows: options.existingReceiptStatus
          ? [{
              id: "receipt-1",
              event_key: "event-key",
              status: options.existingReceiptStatus,
              processed_at: options.existingReceiptStatus === "processed" ? "2026-05-20T14:15:05.000Z" : null,
            }]
          : [],
      };
    }
    if (sql.includes("FROM public.offices")) {
      return { rows: options.officeRows ?? [{ id: "office-1", slug: "main" }] };
    }
    if (sql.includes(".deals") && sql.includes("procore_project_id = $1")) {
      return {
        rows: options.linkedMatchRows ?? options.matchRows ?? [{
          office_id: "office-1",
          office_slug: "main",
          schema_name: "office_main",
          deal_id: "deal-1",
          deal_number: "DFW-1-02326-ad",
          procore_project_id: 987654321,
        }],
      };
    }
    if (sql.includes(".deals") && sql.includes("(deal_number = $1 OR project_number = $1)")) {
      return {
        rows: options.projectNumberMatchRows ?? options.matchRows ?? [{
          office_id: "office-1",
          office_slug: "main",
          schema_name: "office_main",
          deal_id: "deal-1",
          deal_number: params?.[0] ?? "DFW-1-02326-ad",
          procore_project_id: null,
        }],
      };
    }
    if (sql.includes("INSERT INTO public.portfolio_project_stage_event_receipts")) {
      return { rows: [{ id: "receipt-1" }] };
    }
    if (sql.includes("INSERT INTO \"office_main\".portfolio_projects")) {
      return { rows: [{ id: "portfolio-project-1" }] };
    }
    if (sql.includes("INSERT INTO \"office_main\".portfolio_project_stage_entries")) {
      return { rows: [{ id: options.stageEntryId ?? "stage-entry-1" }] };
    }
    return { rows: [] };
  });
}

function createStatefulRecordingClient() {
  const receipts = new Map<string, "processed" | "unresolved">();
  let stageEntryCount = 0;
  const { client, query } = createClient((sql, params) => {
    if (sql.includes("FROM public.portfolio_project_stage_event_receipts")) {
      const status = receipts.get(String(params?.[0]));
      return {
        rows: status
          ? [{
              id: `receipt-${params?.[0]}`,
              event_key: params?.[0],
              status,
              processed_at: status === "processed" ? "2026-05-20T14:15:05.000Z" : null,
            }]
          : [],
      };
    }
    if (sql.includes("FROM public.offices")) {
      return { rows: [{ id: "office-1", slug: "main" }] };
    }
    if (sql.includes(".deals") && sql.includes("procore_project_id = $1")) {
      return {
        rows: [{
          office_id: "office-1",
          office_slug: "main",
          schema_name: "office_main",
          deal_id: "deal-1",
          deal_number: "DFW-1-02326-ad",
          procore_project_id: 987654321,
        }],
      };
    }
    if (sql.includes("INSERT INTO public.portfolio_project_stage_event_receipts")) {
      const eventKey = String(params?.[0]);
      if (receipts.get(eventKey) === "processed") return { rows: [] };
      receipts.set(eventKey, "processed");
      return { rows: [{ id: `receipt-${receipts.size}` }] };
    }
    if (sql.includes("INSERT INTO \"office_main\".portfolio_projects")) {
      return { rows: [{ id: "portfolio-project-1" }] };
    }
    if (sql.includes("INSERT INTO \"office_main\".portfolio_project_stage_entries")) {
      stageEntryCount += 1;
      return { rows: [{ id: `stage-entry-${stageEntryCount}` }] };
    }
    return { rows: [] };
  });
  return { client, query, getStageEntryCount: () => stageEntryCount };
}

describe("SyncHub Procore project stage-change relay service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("validates and normalizes the supported stage-change event shape", () => {
    const payload = validateSyncHubProjectStageChangedPayload(validPayload());

    expect(payload.procore.currentStage).toBe("Buy Out");
    expect(payload.stageChange.newStage).toBe("Buy Out");
    expect(payload.stage.current.normalized).toBe("buyout");
    expect(payload.stage.current.isBoardRelevant).toBe(true);
    expect(() => validateSyncHubProjectStageChangedPayload({ eventType: "procore.project.created" }))
      .toThrow("unsupported event type");
    expect(() => validateSyncHubProjectStageChangedPayload(validPayload({ procore: { portfolioProjectId: "1" } })))
      .toThrow("procore.companyId is required");
  });

  it("records a correctly-shaped event into the new portfolio tables without touching legacy projects", async () => {
    const { client, query } = createRecordingClient();

    const result = await processSyncHubProcoreProjectStageChanged(validPayload(), {
      client: client as any,
      receivedAt: new Date("2026-05-20T14:15:05.000Z"),
    });

    const sqlText = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(result).toEqual({
      status: "recorded",
      officeId: "office-1",
      officeSlug: "main",
      projectId: "portfolio-project-1",
      stageEntryId: "stage-entry-1",
      isBoardRelevant: true,
    });
    expect(sqlText).toContain("INSERT INTO public.portfolio_project_stage_event_receipts");
    expect(sqlText).toContain("INSERT INTO \"office_main\".portfolio_projects");
    expect(sqlText).toContain("INSERT INTO \"office_main\".portfolio_project_stage_entries");
    expect(sqlText).not.toContain(".projects");
    expect(sqlText).not.toContain(" project_phase_history");
    expect(query.mock.calls.map((call) => String(call[0]))).toEqual(expect.arrayContaining(["BEGIN", "COMMIT"]));
  });

  it("is idempotent when SyncHub retries a fully processed event", async () => {
    const { client, query } = createRecordingClient({ existingReceiptStatus: "processed" });

    const result = await processSyncHubProcoreProjectStageChanged(validPayload(), {
      client: client as any,
    });

    expect(result).toEqual({ status: "duplicate", eventKey: expect.stringContaining("synchub-stage:webhook-123") });
    const sqlText = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).not.toContain("portfolio_project_stage_entries");
    expect(sqlText).not.toContain("portfolio_projects");
  });

  it("keeps a true outbox retry idempotent when trace ids are absent", async () => {
    const { client, getStageEntryCount } = createStatefulRecordingClient();
    const retryPayload = validPayload({
      rawProcoreWebhook: undefined,
      synchub: {
        syncMappingId: "mapping-456",
        bidboardProjectId: "bid-789",
        hubspotDealId: "deal-hs-1",
        receivedAt: "2026-05-20T14:14:56.000Z",
        enrichedAt: "2026-05-20T14:15:00.000Z",
      },
      stageChange: {
        previousStage: "Bidding",
        newStage: "Buy Out",
        detectedAt: null,
        webhookTimestamp: null,
      },
    });

    const first = await processSyncHubProcoreProjectStageChanged(retryPayload, { client: client as any });
    const second = await processSyncHubProcoreProjectStageChanged(retryPayload, { client: client as any });

    expect(first).toMatchObject({ status: "recorded" });
    expect(second).toEqual({ status: "duplicate", eventKey: expect.any(String) });
    expect(getStageEntryCount()).toBe(1);
  });

  it("records separate same-stage re-entry deliveries when trace ids and relay timestamps are absent", async () => {
    const { client, getStageEntryCount } = createStatefulRecordingClient();
    const firstDelivery = validPayload({
      rawProcoreWebhook: undefined,
      synchub: {
        syncMappingId: "mapping-456",
        bidboardProjectId: "bid-789",
        hubspotDealId: "deal-hs-1",
        receivedAt: "2026-05-20T14:14:56.000Z",
        enrichedAt: "2026-05-20T14:15:00.000Z",
      },
      stageChange: {
        previousStage: "Bidding",
        newStage: "Buy Out",
        detectedAt: null,
        webhookTimestamp: null,
      },
    });
    const reEntryDelivery = validPayload({
      rawProcoreWebhook: undefined,
      procore: {
        companyId: "598134325683880",
        portfolioProjectId: "987654321",
        projectNumber: "DFW-1-02326-ad",
        projectName: "T Rock Portfolio Project",
        previousStage: "In Production",
        currentStage: "Buy Out",
      },
      synchub: {
        syncMappingId: "mapping-456",
        bidboardProjectId: "bid-789",
        hubspotDealId: "deal-hs-1",
        receivedAt: "2026-06-01T09:00:00.000Z",
        enrichedAt: "2026-06-01T09:00:05.000Z",
      },
      stageChange: {
        previousStage: "In Production",
        newStage: "Buy Out",
        detectedAt: null,
        webhookTimestamp: null,
      },
    });

    const first = await processSyncHubProcoreProjectStageChanged(firstDelivery, { client: client as any });
    const second = await processSyncHubProcoreProjectStageChanged(reEntryDelivery, { client: client as any });

    expect(first).toMatchObject({ status: "recorded", stageEntryId: "stage-entry-1" });
    expect(second).toMatchObject({ status: "recorded", stageEntryId: "stage-entry-2" });
    expect(getStageEntryCount()).toBe(2);
  });

  it("reprocesses an unresolved receipt when the tenant mapping becomes available", async () => {
    const { client, query } = createRecordingClient({ existingReceiptStatus: "unresolved" });

    const result = await processSyncHubProcoreProjectStageChanged(validPayload(), {
      client: client as any,
      receivedAt: new Date("2026-05-20T15:00:00.000Z"),
    });

    expect(result).toEqual({
      status: "recorded",
      officeId: "office-1",
      officeSlug: "main",
      projectId: "portfolio-project-1",
      stageEntryId: "stage-entry-1",
      isBoardRelevant: true,
    });
    const sqlText = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).toContain("ON CONFLICT (event_key) DO UPDATE SET");
    expect(sqlText).toContain("WHERE receipts.status = 'unresolved'");
    expect(sqlText).toContain("INSERT INTO \"office_main\".portfolio_projects");
    expect(sqlText).toContain("INSERT INTO \"office_main\".portfolio_project_stage_entries");
  });

  it("records non-relevant stages without crashing or dropping the event", async () => {
    const { client } = createRecordingClient();

    const result = await processSyncHubProcoreProjectStageChanged(
      validPayload({
        procore: {
          companyId: "598134325683880",
          portfolioProjectId: "987654321",
          projectNumber: "DFW-1-02326-ad",
          projectName: "T Rock Portfolio Project",
          previousStage: "Closed",
          currentStage: "Warranty",
        },
        stageChange: {
          previousStage: "Closed",
          newStage: "Warranty",
          detectedAt: "2026-05-20T14:15:00.000Z",
          webhookTimestamp: null,
        },
      }),
      { client: client as any }
    );

    expect(result).toMatchObject({ status: "recorded", isBoardRelevant: false });
  });

  it("flags events that cannot be resolved to exactly one tenant instead of guessing", async () => {
    const { client, query } = createRecordingClient({ linkedMatchRows: [], projectNumberMatchRows: [] });

    const result = await processSyncHubProcoreProjectStageChanged(validPayload(), {
      client: client as any,
    });

    expect(result).toEqual({
      status: "unresolved",
      reason: "no_tenant_match",
      eventKey: expect.any(String),
    });
    const sqlText = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).toContain("INSERT INTO public.portfolio_project_stage_event_receipts");
    expect(sqlText).not.toContain("portfolio_project_stage_entries");
  });

  it("does not resolve project-number fallback to a deal linked to a different Procore project", async () => {
    const { client, query } = createRecordingClient({
      linkedMatchRows: [],
      projectNumberMatchRows: [{
        office_id: "office-1",
        office_slug: "main",
        schema_name: "office_main",
        deal_id: "deal-1",
        deal_number: "DFW-1-02326-ad",
        procore_project_id: 111111111,
      }],
    });

    const result = await processSyncHubProcoreProjectStageChanged(validPayload(), {
      client: client as any,
    });

    expect(result).toEqual({
      status: "unresolved",
      reason: "multiple_tenant_matches",
      eventKey: expect.any(String),
    });
    const sqlText = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).toContain("INSERT INTO public.portfolio_project_stage_event_receipts");
    expect(sqlText).not.toContain("INSERT INTO \"office_main\".portfolio_projects");
    expect(sqlText).not.toContain("INSERT INTO \"office_main\".portfolio_project_stage_entries");
  });

  it("uses the Procore company id when resolving the tenant match", async () => {
    const { client, query } = createRecordingClient();

    await processSyncHubProcoreProjectStageChanged(validPayload(), {
      client: client as any,
    });

    const matchSql = query.mock.calls
      .filter((call) => String(call[0]).includes(".deals"))
      .map((call) => String(call[0]))
      .join("\n");
    const matchParams = query.mock.calls.find((call) => String(call[0]).includes(".deals"))?.[1];
    expect(matchSql).toContain("procore_company_id = $5");
    expect(matchSql).not.toContain("procore_company_id IS NULL");
    expect(matchParams).toContain("598134325683880");
  });

  it("does not let late older events regress the current project snapshot", async () => {
    const { client, query } = createRecordingClient();

    await processSyncHubProcoreProjectStageChanged(validPayload(), {
      client: client as any,
    });

    const projectUpsertSql = String(query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO \"office_main\".portfolio_projects")
    )?.[0]);
    expect(projectUpsertSql).toContain("current_stage = CASE");
    expect(projectUpsertSql).toContain('EXCLUDED.current_stage_entered_at >= "office_main".portfolio_projects.current_stage_entered_at');
    expect(projectUpsertSql).toContain('ELSE "office_main".portfolio_projects.current_stage');
  });

  it("does not overwrite an existing project name with a fallback identifier when projectName is missing", async () => {
    const { client, query } = createRecordingClient();

    await processSyncHubProcoreProjectStageChanged(
      validPayload({
        procore: {
          companyId: "598134325683880",
          portfolioProjectId: "987654321",
          projectNumber: "DFW-1-02326-ad",
          projectName: null,
          previousStage: "Bidding",
          currentStage: "Buy Out",
        },
      }),
      { client: client as any }
    );

    const projectUpsertCall = query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO \"office_main\".portfolio_projects")
    );
    expect(String(projectUpsertCall?.[0])).toContain("WHEN $12::text IS NOT NULL THEN EXCLUDED.name");
    expect(String(projectUpsertCall?.[0])).toContain('ELSE "office_main".portfolio_projects.name');
    expect(projectUpsertCall?.[1]?.[3]).toBe("DFW-1-02326-ad");
    expect(projectUpsertCall?.[1]?.[11]).toBeNull();
  });

  it("uses the receipt time as a safe first-sight timestamp when relay timestamps are invalid", async () => {
    const { client, query } = createRecordingClient();

    await processSyncHubProcoreProjectStageChanged(
      validPayload({
        stageChange: {
          previousStage: "Bidding",
          newStage: "Buy Out",
          detectedAt: "not-a-date",
          webhookTimestamp: null,
        },
      }),
      {
        client: client as any,
        receivedAt: new Date("2026-05-20T14:15:05.000Z"),
      }
    );

    const stageEntryCall = query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO \"office_main\".portfolio_project_stage_entries")
    );
    expect(stageEntryCall?.[1]).toContain("2026-05-20T14:15:05.000Z");
  });
});
