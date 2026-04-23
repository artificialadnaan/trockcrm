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
  existingDealIdByProcoreBid?: string | null;
  existingDealIdByName?: string | null;
  currentStageEnteredAt?: Date;
  requestStageFamily?: string | null;
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
      if (sql.includes("SELECT id FROM office_dallas.deals WHERE procore_bid_id")) {
        return { rows: options.existingDealIdByProcoreBid ? [{ id: options.existingDealIdByProcoreBid }] : [] };
      }
      if (sql.includes("LOWER(TRIM(name)) = LOWER(TRIM($2))")) {
        return { rows: options.existingDealIdByName ? [{ id: options.existingDealIdByName }] : [] };
      }
      if (sql.includes("SELECT id, stage_id, stage_entered_at")) {
        return {
          rows: [
            {
              id: options.existingDealIdByProcoreBid ?? options.existingDealIdByName ?? "deal-1",
              stage_id: "stage-estimating",
              stage_entered_at: currentStageEnteredAt,
              workflow_route: workflowRoute,
              is_bid_board_owned: true,
              proposal_status: "drafting",
              estimating_substage: "building_estimate",
              actual_close_date: null,
              lost_reason_id: null,
              lost_notes: null,
              lost_competitor: null,
              lost_at: null,
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
        sql.includes("WHERE slug = $1 AND workflow_family = $2")
      ) {
        return {
          rows: [
            {
              id: "stage-bid-sent",
              slug: "bid_sent",
              name: "Bid Sent",
              display_order: 3,
              is_terminal: false,
              workflow_family: workflowRoute === "service" ? "service_deal" : "standard_deal",
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
      if (sql.includes("INSERT INTO public.job_queue")) {
        return { rows: [] };
      }
      if (sql.includes("UPDATE office_dallas.deals")) {
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
    expect(updateQuery?.params?.[3]).toBe("contract_review");
    expect(updateQuery?.params?.[4]).toBe("under_review");
    expect(updateQuery?.params?.[14]).toBeNull();
    expect(updateQuery?.params?.[15]).toBe("under_review");
  });

  it("scopes fallback dedupe by workflow route so service and normal deals with the same name do not collide", async () => {
    const { client, queries } = createClient({
      workflowRoute: "service",
      existingDealIdByProcoreBid: null,
      existingDealIdByName: "deal-service-1",
    });
    dbMocks.connect.mockResolvedValue(client);

    const app = createApp();
    const response = await request(app)
      .post("/api/integrations/synchub/opportunities")
      .set("x-synchub-secret", "test-secret")
      .send({
        office_slug: "dallas",
        bid_board_id: "bb-service-1",
        name: "Palm Villas",
        stage_slug: "bid_sent",
        stage_status: "under_review",
        proposal_status: "under_review",
        workflow_route: "service",
      });

    expect(response.status).toBe(200);
    const dedupeQuery = queries.find((entry) => entry.sql.includes("LOWER(TRIM(name)) = LOWER(TRIM($2))"));
    expect(dedupeQuery?.sql).toContain("workflow_route = $3");
    expect(dedupeQuery?.params).toEqual(["bid_board", "Palm Villas", "service"]);
  });

  it("reconciles workflow route on mirrored updates so service and normal paths stay isolated", async () => {
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
    expect(updateQuery?.sql).toContain("workflow_route = $26");
    expect(updateQuery?.params?.[25]).toBe("service");
  });

  it("preserves the prior mirrored stage-entered timestamp when SyncHub omits it", async () => {
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
    expect(updateQuery?.params?.[1]).toEqual(priorStageEnteredAt);
    expect(updateQuery?.params?.[5]).toEqual(priorStageEnteredAt);
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
});
