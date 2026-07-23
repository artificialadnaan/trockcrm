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

// Finding #5 / round-11 A: the PUBLIC corrective-action token routes (reachable with only a ?token) are mounted
// under /api/field, which has NO apiLimiter, and their authorize step fans the arbitrary scorecard UUID across
// every active office schema (resolveWriteOffice). A forged ?token only has to pass the 43-char base64url SHAPE
// gate to reach that scan (verification runs AFTER), so an attacker ROTATING the token is a cross-office-scan
// DoS amplifier. The public limiter is keyed by IP ONLY (a shared per-IP ceiling token rotation cannot escape)
// and caps EVERY request to these routes (tokenless included). This file proves: (a) a single valid token
// request still succeeds; (b) one legit full 50-photo response burst is NOT capped; (c) a token-ROTATION flood
// from one IP IS capped (429) — rotation no longer multiplies the budget; and (d) the 429 short-circuits BEFORE
// resolveWriteOffice. We spy on resolveWriteOffice to prove the scan is NOT reached once the limiter fires.

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
// The public limiter is a module-level singleton with an in-memory store keyed by IP ONLY (finding A), so its
// count now accumulates across tests in this file (they share one test-harness IP). Reset the limiter's known
// IP keys before each test so per-test budgets are isolated. `resetKey` is a no-op for keys that don't exist.
const { correctiveActionPublicLimiter } = await import("../../../src/middleware/rate-limit.js");
const LIMITER_IP_KEYS = ["::ffff:127.0.0.1", "127.0.0.1", "::1", "::ffff:7f00:1", "unknown"];
function resetLimiter() {
  for (const key of LIMITER_IP_KEYS) {
    (correctiveActionPublicLimiter as unknown as { resetKey?: (k: string) => void }).resetKey?.(key);
  }
}

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
  resetLimiter();
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
    // requests within a minute. The cap (220) is well above that, so a single legit responder working through a
    // full max-size response must never be throttled. We approximate the burst with 102 GETs on this IP (the
    // limiter counts every route hit identically); none may 429.
    const rawToken = await mintToken();
    const path = `/scorecards/${scorecardId}/corrective-actions?token=${encodeURIComponent(rawToken)}`;
    for (let i = 0; i < 102; i++) {
      const res = await request(app).get(path);
      expect(res.status).not.toBe(429); // a full legitimate response never trips the limiter
    }
  });

  it("a TOKEN-ROTATION flood from one IP is CAPPED (rotation cannot multiply the budget) — finding A", async () => {
    // The whole point of round-11 finding A: an attacker who VARIES ?token on every request must NOT get a fresh
    // bucket per token. With IP-only keying every rotated token shares ONE per-IP ceiling. Each request carries a
    // DISTINCT freshly-minted token (all valid-shape), yet the flood is still eventually 429'd — proving rotation
    // no longer resets the budget. Under the OLD IP+token key this loop would never 429 (each token = new bucket).
    let saw429 = false;
    let scanCallsAt429 = -1;
    for (let i = 0; i < 260; i++) {
      const rotatedToken = await mintToken(); // a brand-new, valid-shape token every iteration
      resolveWriteOfficeSpy.mockClear();
      const res = await request(app).get(
        `/scorecards/${scorecardId}/corrective-actions?token=${encodeURIComponent(rotatedToken)}`,
      );
      if (res.status === 429) {
        saw429 = true;
        scanCallsAt429 = resolveWriteOfficeSpy.mock.calls.length;
        break;
      }
    }
    expect(saw429).toBe(true);
    // The 429 fired from the limiter middleware, ahead of authorizeCorrectiveAction → resolveWriteOffice: the
    // cross-office scan is short-circuited even though every request carried a distinct, valid-shape token.
    expect(scanCallsAt429).toBe(0);
  });

  it("an ABUSIVE over-cap flood on one bucket is eventually capped (429) BEFORE the cross-office scan", async () => {
    const rawToken = await mintToken();
    const path = `/scorecards/${scorecardId}/corrective-actions?token=${encodeURIComponent(rawToken)}`;
    // Fire well past the 220/min per-IP cap. We only assert that SOME request 429s within the flood and that the
    // 429 short-circuited BEFORE resolveWriteOffice ran (the amplifier is capped).
    let saw429 = false;
    let scanCallsAt429 = -1;
    for (let i = 0; i < 300; i++) {
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

  it("also caps the TOKENLESS path (the old skip is removed) but leaves normal single use working — finding A", async () => {
    // The tokenless request still reaches these public routes, so it must be counted too (no skip). On a FRESH
    // IP bucket a single tokenless GET authorizes normally; only a flood on that IP would 429. We assert normal
    // single use works and that the limiter attaches its standard headers (proving it ran, not skipped).
    const res = await request(app).get(`/scorecards/${scorecardId}/corrective-actions`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    // The limiter ran on this tokenless request (standardHeaders => RateLimit-* present) rather than skipping it.
    expect(res.headers["ratelimit-limit"] ?? res.headers["ratelimit"]).toBeDefined();
  });
});
