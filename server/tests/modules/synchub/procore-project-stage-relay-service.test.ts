import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROCORE_COMPANY_OFFICE_MAP_ENV,
  processSyncHubProcoreProjectStageChanged,
  replayUnresolvedSyncHubProcoreProjectStageReceipts,
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
    if (sql.includes("INSERT INTO \"office_main\".portfolio_projects")
      || sql.includes("INSERT INTO \"office_dallas\".portfolio_projects")) {
      return { rows: [{ id: "portfolio-project-1" }] };
    }
    if (sql.includes("INSERT INTO \"office_main\".portfolio_project_stage_entries")
      || sql.includes("INSERT INTO \"office_dallas\".portfolio_project_stage_entries")) {
      return { rows: [{ id: options.stageEntryId ?? "stage-entry-1" }] };
    }
    return { rows: [] };
  });
}

function createStatefulRecordingClient(options: {
  /** Receipts that already exist — e.g. one written under a PRE-DEPLOY event key. */
  seedReceipts?: Record<string, "processed" | "unresolved">;
} = {}) {
  const receipts = new Map<string, "processed" | "unresolved">(
    Object.entries(options.seedReceipts ?? {}),
  );
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
    process.env[PROCORE_COMPANY_OFFICE_MAP_ENV] = "598134325683880=office_main";
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

  it("resolves a known Procore company id without requiring a Procore-linked deal", async () => {
    const { client, query } = createRecordingClient({
      linkedMatchRows: [],
      projectNumberMatchRows: [],
    });

    const result = await processSyncHubProcoreProjectStageChanged(validPayload(), {
      client: client as any,
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
    expect(sqlText).toContain("INSERT INTO \"office_main\".portfolio_projects");
    expect(sqlText).toContain("INSERT INTO \"office_main\".portfolio_project_stage_entries");
  });

  it("excludes change-order child deals from BOTH deal-match queries (Safety Req A)", async () => {
    // A CO child shares the parent's project_number; if the project_number match returned parent+child
    // it would be a multi-match and the parent's stage writeback would be silently skipped (Onyx class).
    const { client, query } = createRecordingClient({ linkedMatchRows: [], projectNumberMatchRows: [] });
    await processSyncHubProcoreProjectStageChanged(validPayload(), { client: client as any });
    const dealMatchSql = query.mock.calls
      .map((call) => String(call[0]))
      .filter((s) => s.includes('"office_main".deals'));
    // Both the procore_project_id and the (deal_number OR project_number) match queries run + are exempted.
    expect(dealMatchSql.length).toBeGreaterThanOrEqual(2);
    for (const s of dealMatchSql) {
      expect(s).toContain("COALESCE(is_change_order, false) = false");
    }
  });

  it("defaults the known production Procore company id to office_dallas without a Procore-linked deal", async () => {
    delete process.env[PROCORE_COMPANY_OFFICE_MAP_ENV];
    const { client, query } = createRecordingClient({
      officeRows: [{ id: "office-dallas", slug: "dallas" }],
      linkedMatchRows: [],
      projectNumberMatchRows: [],
    });

    const result = await processSyncHubProcoreProjectStageChanged(validPayload(), {
      client: client as any,
    });

    expect(result).toEqual({
      status: "recorded",
      officeId: "office-dallas",
      officeSlug: "dallas",
      projectId: "portfolio-project-1",
      stageEntryId: "stage-entry-1",
      isBoardRelevant: true,
    });
    const sqlText = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).toContain("INSERT INTO \"office_dallas\".portfolio_projects");
    expect(sqlText).toContain("INSERT INTO \"office_dallas\".portfolio_project_stage_entries");
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

  it("keeps a stage nobody anticipated BOARD-RELEVANT so it surfaces instead of disappearing", async () => {
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

    // "Warranty" has no alias and no column. It is NOT a decision to exclude, so the row stays
    // is_board_relevant = true and the board shows it under "Other / No Column". Writing false
    // here is what used to make such a project invisible: filtered out by the board query, and
    // (before the grouping fix) dropped from the project list as well.
    expect(result).toMatchObject({ status: "recorded", isBoardRelevant: true });
  });

  /**
   * The alias-map/event-key hazard.
   *
   * Event keys embed the ALIAS-normalized stage. This release added a `pre-construction` alias, which
   * changed Pre-Construction's canonical form from "pre - construction" (the bare textual form the old
   * code fell through to) to "pre-construction". So a receipt written BEFORE the deploy carries the old
   * key, and any re-delivery of the same webhook after the deploy — a SyncHub retry, or a replay of an
   * unresolved receipt, which re-derives the payload from raw_payload and recomputes the key — would
   * compute a DIFFERENT key: a second receipt, a second stage entry, and the original unresolved receipt
   * orphaned where no future replay can ever reach it.
   */
  function preConstructionPayload() {
    return validPayload({
      procore: {
        companyId: "598134325683880",
        portfolioProjectId: "987654321",
        projectNumber: "DFW-1-02326-ad",
        projectName: "T Rock Portfolio Project",
        previousStage: "Bidding",
        currentStage: "Pre-Construction",
      },
      stageChange: {
        previousStage: "Bidding",
        newStage: "Pre-Construction",
        detectedAt: "2026-05-20T14:15:00.000Z",
        webhookTimestamp: "2026-05-20T14:14:55.000Z",
      },
    });
  }

  /** The key the PRE-DEPLOY code produced: the bare form, before the alias existed. */
  const LEGACY_PRE_CONSTRUCTION_KEY =
    "synchub-stage:webhook-123:598134325683880:987654321:pre - construction:2026-05-20T14:15:00.000Z";

  it("adopts a pre-deploy event key instead of minting a second receipt for the same webhook", async () => {
    const { client, query, getStageEntryCount } = createStatefulRecordingClient({
      seedReceipts: { [LEGACY_PRE_CONSTRUCTION_KEY]: "unresolved" },
    });

    const result = await processSyncHubProcoreProjectStageChanged(preConstructionPayload(), {
      client: client as any,
      receivedAt: new Date("2026-05-20T14:15:05.000Z"),
    });

    expect(result.status).toBe("recorded");
    // Resolved under the OLD key, so the stuck unresolved row is the one that gets completed
    // rather than a fresh row being inserted alongside it.
    const receiptWrites = query.mock.calls
      .filter((call) => String(call[0]).includes("INSERT INTO public.portfolio_project_stage_event_receipts"))
      .map((call) => String((call[1] as unknown[])?.[0]));
    expect(receiptWrites).toEqual([LEGACY_PRE_CONSTRUCTION_KEY]);
    expect(receiptWrites).not.toContain(
      "synchub-stage:webhook-123:598134325683880:987654321:pre-construction:2026-05-20T14:15:00.000Z",
    );
    expect(getStageEntryCount()).toBe(1);
  });

  it("treats a replayed pre-deploy receipt as a DUPLICATE once it has been processed", async () => {
    const { client, getStageEntryCount } = createStatefulRecordingClient({
      seedReceipts: { [LEGACY_PRE_CONSTRUCTION_KEY]: "processed" },
    });

    const result = await processSyncHubProcoreProjectStageChanged(preConstructionPayload(), {
      client: client as any,
      receivedAt: new Date("2026-05-20T14:15:05.000Z"),
    });

    expect(result).toEqual({ status: "duplicate", eventKey: LEGACY_PRE_CONSTRUCTION_KEY });
    expect(getStageEntryCount()).toBe(0); // no twin stage entry
  });

  it("mints the current-format key when there is no pre-deploy receipt to adopt", async () => {
    const { client, query } = createStatefulRecordingClient();

    await processSyncHubProcoreProjectStageChanged(preConstructionPayload(), {
      client: client as any,
      receivedAt: new Date("2026-05-20T14:15:05.000Z"),
    });

    const receiptWrites = query.mock.calls
      .filter((call) => String(call[0]).includes("INSERT INTO public.portfolio_project_stage_event_receipts"))
      .map((call) => String((call[1] as unknown[])?.[0]));
    expect(receiptWrites).toEqual([
      "synchub-stage:webhook-123:598134325683880:987654321:pre-construction:2026-05-20T14:15:00.000Z",
    ]);
  });

  it("is still idempotent for a stage whose canonical form did NOT change", async () => {
    // Buy Out was aliased before and after, so old and new keys are identical; the legacy-candidate
    // lookup must not change behaviour here.
    const { client, getStageEntryCount } = createStatefulRecordingClient();

    const first = await processSyncHubProcoreProjectStageChanged(validPayload(), {
      client: client as any,
      receivedAt: new Date("2026-05-20T14:15:05.000Z"),
    });
    const second = await processSyncHubProcoreProjectStageChanged(validPayload(), {
      client: client as any,
      receivedAt: new Date("2026-05-20T14:16:05.000Z"),
    });

    expect(first.status).toBe("recorded");
    expect(second.status).toBe("duplicate");
    expect(getStageEntryCount()).toBe(1);
  });

  it("marks the explicitly off-board legacy stages as NOT board-relevant", async () => {
    const { client } = createRecordingClient();

    const result = await processSyncHubProcoreProjectStageChanged(
      validPayload({
        procore: {
          companyId: "598134325683880",
          portfolioProjectId: "987654321",
          projectNumber: "DFW-1-02326-ad",
          projectName: "T Rock Portfolio Project",
          previousStage: "Closed",
          currentStage: "Hold (LEGACY)",
        },
        stageChange: {
          previousStage: "Closed",
          newStage: "Hold (LEGACY)",
          detectedAt: "2026-05-20T14:15:00.000Z",
          webhookTimestamp: null,
        },
      }),
      { client: client as any }
    );

    // The event is still recorded — exclusion is a deliberate, auditable decision, not a drop.
    expect(result).toMatchObject({ status: "recorded", isBoardRelevant: false });
  });

  it("flags events that cannot be resolved to exactly one tenant instead of guessing", async () => {
    const { client, query } = createRecordingClient({ linkedMatchRows: [], projectNumberMatchRows: [] });

    const result = await processSyncHubProcoreProjectStageChanged(
      validPayload({
        procore: {
          companyId: "999999999",
          portfolioProjectId: "987654321",
          projectNumber: "DFW-1-02326-ad",
          projectName: "T Rock Portfolio Project",
          previousStage: "Bidding",
          currentStage: "Buy Out",
        },
      }),
      { client: client as any }
    );

    expect(result).toEqual({
      status: "unresolved",
      reason: "no_tenant_match",
      eventKey: expect.any(String),
    });
    const sqlText = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).toContain("INSERT INTO public.portfolio_project_stage_event_receipts");
    expect(sqlText).not.toContain("portfolio_project_stage_entries");
    expect(sqlText).not.toContain(".deals");
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

  it("dry-runs replay of previously unresolved receipts before writing portfolio rows", async () => {
    const { client, query } = createClient((sql) => {
      if (sql.includes("FROM public.portfolio_project_stage_event_receipts") && sql.includes("status = 'unresolved'")) {
        return {
          rows: [{
            id: "receipt-unresolved-1",
            event_key: "synchub-stage:webhook-123:598134325683880:987654321:buyout:2026-05-20T14:15:00.000Z",
            procore_company_id: "598134325683880",
            procore_portfolio_project_id: "987654321",
            project_number: "DFW-1-02326-ad",
            raw_payload: validPayload(),
          }],
        };
      }
      if (sql.includes("FROM public.offices")) {
        return { rows: [{ id: "office-1", slug: "main" }] };
      }
      if (sql.includes(".deals")) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const result = await replayUnresolvedSyncHubProcoreProjectStageReceipts({
      client: client as any,
      commit: false,
    });

    expect(result).toMatchObject({
      mode: "dry-run",
      scanned: 1,
      wouldReplay: 1,
      replayed: 0,
      stillUnresolved: 0,
      failed: 0,
    });
    const sqlText = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).not.toContain("INSERT INTO \"office_main\".portfolio_projects");
    expect(sqlText).not.toContain("INSERT INTO public.portfolio_project_stage_event_receipts");
  });

  it("commits replay of a previously unresolved receipt into portfolio rows", async () => {
    const { client, query } = createClient((sql) => {
      if (sql.includes("FROM public.portfolio_project_stage_event_receipts") && sql.includes("status = 'unresolved'")) {
        return {
          rows: [{
            id: "receipt-unresolved-1",
            event_key: "synchub-stage:webhook-123:598134325683880:987654321:buyout:2026-05-20T14:15:00.000Z",
            procore_company_id: "598134325683880",
            procore_portfolio_project_id: "987654321",
            project_number: "DFW-1-02326-ad",
            raw_payload: validPayload(),
          }],
        };
      }
      if (sql.includes("FROM public.portfolio_project_stage_event_receipts") && sql.includes("WHERE event_key = $1")) {
        return {
          rows: [{
            id: "receipt-1",
            event_key: "synchub-stage:webhook-123:598134325683880:987654321:buyout:2026-05-20T14:15:00.000Z",
            status: "unresolved",
            processed_at: null,
          }],
        };
      }
      if (sql.includes("FROM public.offices")) {
        return { rows: [{ id: "office-1", slug: "main" }] };
      }
      if (sql.includes(".deals")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO public.portfolio_project_stage_event_receipts")) {
        return { rows: [{ id: "receipt-1" }] };
      }
      if (sql.includes("INSERT INTO \"office_main\".portfolio_projects")) {
        return { rows: [{ id: "portfolio-project-1" }] };
      }
      if (sql.includes("INSERT INTO \"office_main\".portfolio_project_stage_entries")) {
        return { rows: [{ id: "stage-entry-1" }] };
      }
      return { rows: [] };
    });

    const result = await replayUnresolvedSyncHubProcoreProjectStageReceipts({
      client: client as any,
      commit: true,
    });

    expect(result).toMatchObject({
      mode: "commit",
      scanned: 1,
      replayed: 1,
      stillUnresolved: 0,
      failed: 0,
    });
    const sqlText = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).toContain("INSERT INTO \"office_main\".portfolio_projects");
    expect(sqlText).toContain("INSERT INTO \"office_main\".portfolio_project_stage_entries");
  });

  it("keeps replayed unknown-company receipts in the unresolved bucket instead of duplicate", async () => {
    const unresolvedPayload = validPayload({
      procore: {
        companyId: "999999999",
        portfolioProjectId: "987654321",
        projectNumber: "DFW-1-02326-ad",
        projectName: "T Rock Portfolio Project",
        previousStage: "Bidding",
        currentStage: "Buy Out",
      },
    });
    const { client, query } = createClient((sql) => {
      if (sql.includes("FROM public.portfolio_project_stage_event_receipts") && sql.includes("status = 'unresolved'")) {
        return {
          rows: [{
            id: "receipt-unresolved-1",
            event_key: "synchub-stage:webhook-unknown:999999999:987654321:buyout:2026-05-20T14:15:00.000Z",
            procore_company_id: "999999999",
            procore_portfolio_project_id: "987654321",
            project_number: "DFW-1-02326-ad",
            raw_payload: unresolvedPayload,
          }],
        };
      }
      if (sql.includes("FROM public.portfolio_project_stage_event_receipts") && sql.includes("WHERE event_key = $1")) {
        return {
          rows: [{
            id: "receipt-1",
            event_key: "synchub-stage:webhook-unknown:999999999:987654321:buyout:2026-05-20T14:15:00.000Z",
            status: "unresolved",
            processed_at: null,
          }],
        };
      }
      if (sql.includes("FROM public.offices")) {
        return { rows: [{ id: "office-1", slug: "main" }] };
      }
      if (sql.includes("INSERT INTO public.portfolio_project_stage_event_receipts")) {
        return { rows: [{ id: "receipt-1" }] };
      }
      return { rows: [] };
    });

    const result = await replayUnresolvedSyncHubProcoreProjectStageReceipts({
      client: client as any,
      commit: true,
    });

    expect(result).toMatchObject({
      mode: "commit",
      scanned: 1,
      replayed: 0,
      duplicates: 0,
      stillUnresolved: 1,
      failed: 0,
    });
    expect(result.results[0]).toMatchObject({
      outcome: "unresolved",
      reason: "no_tenant_match",
    });
    const sqlText = query.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlText).toContain("ON CONFLICT (event_key) DO UPDATE SET");
    expect(sqlText).toContain("WHERE receipts.status = 'unresolved'");
    expect(sqlText).not.toContain("portfolio_project_stage_entries");
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
