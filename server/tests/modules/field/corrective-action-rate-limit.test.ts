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

// Finding #5: the PUBLIC corrective-action token routes (reachable with only a ?token) are mounted under
// /api/field, which has NO apiLimiter, and their authorize step fans the arbitrary scorecard UUID across every
// active office schema (resolveWriteOffice). An unauthenticated flood carrying any nonempty token is a
// cross-office-scan DoS amplifier. The routes now carry an IP-keyed public limiter, applied BEFORE the
// authorize/scan, that skips the (no-token) session path. This file proves: (a) a valid token request still
// succeeds, and (b) a burst of token requests from one IP is eventually capped (429). We spy on
// resolveWriteOffice to prove the scan is NOT reached once the limiter fires.

const DEAL = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const OFFICE = { id: "office-1", slug: "test" };

let pg: PGlite;
let tdb: any;

// A spy so we can assert the cross-office scan (resolveWriteOffice) is skipped once the limiter 429s.
const resolveWriteOfficeSpy = vi.fn(async () => OFFICE);

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
  resolveWriteOffice: (...args: any[]) => resolveWriteOfficeSpy(...(args as [])),
  runInOffice: vi.fn(async (_office: any, run: any) => run(tdb, OFFICE)),
  runInOfficeTransaction: vi.fn(async (_office: any, _userId: any, run: any) => run(tdb, OFFICE)),
}));

vi.mock("../../../src/modules/files/service.js", () => ({
  getFileDownloadUrl: vi.fn(async (_db: any, fileId: string) => ({ url: `https://r2.example/${fileId}` })),
}));

const { registerCorrectiveActionRoutes } = await import(
  "../../../src/modules/field/corrective-action-routes.js"
);
const { mintCorrectiveActionToken } = await import(
  "../../../src/modules/field/corrective-action-tokens.js"
);

function makeApp() {
  const app = express();
  // Trust proxy so req.ip is stable in the test harness (the limiter keys on it).
  app.set("trust proxy", true);
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
  resolveWriteOfficeSpy.mockClear();
  await tdb.execute(sql`DELETE FROM scorecard_corrective_action_tokens`);
  await tdb.execute(sql`DELETE FROM scorecard_corrective_actions`);
  await tdb.execute(sql`DELETE FROM field_scorecards`);
  await tdb.execute(sql`DELETE FROM deal_team_members`);
  await tdb.execute(sql`
    INSERT INTO deal_team_members (deal_id, user_id, role, is_active)
    VALUES (${DEAL}, ${USER}, 'superintendent', true)
  `);
  await tdb.execute(sql`
    INSERT INTO deal_team_members (deal_id, user_id, contact_id, member_name, member_email, role, is_active)
    VALUES (${DEAL}, NULL, NULL, 'Pat Manager', 'pm@example.com', 'project_manager', true)
  `);
  scorecardId = "22222222-2222-2222-2222-222222222222";
  await tdb.execute(sql`
    INSERT INTO field_scorecards (id, client_submission_id, deal_id, week_of, form_version, kind, total_score, rating, status, submitted_by)
    VALUES (${scorecardId}, '55555555-5555-5555-5555-000000000001', ${DEAL}, '2026-06-30', 1, 'project', 60, 'corrective_action', 'corrective_action_open', ${USER})
  `);
  await tdb.execute(sql`
    INSERT INTO scorecard_corrective_actions (scorecard_id, item_type, item_ref, item_label, status)
    VALUES (${scorecardId}, 'action_item', '0', 'Re-inspect slab 2', 'open')
  `);
});

async function mintToken() {
  const { rawToken } = await mintCorrectiveActionToken(tdb, {
    scorecardId,
    recipientEmail: "pm@example.com",
    role: "project_manager",
    ttlDays: 30,
  });
  return rawToken;
}

describe("public corrective-action route rate limiting (finding 5)", () => {
  it("a single valid token request still succeeds (limiter does not block normal use)", async () => {
    const rawToken = await mintToken();
    const res = await request(app).get(
      `/scorecards/${scorecardId}/corrective-actions?token=${encodeURIComponent(rawToken)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  it("a FULL 50-photo response-sized burst from ONE legit token is NOT 429'd (finding 3)", async () => {
    // A maximum supported response = 50 photos → 1 GET items + 50 presign + 50 confirm + 1 POST response = 102
    // requests within a minute. The cap (110) is above that, and the bucket is keyed by IP+token, so a single
    // legit responder working through a full max-size response must never be throttled. We approximate the burst
    // with 102 GETs on THIS token's key (the limiter counts every route hit identically); none may 429.
    const rawToken = await mintToken();
    const path = `/scorecards/${scorecardId}/corrective-actions?token=${encodeURIComponent(rawToken)}`;
    for (let i = 0; i < 102; i++) {
      const res = await request(app).get(path);
      expect(res.status).not.toBe(429); // a full legitimate response never trips the limiter
    }
  });

  it("a distinct legit token behind the SAME IP has its OWN bucket (not throttled by another responder's burst)", async () => {
    // Keyed by IP+token: two responders behind one shared office IP each get a separate allowance. The burst
    // above exhausted MOST of one token's budget; a request on a BRAND-NEW token (same IP) still authorizes.
    const otherToken = await mintToken();
    const res = await request(app).get(
      `/scorecards/${scorecardId}/corrective-actions?token=${encodeURIComponent(otherToken)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  it("an ABUSIVE over-cap flood on one bucket is eventually capped (429) BEFORE the cross-office scan", async () => {
    const rawToken = await mintToken();
    const path = `/scorecards/${scorecardId}/corrective-actions?token=${encodeURIComponent(rawToken)}`;
    // Fire well past the 110/min cap on a SINGLE bucket (same IP+token). We only assert that SOME request 429s
    // within the flood and that the 429 short-circuited BEFORE resolveWriteOffice ran (the amplifier is capped).
    let saw429 = false;
    let scanCallsAt429 = -1;
    for (let i = 0; i < 160; i++) {
      resolveWriteOfficeSpy.mockClear();
      const res = await request(app).get(path);
      if (res.status === 429) {
        saw429 = true;
        scanCallsAt429 = resolveWriteOfficeSpy.mock.calls.length;
        break;
      }
    }
    expect(saw429).toBe(true);
    // The 429 fired from the limiter middleware, ahead of authorizeCorrectiveAction → resolveWriteOffice.
    expect(scanCallsAt429).toBe(0);
  });

  it("does NOT rate-limit the (no-token) session path — it is skipped by the limiter", async () => {
    // The session path carries no ?token, so the limiter's skip() bypasses it entirely; even after the flood
    // above exhausted a token bucket for this IP, a session request still authorizes normally.
    const res = await request(app).get(`/scorecards/${scorecardId}/corrective-actions`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });
});
