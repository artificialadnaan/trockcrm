import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import {
  fieldScorecards,
  fieldScorecardItems,
  fieldScorecardPhotos,
  scorecardCorrectiveActions,
  scorecardCorrectiveActionTokens,
  dealTeamMembers,
  contacts,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const DEAL = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const STAGE_ACTIVE = "cccccccc-0000-0000-0000-000000000001";
const OFFICE = { id: "office-1", slug: "test" };

// Toggle whether the session field user can browse the deal (assertActiveFieldProject throws when false).
let sessionAuthorized = true;

// A single fake office backed by PGlite. resolveWriteOffice returns it; runInOffice/runInOfficeTransaction
// run the callback against the shared PGlite drizzle db.
let pg: PGlite;
let tdb: any;

vi.mock("../../../src/middleware/field-auth.js", () => ({
  requireFieldContractor: (req: any, _res: any, next: (err?: unknown) => void) => {
    req.fieldUser = {
      id: USER,
      email: "sam.super@trock.com",
      firstName: "Sam",
      lastName: "Super",
      role: "field_contractor",
      tenantId: OFFICE.id,
      active: true,
    };
    next();
  },
}));

vi.mock("../../../src/modules/field/cross-office.js", () => ({
  resolveWriteOffice: vi.fn(async () => OFFICE),
  runInOffice: vi.fn(async (_office: any, run: any) => run(tdb, OFFICE)),
  runInOfficeTransaction: vi.fn(async (_office: any, _userId: any, run: any) => run(tdb, OFFICE)),
}));

vi.mock("../../../src/modules/field/projects-service.js", () => ({
  assertActiveFieldProject: vi.fn(async () => {
    if (!sessionAuthorized) {
      const { AppError } = await import("../../../src/middleware/error-handler.js");
      throw new AppError(403, "Not authorized for this project");
    }
    return { id: DEAL };
  }),
}));

// Import AFTER the mocks so the routes bind to the mocked cross-office/projects.
const { registerCorrectiveActionRoutes } = await import(
  "../../../src/modules/field/corrective-action-routes.js"
);
const { mintCorrectiveActionToken } = await import(
  "../../../src/modules/field/corrective-action-tokens.js"
);

function makeApp() {
  const app = express();
  app.use(express.json());
  registerCorrectiveActionRoutes(app as any);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message ?? "error" });
  });
  return app;
}

let app: express.Express;
let scorecardId: string;
let itemIds: string[];

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE deals (id uuid PRIMARY KEY, name text, is_active boolean DEFAULT true);
    CREATE TABLE files (
      id uuid PRIMARY KEY, deal_id uuid, client_upload_id text, uploaded_by uuid,
      description text, is_active boolean DEFAULT true, deleted_at timestamptz, created_at timestamptz DEFAULT now()
    );
    CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text, email text, avatar_url text, is_active boolean DEFAULT true);
  `);
  await pg.exec(
    tenantSchemaSql("public", [
      fieldScorecards,
      fieldScorecardItems,
      fieldScorecardPhotos,
      scorecardCorrectiveActions,
      scorecardCorrectiveActionTokens,
      dealTeamMembers,
      contacts,
    ]),
  );
  await pg.exec(`INSERT INTO deals (id, name, is_active) VALUES ('${DEAL}', 'Maple St', true);`);
  tdb = drizzle(pg);
  app = makeApp();
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  sessionAuthorized = true;
  await tdb.execute(sql`DELETE FROM scorecard_corrective_action_tokens`);
  await tdb.execute(sql`DELETE FROM scorecard_corrective_actions`);
  await tdb.execute(sql`DELETE FROM field_scorecards`);

  // Seed a below-band scorecard with two open corrective-action items.
  scorecardId = "22222222-2222-2222-2222-222222222222";
  await tdb.execute(sql`
    INSERT INTO field_scorecards (id, client_submission_id, deal_id, week_of, form_version, kind, total_score, rating, status, submitted_by)
    VALUES (${scorecardId}, '55555555-5555-5555-5555-000000000001', ${DEAL}, '2026-06-30', 1, 'project', 60, 'corrective_action', 'corrective_action_open', ${USER})
  `);
  const inserted = await tdb.execute(sql`
    INSERT INTO scorecard_corrective_actions (scorecard_id, item_type, item_ref, item_label, status)
    VALUES
      (${scorecardId}, 'action_item', '0', 'Re-inspect slab 2', 'open'),
      (${scorecardId}, 'action_item', '1', 'Verify hold points', 'open')
    RETURNING id
  `);
  itemIds = (inserted.rows as { id: string }[]).map((r) => r.id);
});

describe("GET /scorecards/:id/corrective-actions", () => {
  it("returns items for a session user authorized to the deal", async () => {
    const res = await request(app).get(`/scorecards/${scorecardId}/corrective-actions`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
  });

  it("returns items for an email-only recipient via ?token (no session)", async () => {
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId,
      recipientEmail: "pm@example.com",
      role: "project_manager",
      ttlDays: 30,
    });
    const res = await request(app).get(
      `/scorecards/${scorecardId}/corrective-actions?token=${encodeURIComponent(rawToken)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
  });

  it("401s an invalid token", async () => {
    const res = await request(app).get(
      `/scorecards/${scorecardId}/corrective-actions?token=not-a-real-token`,
    );
    expect(res.status).toBe(401);
  });

  it("403s a session user not authorized to the deal", async () => {
    sessionAuthorized = false;
    const res = await request(app).get(`/scorecards/${scorecardId}/corrective-actions`);
    expect(res.status).toBe(403);
  });
});

describe("POST /scorecards/:id/corrective-actions/:itemId", () => {
  it("resolves an item as a session user and closes the scorecard on the last item", async () => {
    const first = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/${itemIds[0]}`)
      .send({ comment: "fixed one" });
    expect(first.status).toBe(200);
    let status = await tdb.execute(sql`SELECT status FROM field_scorecards WHERE id = ${scorecardId}`);
    expect(status.rows[0].status).toBe("corrective_action_open");

    const second = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/${itemIds[1]}`)
      .send({ comment: "fixed two" });
    expect(second.status).toBe(200);
    status = await tdb.execute(sql`SELECT status FROM field_scorecards WHERE id = ${scorecardId}`);
    expect(status.rows[0].status).toBe("corrective_action_closed");

    // The session responder is stamped by user id.
    const item = await tdb.execute(
      sql`SELECT responded_by_user_id, responder_email FROM scorecard_corrective_actions WHERE id = ${itemIds[0]}`,
    );
    expect(item.rows[0].responded_by_user_id).toBe(USER);
  });

  it("resolves an item via a token, stamping the recipient email (no user id)", async () => {
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId,
      recipientEmail: "pm@example.com",
      role: "project_manager",
      ttlDays: 30,
    });
    const res = await request(app)
      .post(
        `/scorecards/${scorecardId}/corrective-actions/${itemIds[0]}?token=${encodeURIComponent(rawToken)}`,
      )
      .send({ comment: "fixed by external pm" });
    expect(res.status).toBe(200);
    const item = await tdb.execute(
      sql`SELECT responded_by_user_id, responder_email FROM scorecard_corrective_actions WHERE id = ${itemIds[0]}`,
    );
    expect(item.rows[0].responded_by_user_id).toBeNull();
    expect(item.rows[0].responder_email).toBe("pm@example.com");
  });

  it("403s a token minted for a DIFFERENT scorecard (no cross-scorecard access)", async () => {
    // Mint a token bound to another scorecard id, then try to use it on THIS scorecard's route.
    const otherScorecard = "99999999-9999-9999-9999-999999999999";
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId: otherScorecard,
      recipientEmail: "pm@example.com",
      role: "project_manager",
      ttlDays: 30,
    });
    const res = await request(app)
      .post(
        `/scorecards/${scorecardId}/corrective-actions/${itemIds[0]}?token=${encodeURIComponent(rawToken)}`,
      )
      .send({ comment: "should be blocked" });
    expect(res.status).toBe(403);
  });
});
