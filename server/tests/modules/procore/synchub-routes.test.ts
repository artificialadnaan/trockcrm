import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  connect: vi.fn(),
}));

vi.mock("../../../src/db.js", () => ({
  pool: {
    connect: dbMocks.connect,
  },
  isBrokenConnectionError: () => false,
  releasePooledClient: vi.fn(),
}));

const { syncHubRoutes } = await import("../../../src/modules/procore/synchub-routes.js");
const { errorHandler } = await import("../../../src/middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/integrations/synchub", syncHubRoutes);
  app.use(errorHandler);
  return app;
}

type ClientOptions = {
  workflowRoute?: "normal" | "service";
  existingDealIdBySyncHubBidBoardId?: string | null;
  existingDealIdByProcoreBid?: string | null;
  existingSyncHubBidBoardIdByProcoreBid?: string | null;
  existingDealIdByName?: string | null;
  currentStageEnteredAt?: Date;
  requestStageFamily?: string | null;
  targetStageSlug?: string;
  targetStageWorkflowFamily?: "standard_deal" | "service_deal";
  currentDealOverrides?: Record<string, unknown>;
};

function createClient(options: ClientOptions = {}) {
  const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const workflowRoute = options.workflowRoute ?? "normal";
  const currentStageEnteredAt =
    options.currentStageEnteredAt ?? new Date("2026-04-20T12:00:00.000Z");

  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });

      if (sql.includes("SELECT id FROM public.offices")) {
        return { rows: [{ id: "office-1" }] };
      }
      if (sql.includes("SELECT id FROM public.users WHERE email")) {
        return { rows: [] };
      }
      if (
        sql.includes("SELECT id FROM public.users") &&
        sql.includes("role IN ('admin', 'director')")
      ) {
        return { rows: [{ id: "director-1" }] };
      }
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      if (sql.includes("SELECT pg_advisory_xact_lock(hashtext($1))")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT id FROM office_dallas.deals WHERE synchub_bid_board_id")) {
        return {
          rows: options.existingDealIdBySyncHubBidBoardId
            ? [{ id: options.existingDealIdBySyncHubBidBoardId }]
            : [],
        };
      }
      if (sql.includes("FROM office_dallas.deals WHERE procore_bid_id")) {
        return {
          rows: options.existingDealIdByProcoreBid
            ? [{
                id: options.existingDealIdByProcoreBid,
                synchub_bid_board_id: options.existingSyncHubBidBoardIdByProcoreBid ?? null,
              }]
            : [],
        };
      }
      if (sql.includes("LOWER(TRIM(name)) = LOWER(TRIM($2))")) {
        return { rows: options.existingDealIdByName ? [{ id: options.existingDealIdByName }] : [] };
      }
      if (sql.includes("SELECT id, name, deal_number")) {
        return {
          rows: [
            {
              id: options.existingDealIdBySyncHubBidBoardId ?? options.existingDealIdByProcoreBid ?? options.existingDealIdByName ?? "deal-1",
              name: "Palm Villas",
              deal_number: "DFW-1-11426-aa",
              project_number: null,
              stage_id: "stage-estimating",
              stage_entered_at: currentStageEnteredAt,
              on_hold: false,
              on_hold_started_at: null,
              on_hold_accumulated_seconds: 0,
              on_hold_accumulated_seconds_at_stage_entry: 0,
              workflow_route: workflowRoute,
              is_bid_board_owned: true,
              dd_estimate: "50000",
              bid_estimate: "55000",
              awarded_amount: "0",
              proposal_notes: "Initial draft",
              proposal_status: "drafting",
              estimating_substage: "building_estimate",
              actual_close_date: null,
              lost_reason_id: null,
              lost_notes: null,
              lost_competitor: null,
              lost_at: null,
              ...options.currentDealOverrides,
            },
          ],
        };
      }
      if (
        sql.includes("FROM public.pipeline_stage_config") &&
        sql.includes("WHERE id = $1")
      ) {
        return {
          rows: [
            {
              id: "stage-estimating",
              slug: "estimating",
              display_order: 2,
              workflow_family: workflowRoute === "service" ? "service_deal" : "standard_deal",
            },
          ],
        };
      }
      if (
        sql.includes("FROM public.pipeline_stage_config") &&
        sql.includes("WHERE slug = $1")
      ) {
        const targetSlug = (params?.[0] as string | undefined) ?? options.targetStageSlug ?? "bid_sent";
        const requestedWorkflowFamily =
          (params?.[1] as "standard_deal" | "service_deal" | undefined) ??
          (workflowRoute === "service" ? "service_deal" : "standard_deal");
        const rowWorkflowFamily = options.targetStageWorkflowFamily ?? requestedWorkflowFamily;
        const sharedFallbackSlugs = params?.[2] as readonly string[] | undefined;
        if (
          requestedWorkflowFamily === "service_deal" &&
          targetSlug !== "service_estimating" &&
          !sharedFallbackSlugs?.includes(targetSlug)
        ) {
          return { rows: [] };
        }
        return {
          rows: [
            {
              id: `stage-${targetSlug}`,
              slug: targetSlug,
              name: targetSlug === "opportunity" ? "Opportunity" : targetSlug,
              display_order: 3,
              is_terminal: targetSlug === "won" || targetSlug === "lost",
              workflow_family: rowWorkflowFamily,
              required_fields: [],
              required_documents: [],
              required_approvals: [],
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO office_dallas.deal_stage_history")) {
        return { rows: [] };
      }
      if (sql.includes("FROM office_dallas.deals") && sql.includes("WHERE deal_number LIKE $1")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO public.deal_number_daily_sequences")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT last_suffix") && sql.includes("public.deal_number_daily_sequences")) {
        return { rows: [{ last_suffix: "" }] };
      }
      if (sql.includes("UPDATE public.deal_number_daily_sequences")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO office_dallas.deals")) {
        return {
          rows: [{ id: "new-deal-1", name: "Palm Villas", deal_number: "DFW-1-11426-ab", project_number: null }],
        };
      }
      if (sql.includes("INSERT INTO public.job_queue")) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO "office_dallas".audit_log')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE office_dallas.deals")) {
        return { rows: [] };
      }
      if (sql.includes("app.skip_stage_history_trigger")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    }),
    release: vi.fn(),
  };

  return { client, queries };
}

describe("syncHubRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SYNCHUB_INTEGRATION_SECRET = "test-secret";
    delete process.env.ENABLE_OPPORTUNITY_RFP_EVENT;
  });

  it("mirrors downstream bid board stage data through the route and derives contract review mapping internally", async () => {
    const { client, queries } = createClient({
      existingDealIdByProcoreBid: "deal-1",
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "bb-1",
        procore_bid_id: 101,
        name: "Palm Villas",
        stage_slug: "bid_sent",
        stage_status: "under_review",
        proposal_status: "under_review",
        stage_entered_at: "2026-04-22T14:30:00.000Z",
        mirror_source_entered_at: "2026-04-22T14:25:00.000Z",
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "updated",
      deal_id: "deal-1",
      stage_changed: true,
    });

    const updateQuery = queries.find((entry) => entry.sql.includes("UPDATE office_dallas.deals"));
    expect(updateQuery).toBeTruthy();
    expect(updateQuery?.sql).toContain("on_hold_started_at = $3");
    expect(updateQuery?.sql).toContain("on_hold_accumulated_seconds = $4");
    expect(updateQuery?.sql).toContain("on_hold_accumulated_seconds_at_stage_entry = $5");
    expect(updateQuery?.params).toEqual(
      expect.arrayContaining([
        "proposal",
        "under_review",
        null,
        0,
        0,
        "normal",
      ])
    );
    const auditQuery = queries.find((entry) => entry.sql.includes('INSERT INTO "office_dallas".audit_log'));
    expect(auditQuery?.params).toEqual(expect.arrayContaining([
      "deals",
      "deal-1",
      "update",
      "Procore SyncHub Webhook",
      "Palm Villas",
      "DFW-1-11426-aa",
    ]));
  });

  it("creates a separate same-name project when its SyncHub Bid Board ID is different", async () => {
    const { client, queries } = createClient({
      // If the route ever restores a name-only fallback, this mock will make it update
      // the existing deal and this assertion will fail. The distinct Bid Board ID must
      // instead create a new CRM deal.
      existingDealIdByName: "terraces-existing-deal",
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "562949955888058",
        name: "Terraces at Highbury Court",
        stage_slug: "bid_sent",
        stage_status: "under_review",
        proposal_status: "under_review",
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: "created", deal_id: "new-deal-1" });
    expect(queries.some((entry) => entry.sql.includes("LOWER(TRIM(name))"))).toBe(false);
    const identityQuery = queries.find((entry) => entry.sql.includes("synchub_bid_board_id = $1"));
    expect(identityQuery?.params).toEqual(["562949955888058"]);
    const insertQuery = queries.find((entry) => entry.sql.includes("INSERT INTO office_dallas.deals"));
    expect(insertQuery?.sql).toContain("synchub_bid_board_id");
    expect(insertQuery?.params).toContain("562949955888058");
  });

  it("updates an exact SyncHub Bid Board identity even when no Procore Bid ID is available", async () => {
    const { client, queries } = createClient({
      existingDealIdBySyncHubBidBoardId: "terraces-deal-1",
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "562949955888058",
        name: "Terraces at Highbury Court",
        stage_slug: "bid_sent",
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "updated", deal_id: "terraces-deal-1" });
    const identityQuery = queries.find((entry) => entry.sql.includes("synchub_bid_board_id = $1"));
    expect(identityQuery?.params).toEqual(["562949955888058"]);
  });

  it("rejects conflicting exact identities instead of merging two deals", async () => {
    const { client, queries } = createClient({
      existingDealIdBySyncHubBidBoardId: "terraces-deal-1",
      existingDealIdByProcoreBid: "different-deal-2",
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "562949955888058",
        procore_bid_id: 4181948,
        name: "Terraces at Highbury Court",
        stage_slug: "bid_sent",
      });

    expect(response.status).toBe(409);
    expect(queries.some((entry) => entry.sql.includes("UPDATE office_dallas.deals"))).toBe(false);
    expect(queries.some((entry) => entry.sql.includes("INSERT INTO office_dallas.deals"))).toBe(false);
  });

  it("does not overwrite an established SyncHub identity through a Procore Bid fallback", async () => {
    const { client, queries } = createClient({
      existingDealIdByProcoreBid: "terraces-deal-1",
      existingSyncHubBidBoardIdByProcoreBid: "562949955852986",
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "562949955888058",
        procore_bid_id: 4181948,
        name: "Terraces at Highbury Court",
        stage_slug: "bid_sent",
      });

    expect(response.status).toBe(409);
    expect(queries.some((entry) => entry.sql.includes("UPDATE office_dallas.deals"))).toBe(false);
    expect(queries.some((entry) => entry.sql.includes("INSERT INTO office_dallas.deals"))).toBe(false);
  });

  it("preserves the persisted workflow route on mirrored updates even when payload differs", async () => {
    const { client, queries } = createClient({
      workflowRoute: "normal",
      existingDealIdByProcoreBid: "deal-1",
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "bb-1",
        procore_bid_id: 101,
        name: "Palm Villas",
        stage_slug: "bid_sent",
        workflow_route: "service",
      });

    expect(response.status).toBe(200);
    const updateQuery = queries.find((entry) => entry.sql.includes("UPDATE office_dallas.deals"));
    expect(updateQuery?.sql).toMatch(/workflow_route = \$\d+/);
    expect(updateQuery?.params).toContain("normal");
  });

  it("resets the mirrored stage-entered timestamp when SyncHub omits it for a stage change", async () => {
    const priorStageEnteredAt = new Date("2026-04-20T12:00:00.000Z");
    const { client, queries } = createClient({
      existingDealIdByProcoreBid: "deal-1",
      currentStageEnteredAt: priorStageEnteredAt,
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "bb-1",
        procore_bid_id: 101,
        name: "Palm Villas",
        stage_slug: "bid_sent",
        stage_status: "under_review",
        proposal_status: "under_review",
      });

    expect(response.status).toBe(200);
    const updateQuery = queries.find((entry) => entry.sql.includes("UPDATE office_dallas.deals"));
    const dateParams = (updateQuery?.params ?? []).filter((value): value is Date => value instanceof Date);
    expect(dateParams.length).toBeGreaterThanOrEqual(4);
  });

  it("does not backdate an open hold when SyncHub replays a historical stageEnteredAt", async () => {
    const { client, queries } = createClient({
      existingDealIdByProcoreBid: "deal-1",
      currentDealOverrides: {
        on_hold: true,
        on_hold_started_at: new Date("2026-05-11T09:30:00.000Z"),
        on_hold_accumulated_seconds: 7200,
        on_hold_accumulated_seconds_at_stage_entry: 7200,
      },
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "bb-1",
        procore_bid_id: 101,
        name: "Palm Villas",
        stage_slug: "bid_sent",
        stage_status: "under_review",
        proposal_status: "under_review",
        stage_entered_at: "2026-05-11T08:00:00.000Z",
      });

    expect(response.status).toBe(200);
    const updateQuery = queries.find((entry) => entry.sql.includes("UPDATE office_dallas.deals"));
    expect(updateQuery?.params?.[1]).toEqual(new Date("2026-05-11T08:00:00.000Z"));
    expect(updateQuery?.params?.[2]).toEqual(new Date("2026-05-11T09:30:00.000Z"));
    expect(updateQuery?.params?.[3]).toBe(7200);
    expect(updateQuery?.params?.[4]).toBe(7200);
  });

  it("preserves existing hold accumulators on same-stage SyncHub updates", async () => {
    const { client, queries } = createClient({
      existingDealIdByProcoreBid: "deal-1",
      targetStageSlug: "estimating",
      currentDealOverrides: {
        on_hold: false,
        on_hold_started_at: null,
        on_hold_accumulated_seconds: 7200,
        on_hold_accumulated_seconds_at_stage_entry: 3600,
      },
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "bb-1",
        procore_bid_id: 101,
        name: "Palm Villas",
        stage_slug: "estimating",
        dd_estimate: "61000",
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "updated",
      deal_id: "deal-1",
      stage_changed: false,
    });

    const updateQuery = queries.find((entry) => entry.sql.includes("UPDATE office_dallas.deals"));
    expect(updateQuery).toBeTruthy();
    expect(updateQuery?.sql).not.toContain("on_hold_started_at =");
    expect(updateQuery?.sql).not.toContain("on_hold_accumulated_seconds =");
    expect(updateQuery?.sql).not.toContain("on_hold_accumulated_seconds_at_stage_entry =");
    expect(updateQuery?.params).toContain("61000");
    expect(updateQuery?.params).not.toContain(7200);
    expect(updateQuery?.params).not.toContain(3600);
  });

  it("logs intentional null clears from SyncHub webhook updates", async () => {
    const { client, queries } = createClient({
      existingDealIdByProcoreBid: "deal-1",
      targetStageSlug: "won",
      targetStageWorkflowFamily: "standard_deal",
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "bb-1",
        procore_bid_id: 101,
        name: "Palm Villas",
        stage_slug: "won",
      });

    expect(response.status).toBe(200);
    const auditQuery = queries.find((entry) => entry.sql.includes('INSERT INTO "office_dallas".audit_log'));
    const rawFieldChanges = String(auditQuery?.params?.[11] ?? "");
    const formattedFieldChanges = String(auditQuery?.params?.[12] ?? "");
    expect(rawFieldChanges).toContain('"estimatingSubstage":{"from":"building_estimate","to":null}');
    expect(formattedFieldChanges).toContain('"key":"estimatingSubstage"');
    expect(formattedFieldChanges).toContain('"transition":"cleared"');
  });

  it("skips no-op null clear audit entries when a field was already null", async () => {
    const { client, queries } = createClient({
      existingDealIdByProcoreBid: "deal-1",
      targetStageSlug: "won",
      targetStageWorkflowFamily: "standard_deal",
      currentDealOverrides: {
        proposal_status: null,
        estimating_substage: null,
      },
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "bb-1",
        procore_bid_id: 101,
        name: "Palm Villas",
        stage_slug: "won",
      });

    expect(response.status).toBe(200);
    const auditQuery = queries.find((entry) => entry.sql.includes('INSERT INTO "office_dallas".audit_log'));
    const rawFieldChanges = String(auditQuery?.params?.[11] ?? "");
    expect(rawFieldChanges).not.toContain('"estimatingSubstage"');
    expect(rawFieldChanges).not.toContain('"proposalStatus"');
  });

  it("skips COALESCE-protected null webhook fields that do not change the database", async () => {
    const { client, queries } = createClient({
      existingDealIdByProcoreBid: "deal-1",
      targetStageSlug: "estimate_under_review",
      targetStageWorkflowFamily: "standard_deal",
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "bb-1",
        procore_bid_id: 101,
        name: "Palm Villas",
        stage_slug: "estimate_under_review",
        dd_estimate: null,
      });

    expect(response.status).toBe(200);
    const updateQuery = queries.find((entry) => entry.sql.includes("UPDATE office_dallas.deals"));
    expect(updateQuery?.params).toContain(null);
    const auditQuery = queries.find((entry) => entry.sql.includes('INSERT INTO "office_dallas".audit_log'));
    const rawFieldChanges = String(auditQuery?.params?.[11] ?? "");
    expect(rawFieldChanges).not.toContain('"ddEstimate"');
  });

  it("preserves live proposal_status when the webhook omits it", async () => {
    const { client, queries } = createClient({
      existingDealIdByProcoreBid: "deal-1",
      targetStageSlug: "won",
      targetStageWorkflowFamily: "standard_deal",
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "bb-1",
        procore_bid_id: 101,
        name: "Palm Villas",
        stage_slug: "won",
      });

    expect(response.status).toBe(200);
    const updateQuery = queries.find((entry) => entry.sql.includes("UPDATE office_dallas.deals"));
    expect(updateQuery?.sql).toMatch(/proposal_status = COALESCE\(\$\d+, proposal_status\)/);
    expect(updateQuery?.params).toContain(null);
    const auditQuery = queries.find((entry) => entry.sql.includes('INSERT INTO "office_dallas".audit_log'));
    const rawFieldChanges = String(auditQuery?.params?.[11] ?? "");
    expect(rawFieldChanges).not.toContain('"proposalStatus"');
  });

  it("logs non-null updates for COALESCE-protected webhook fields when the value actually changes", async () => {
    const { client, queries } = createClient({
      existingDealIdByProcoreBid: "deal-1",
      targetStageSlug: "estimate_under_review",
      targetStageWorkflowFamily: "standard_deal",
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "bb-1",
        procore_bid_id: 101,
        name: "Palm Villas",
        stage_slug: "estimate_under_review",
        dd_estimate: "60000",
      });

    expect(response.status).toBe(200);
    const updateQuery = queries.find((entry) => entry.sql.includes("UPDATE office_dallas.deals"));
    expect(updateQuery?.params).toContain("60000");
    const auditQuery = queries.find((entry) => entry.sql.includes('INSERT INTO "office_dallas".audit_log'));
    const rawFieldChanges = String(auditQuery?.params?.[11] ?? "");
    expect(rawFieldChanges).toContain('"ddEstimate":{"from":"50000","to":"60000"}');
  });

  it("rejects payload stage families that conflict with internal derivation", async () => {
    const { client } = createClient({
      existingDealIdByProcoreBid: "deal-1",
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "bb-1",
        procore_bid_id: 101,
        name: "Palm Villas",
        stage_slug: "bid_sent",
        stage_status: "under_review",
        proposal_status: "under_review",
        stage_family: "production",
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        message: "Bid Board mirror stage family mismatch",
      },
    });
  });

  it("does not emit deal.opportunity.entered from Bid Board mirror update paths", async () => {
    process.env.ENABLE_OPPORTUNITY_RFP_EVENT = "true";
    const { client, queries } = createClient({
      existingDealIdByProcoreBid: "deal-1",
      targetStageSlug: "opportunity",
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "bb-1",
        procore_bid_id: 101,
        name: "Palm Villas",
        stage_slug: "opportunity",
      });

    expect(response.status).toBe(200);
    const jobPayloads = queries
      .filter((entry) => entry.sql.includes("INSERT INTO public.job_queue"))
      .map((entry) => JSON.parse(entry.params?.[0] as string) as { eventName?: string });
    expect(jobPayloads).not.toContainEqual(
      expect.objectContaining({ eventName: "deal.opportunity.entered" })
    );
  });

  it("accepts new canonical Bid Board labels by normalizing to canonical slugs before stage lookup", async () => {
    const { client, queries } = createClient({
      existingDealIdByProcoreBid: "deal-1",
      targetStageSlug: "estimate_under_review",
      targetStageWorkflowFamily: "standard_deal",
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "bb-1",
        procore_bid_id: 101,
        name: "Palm Villas",
        stage_slug: "Estimate Under Review",
      });

    expect(response.status).toBe(200);
    const targetStageLookup = queries.find(
      (entry) => entry.sql.includes("FROM public.pipeline_stage_config") &&
        entry.sql.includes("WHERE slug = $1")
    );
    expect(targetStageLookup?.params?.slice(0, 2)).toEqual(["estimate_under_review", "standard_deal"]);
    const updateQuery = queries.find((entry) => entry.sql.includes("UPDATE office_dallas.deals"));
    expect(updateQuery?.sql).toMatch(/bid_board_stage_slug = \$\d+/);
    expect(updateQuery?.sql).toMatch(/bid_board_stage_family = \$\d+/);
    expect(updateQuery?.params).toEqual(
      expect.arrayContaining(["estimate_under_review", "estimating"])
    );
  });

  it("accepts cutover aliases with dash variants by normalizing before stage lookup", async () => {
    const { client, queries } = createClient({
      workflowRoute: "service",
      existingDealIdByProcoreBid: "deal-1",
      targetStageSlug: "service_estimating",
      targetStageWorkflowFamily: "service_deal",
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "bb-1",
        procore_bid_id: 101,
        name: "Palm Villas",
        workflow_route: "service",
        stage_slug: "Service — Estimating",
      });

    expect(response.status).toBe(200);
    const targetStageLookup = queries.find(
      (entry) => entry.sql.includes("FROM public.pipeline_stage_config") &&
        entry.sql.includes("WHERE slug = $1")
    );
    expect(targetStageLookup?.params?.slice(0, 2)).toEqual(["service_estimating", "service_deal"]);
    const updateQuery = queries.find((entry) => entry.sql.includes("UPDATE office_dallas.deals"));
    expect(updateQuery?.params).toEqual(
      expect.arrayContaining(["service_estimating", "estimating"])
    );
  });

  it("uses a service deal's persisted route for shared stage lookup when workflow_route is omitted", async () => {
    const { client, queries } = createClient({
      workflowRoute: "service",
      existingDealIdByProcoreBid: "deal-service-1",
      targetStageSlug: "estimate_sent_to_client",
      targetStageWorkflowFamily: "standard_deal",
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "bb-service-1",
        procore_bid_id: 101,
        name: "Palm Villas",
        stage_slug: "Estimate Sent to Client",
      });

    expect(response.status).toBe(200);
    const targetStageLookup = queries.find(
      (entry) => entry.sql.includes("FROM public.pipeline_stage_config") &&
        entry.sql.includes("WHERE slug = $1")
    );
    expect(targetStageLookup?.params?.slice(0, 2)).toEqual(["estimate_sent_to_client", "service_deal"]);
    const updateQuery = queries.find((entry) => entry.sql.includes("UPDATE office_dallas.deals"));
    expect(updateQuery?.params).toContain("service");
  });

  it("uses standard_deal family for normal deal updates to shared canonical stages", async () => {
    const { client, queries } = createClient({
      workflowRoute: "normal",
      existingDealIdByProcoreBid: "deal-normal-1",
      targetStageSlug: "estimate_under_review",
      targetStageWorkflowFamily: "standard_deal",
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "bb-normal-1",
        procore_bid_id: 102,
        name: "Palm Villas",
        stage_slug: "Estimate Under Review",
      });

    expect(response.status).toBe(200);
    const targetStageLookup = queries.find(
      (entry) => entry.sql.includes("FROM public.pipeline_stage_config") &&
        entry.sql.includes("WHERE slug = $1")
    );
    expect(targetStageLookup?.params?.slice(0, 2)).toEqual(["estimate_under_review", "standard_deal"]);
  });

  it("normalizes bare estimating to service_estimating for service deal updates when workflow_route is omitted", async () => {
    const { client, queries } = createClient({
      workflowRoute: "service",
      existingDealIdByProcoreBid: "deal-service-1",
      targetStageSlug: "service_estimating",
      targetStageWorkflowFamily: "service_deal",
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "bb-service-1",
        procore_bid_id: 103,
        name: "Palm Villas",
        stage_slug: "estimating",
      });

    expect(response.status).toBe(200);
    const targetStageLookup = queries.find(
      (entry) => entry.sql.includes("FROM public.pipeline_stage_config") &&
        entry.sql.includes("WHERE slug = $1")
    );
    expect(targetStageLookup?.params?.slice(0, 2)).toEqual(["service_estimating", "service_deal"]);
    const updateQuery = queries.find((entry) => entry.sql.includes("UPDATE office_dallas.deals"));
    expect(updateQuery?.params).toContain("service_estimating");
  });

  it("resolves service deal updates with opportunity through the shared standard-family fallback", async () => {
    const { client, queries } = createClient({
      workflowRoute: "service",
      existingDealIdByProcoreBid: "deal-service-opp",
      targetStageSlug: "opportunity",
      targetStageWorkflowFamily: "standard_deal",
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "bb-service-opp",
        procore_bid_id: 104,
        name: "Palm Villas",
        stage_slug: "opportunity",
      });

    expect(response.status).toBe(200);
    const targetStageLookup = queries.find(
      (entry) => entry.sql.includes("FROM public.pipeline_stage_config") &&
        entry.sql.includes("WHERE slug = $1")
    );
    expect(targetStageLookup?.params?.[0]).toBe("opportunity");
    expect(targetStageLookup?.params?.[1]).toBe("service_deal");
    expect(targetStageLookup?.params?.[2]).toContain("opportunity");
  });

  it("normalizes dd to opportunity for service deal updates and uses the shared fallback", async () => {
    const { client, queries } = createClient({
      workflowRoute: "service",
      existingDealIdByProcoreBid: "deal-service-dd",
      targetStageSlug: "opportunity",
      targetStageWorkflowFamily: "standard_deal",
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "bb-service-dd",
        procore_bid_id: 105,
        name: "Palm Villas",
        stage_slug: "dd",
      });

    expect(response.status).toBe(200);
    const targetStageLookup = queries.find(
      (entry) => entry.sql.includes("FROM public.pipeline_stage_config") &&
        entry.sql.includes("WHERE slug = $1")
    );
    expect(targetStageLookup?.params?.[0]).toBe("opportunity");
    expect(targetStageLookup?.params?.[1]).toBe("service_deal");
    expect(targetStageLookup?.params?.[2]).toContain("opportunity");
  });

  it("preserves normal deal opportunity lookup as standard_deal", async () => {
    const { client, queries } = createClient({
      workflowRoute: "normal",
      existingDealIdByProcoreBid: "deal-normal-opp",
      targetStageSlug: "opportunity",
      targetStageWorkflowFamily: "standard_deal",
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "bb-normal-opp",
        procore_bid_id: 106,
        name: "Palm Villas",
        stage_slug: "opportunity",
      });

    expect(response.status).toBe(200);
    const targetStageLookup = queries.find(
      (entry) => entry.sql.includes("FROM public.pipeline_stage_config") &&
        entry.sql.includes("WHERE slug = $1")
    );
    expect(targetStageLookup?.params?.slice(0, 2)).toEqual(["opportunity", "standard_deal"]);
  });
});
