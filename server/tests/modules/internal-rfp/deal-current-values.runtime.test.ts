import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const holder = vi.hoisted(() => ({ pg: null as any, queries: [] as string[] }));

async function pgQuery(text: string, params?: any[]) {
  holder.queries.push(text);
  const r = await holder.pg.query(text, params ?? []);
  return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
}

vi.mock("../../../src/db.js", () => ({
  pool: {
    query: (text: string, params?: any[]) => pgQuery(text, params),
    connect: async () => ({ query: (t: string, p?: any[]) => pgQuery(t, p), release: () => {} }),
  },
  releasePooledClient: () => {},
  isBrokenConnectionError: () => false,
}));
vi.mock("../../../src/modules/audit/pg-activity-logger.js", () => ({ logActivityWithPgClient: vi.fn(async () => {}) }));
vi.mock("../../../src/modules/audit/audit-logger.js", () => ({ buildAuditActorFromSystem: () => ({}) }));
vi.mock("../../../src/modules/audit/system-processes.js", () => ({ INTERNAL_RFP_RECEIVER: "internal_rfp_receiver" }));

const SECRET = "shared-secret";

/** The discriminating deal: nothing awarded, but an estimator wrote a bid estimate AFTER the RFP went out. */
const BID_ONLY = "00000000-0000-0000-0000-0000000000b1";
/** All four value columns populated — proves the precedence, not just "some number came back". */
const ALL_FOUR = "00000000-0000-0000-0000-0000000000b2";
/** Exists, genuinely worth nothing yet. Must come back as an explicit null, not be omitted. */
const NO_VALUE = "00000000-0000-0000-0000-0000000000b3";
/** Soft-deleted. Must be omitted entirely. */
const INACTIVE = "00000000-0000-0000-0000-0000000000b4";
/** dd_estimate only. */
const DD_ONLY = "00000000-0000-0000-0000-0000000000b5";
/** forecast_revenue only — the last rung of the ladder. */
const FORECAST_ONLY = "00000000-0000-0000-0000-0000000000b6";
/** Never inserted. */
const UNKNOWN = "00000000-0000-0000-0000-0000000000bf";

function sign(body: string, secret = SECRET) {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * A second tenant schema so the early-stop can actually be observed. With one schema every
 * implementation looks identical — the loop ends because it ran out of schemas, not because it
 * pruned correctly. The name must sort AFTER office_test (listTenantSchemas orders nspname ASC),
 * or it would be searched before the deal is found and prove nothing.
 */
async function seedSecondSchema() {
  await holder.pg.exec(`
    CREATE SCHEMA office_zzz;
    CREATE TABLE office_zzz.deals (
      id uuid PRIMARY KEY,
      name text,
      awarded_amount numeric(14,2),
      bid_estimate numeric(14,2),
      dd_estimate numeric(14,2),
      forecast_revenue numeric(14,2),
      is_active boolean NOT NULL DEFAULT true
    );
  `);
}

async function seed() {
  const db = new PGlite();
  holder.pg = db;
  await db.exec(`
    CREATE SCHEMA office_test;
    CREATE TABLE office_test.deals (
      id uuid PRIMARY KEY,
      name text,
      awarded_amount numeric(14,2),
      bid_estimate numeric(14,2),
      dd_estimate numeric(14,2),
      forecast_revenue numeric(14,2),
      is_active boolean NOT NULL DEFAULT true
    );
  `);
  await db.exec(`
    INSERT INTO office_test.deals (id, name, awarded_amount, bid_estimate, dd_estimate, forecast_revenue, is_active) VALUES
      ('${BID_ONLY}',      'Bristol Creek Apartments', NULL,      248500.00, NULL,      NULL,      true),
      ('${ALL_FOUR}',      'Standard River District',  925000.00, 800000.00, 700000.00, 600000.00, true),
      ('${NO_VALUE}',      'The Positano',             NULL,      NULL,      NULL,      NULL,      true),
      ('${INACTIVE}',      'Deleted Deal',             NULL,      111000.00, NULL,      NULL,      false),
      ('${DD_ONLY}',       'DD Only',                  NULL,      NULL,      333000.00, NULL,      true),
      ('${FORECAST_ONLY}', 'Forecast Only',            NULL,      NULL,      NULL,      44000.00,  true);
  `);
  return db;
}

async function buildApp() {
  const { internalRfpRoutes } = await import("../../../src/modules/internal-rfp/routes.js");
  const app = express();
  app.use("/api/internal", internalRfpRoutes);
  return app;
}

async function post(app: express.Express, body: unknown, secret = SECRET) {
  const raw = JSON.stringify(body);
  return request(app)
    .post("/api/internal/deals/current-values")
    .set("content-type", "application/json")
    .set("x-rfp-request-signature", sign(raw, secret))
    .send(raw);
}

function amountFor(body: any, dealId: string) {
  const hit = (body.values as Array<{ dealId: string; amount: number | null }>).find((v) => v.dealId === dealId);
  return hit ? hit.amount : undefined;
}

describe("POST /api/internal/deals/current-values", () => {
  beforeEach(() => {
    holder.queries = [];
    process.env.SYNCHUB_SHARED_SECRET = SECRET;
  });
  afterEach(async () => {
    await holder.pg?.close();
    holder.pg = null;
    vi.restoreAllMocks();
  });

  it("returns the CURRENT value for a deal whose RFP snapshot was blank at send time", async () => {
    await seed();
    const app = await buildApp();

    // Exactly the production shape: the RFP was sent with amount '' because the estimate
    // did not exist yet. Hours later bid_estimate was written. The report must be able to see it.
    const res = await post(app, { dealIds: [BID_ONLY] });

    expect(res.status).toBe(200);
    expect(amountFor(res.body, BID_ONLY)).toBe(248500);
  });

  it("uses the same precedence as the RFP payload: awarded > bid > dd > forecast", async () => {
    await seed();
    const app = await buildApp();

    const res = await post(app, { dealIds: [ALL_FOUR, BID_ONLY, DD_ONLY, FORECAST_ONLY] });

    expect(res.status).toBe(200);
    expect(amountFor(res.body, ALL_FOUR)).toBe(925000);
    expect(amountFor(res.body, BID_ONLY)).toBe(248500);
    expect(amountFor(res.body, DD_ONLY)).toBe(333000);
    expect(amountFor(res.body, FORECAST_ONLY)).toBe(44000);
  });

  it("distinguishes 'exists but worth nothing yet' (null) from 'no such deal' (absent)", async () => {
    await seed();
    const app = await buildApp();

    const res = await post(app, { dealIds: [NO_VALUE, UNKNOWN, INACTIVE] });

    expect(res.status).toBe(200);
    expect(amountFor(res.body, NO_VALUE)).toBeNull();
    expect(amountFor(res.body, UNKNOWN)).toBeUndefined();
    // Soft-deleted deals are not readable through this endpoint.
    expect(amountFor(res.body, INACTIVE)).toBeUndefined();
  });

  it("resolves the whole batch in ONE deals query, not one per id", async () => {
    await seed();
    const app = await buildApp();

    const res = await post(app, { dealIds: [BID_ONLY, ALL_FOUR, NO_VALUE, DD_ONLY, FORECAST_ONLY] });

    expect(res.status).toBe(200);
    expect(res.body.values).toHaveLength(5);
    const dealQueries = holder.queries.filter((q) => q.includes("office_test") && q.includes("FROM"));
    expect(dealQueries).toHaveLength(1);
  });

  it("drops non-UUID ids instead of letting one poison the whole batch", async () => {
    await seed();
    const app = await buildApp();

    // A HubSpot-sourced RFP carries a numeric deal id; `= ANY($1::uuid[])` would 22P02 on it.
    const res = await post(app, { dealIds: ["24680135791", "", null, BID_ONLY] });

    expect(res.status).toBe(200);
    expect(amountFor(res.body, BID_ONLY)).toBe(248500);
    expect(res.body.values).toHaveLength(1);
  });

  it("answers an upper-case uuid with the canonical lower-case key", async () => {
    await seed();
    const app = await buildApp();

    const res = await post(app, { dealIds: [BID_ONLY.toUpperCase()] });

    expect(res.status).toBe(200);
    // Postgres renders `uuid` lower-case; echoing the caller's casing back would produce a key
    // that does not match the row it describes.
    expect(res.body.values).toEqual([{ dealId: BID_ONLY, amount: 248500 }]);
  });

  it("stops searching once an upper-case uuid has been found, instead of sweeping every schema", async () => {
    await seed();
    await seedSecondSchema();
    const app = await buildApp();
    holder.queries = [];

    const res = await post(app, { dealIds: [BID_ONLY.toUpperCase()] });

    expect(res.status).toBe(200);
    expect(res.body.values).toEqual([{ dealId: BID_ONLY, amount: 248500 }]);
    // The deal lives in office_test, which is searched first. The pruning compares request ids
    // against `row.id`, which comes back lower-cased — so an un-normalized upper-case id never
    // matches its own result, is never pruned, and office_zzz gets swept for an already-found deal.
    const secondSchemaQueries = holder.queries.filter((q) => q.includes("office_zzz"));
    expect(secondSchemaQueries).toHaveLength(0);
  });

  it("treats two spellings of the same uuid as one id", async () => {
    await seed();
    const app = await buildApp();

    const res = await post(app, { dealIds: [BID_ONLY, BID_ONLY.toUpperCase()] });

    expect(res.status).toBe(200);
    expect(res.body.values).toEqual([{ dealId: BID_ONLY, amount: 248500 }]);
  });

  it("rejects a batch over the documented cap", async () => {
    await seed();
    const app = await buildApp();

    const tooMany = Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const res = await post(app, { dealIds: tooMany });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: "too_many_deal_ids", maxDealIds: 500 });
  });

  it("rejects an unsigned or wrongly-signed request", async () => {
    await seed();
    const app = await buildApp();

    const wrong = await post(app, { dealIds: [BID_ONLY] }, "not-the-secret");
    expect(wrong.status).toBe(401);
    expect(wrong.body).toMatchObject({ error: "invalid_signature" });

    const unsigned = await request(app)
      .post("/api/internal/deals/current-values")
      .set("content-type", "application/json")
      .send(JSON.stringify({ dealIds: [BID_ONLY] }));
    expect(unsigned.status).toBe(401);
  });

  it("rejects a payload with no dealIds array", async () => {
    await seed();
    const app = await buildApp();

    const res = await post(app, { deals: [BID_ONLY] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: "invalid_payload" });
  });

  it("never writes — the deal rows are untouched by a lookup", async () => {
    await seed();
    const app = await buildApp();

    await post(app, { dealIds: [BID_ONLY, ALL_FOUR, NO_VALUE] });

    const rows = (
      await holder.pg.query(
        `SELECT id, awarded_amount, bid_estimate FROM office_test.deals ORDER BY id`
      )
    ).rows as any[];
    expect(rows).toHaveLength(6);
    expect(Number(rows.find((r) => r.id === BID_ONLY).bid_estimate)).toBe(248500);
    expect(rows.find((r) => r.id === BID_ONLY).awarded_amount).toBeNull();
    const writes = holder.queries.filter((q) => /\b(UPDATE|INSERT|DELETE)\b/i.test(q));
    expect(writes).toHaveLength(0);
  });
});
