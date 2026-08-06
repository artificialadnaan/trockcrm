import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCrmFileBucket,
  MAX_WALKTHROUGH_PAYLOAD_BYTES,
} from "../../../src/modules/estimating/walkthrough-ingress-service.js";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  runInOfficeTransaction: vi.fn(),
  ingestWalkthrough: vi.fn(),
  contactSheetStore: vi.fn(() => ({})),
}));

vi.mock("../../../src/db.js", () => ({ pool: { query: mocks.poolQuery } }));
vi.mock("../../../src/modules/field/cross-office.js", () => ({
  runInOfficeTransaction: mocks.runInOfficeTransaction,
}));
// PARTIAL mock. `ingestWalkthrough` is replaced; everything else — the validator the route now runs as
// a gate, and MAX_WALKTHROUGH_PAYLOAD_BYTES which sizes express.raw — stays REAL. A whole-module factory
// silently drops any export it does not list, so the route imported `undefined` as its body limit and
// every test in this file died at import. Partial keeps that class of failure impossible.
vi.mock("../../../src/modules/estimating/walkthrough-ingress-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/modules/estimating/walkthrough-ingress-service.js")>()),
  ingestWalkthrough: mocks.ingestWalkthrough,
}));
vi.mock("../../../src/modules/estimating/walkthrough-contact-sheet-store.js", () => ({
  createWalkthroughContactSheetStore: mocks.contactSheetStore,
}));

const SECRET = "test-ingest-secret";

/** Walks a drizzle SQL object into flat text so a WHERE can be asserted without a database. Mirrors
 *  the helper proven in deals-search-field-set.test.ts. */
function flattenSql(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(flattenSql).join("");
  }
  if ("value" in (value as Record<string, unknown>)) {
    const chunk = (value as { value: unknown }).value;
    if (Array.isArray(chunk)) return chunk.map(flattenSql).join("");
    if (typeof chunk === "string") return chunk;
  }
  if ("name" in (value as Record<string, unknown>) && typeof (value as { name?: unknown }).name === "string") {
    return (value as { name: string }).name;
  }
  return "";
}

function sign(body: string): string {
  return `sha256=${crypto.createHmac("sha256", SECRET).update(Buffer.from(body, "utf8")).digest("hex")}`;
}

async function appWithRoute() {
  const { scopeIngestRoutes } = await import("../../../src/modules/estimating/scope-ingest-routes.js");
  const app = express();
  app.use("/api/integrations/scope", scopeIngestRoutes);
  return app;
}

/**
 * A CONTRACT-VALID body, not a stub.
 *
 * It used to be four fields and `rows: []` — a payload the real ingress refuses outright, which only
 * passed because the whole ingress module was mocked away. Now that the route validates before it opens
 * a tenant transaction (matching the human route next door, whose suite already asserts a malformed
 * walkthrough "must not cost a deal lookup"), a stub body would 400 before reaching anything these tests
 * are actually about. Shaped from walkthrough-ingress-routes.test.ts so both doors describe one contract.
 */
const SCOPE_ROW = {
  sourceScopeItemId: "scope-1",
  rawLabel: "Replace wall base throughout the corridor",
  trade: "flooring",
  divisionHint: "09",
  quantity: 64,
  unit: "LF",
  confidence: 0.84,
  evidenceText: "we'll need to replace the wall base throughout",
  evidence: { clipId: "clip-1", timelineMs: 41_000, frameKey: "frames/clip-1/41000.jpg" },
  locationLabel: "Corridor",
};

const VALID = {
  officeSlug: "dallas",
  dealId: "a3f62c5b-6cbc-42cb-8f64-9a3d31fef98c",
  userId: "5687a3c6-1556-4dd6-a3d6-b26fbc22f471",
  walkthroughId: "b91a5bfd-eca9-4dbd-bde4-06528658b2b6",
  projectId: null,
  contactSheetBucket: getCrmFileBucket(),
  contactSheetBytes: 92_160,
  contactSheetMimeType: "image/jpeg",
  siteLabel: "Corridor 2",
  capturedAt: "2026-07-29T16:20:00Z",
  rows: [SCOPE_ROW],
};

beforeEach(() => {
  vi.resetModules();
  process.env.TROCK_SCOPE_INGEST_SECRET = SECRET;
  mocks.poolQuery.mockResolvedValue({ rows: [{ id: "office-1", slug: "dallas" }] });
  mocks.ingestWalkthrough.mockResolvedValue({ documentId: "doc-1", parseRunId: "run-1", fileId: "f-1", extractionIds: [] });
  // Runs the callback against a stub office db whose lookups succeed by default.
  mocks.runInOfficeTransaction.mockImplementation(async (_office: unknown, _userId: string, run: any) =>
    run({
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [{ id: "found" }] }) }),
      }),
    })
  );
});

afterEach(() => {
  delete process.env.TROCK_SCOPE_INGEST_SECRET;
  vi.clearAllMocks();
});

describe("the machine door into estimating", () => {
  it("accepts a correctly signed body", async () => {
    const body = JSON.stringify(VALID);
    const res = await request(await appWithRoute())
      .post("/api/integrations/scope/walkthrough-extractions")
      .set("content-type", "application/json")
      .set("x-trock-scope-signature", sign(body))
      .send(body);

    expect(res.status).toBe(201);
    expect(mocks.ingestWalkthrough).toHaveBeenCalledTimes(1);
  });

  // ─── Malformed input answers 400/413, never 500 ────────────────────────────────────────────────
  //
  // Every case below reached the catch-all before this change and came back as a bare 500. For a
  // machine caller that is the worst possible answer: it cannot tell a bug of its own from an outage
  // here, so the only safe reading is "retry", and the retry fails identically forever.

  it.each([
    ["null", "null"],
    ["an array", "[]"],
    ["a bare number", "7"],
    ["a bare string", '"x"'],
  ])("answers 400, not 500, when the body is valid JSON but %s", async (_label, body) => {
    // `JSON.parse("null")` succeeds, and reading `.officeSlug` off the result THROWS. Four bytes was
    // the shortest route to a 500 this endpoint had.
    const res = await request(await appWithRoute())
      .post("/api/integrations/scope/walkthrough-extractions")
      .set("content-type", "application/json")
      .set("x-trock-scope-signature", sign(body))
      .send(body);

    expect(res.status).toBe(400);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it.each([
    ["dealId", { ...VALID, dealId: "not-a-uuid" }],
    ["userId", { ...VALID, userId: "not-a-uuid" }],
  ])("rejects a non-UUID %s before any database is reached", async (_label, payload) => {
    // These pass the non-empty check and would then hit a `uuid` column, where Postgres raises 22P02
    // from inside the office transaction and it surfaces as a 500 — an input error reported as a server
    // fault. The transaction is MOCKED here, so this cannot observe the 22P02 itself; what it asserts is
    // the thing that prevents it — the request is refused before the office lookup or the transaction.
    const body = JSON.stringify(payload);
    const res = await request(await appWithRoute())
      .post("/api/integrations/scope/walkthrough-extractions")
      .set("content-type", "application/json")
      .set("x-trock-scope-signature", sign(body))
      .send(body);

    expect(res.status).toBe(400);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
    expect(mocks.runInOfficeTransaction).not.toHaveBeenCalled();
  });

  it("validates the payload BEFORE it looks up an office or opens a transaction", async () => {
    // The ordering claim, asserted rather than described. Same guarantee the human route's suite
    // already makes ("must not cost a deal lookup") — this door now matches it.
    const body = JSON.stringify({ ...VALID, rows: [] });
    const res = await request(await appWithRoute())
      .post("/api/integrations/scope/walkthrough-extractions")
      .set("content-type", "application/json")
      .set("x-trock-scope-signature", sign(body))
      .send(body);

    expect(res.status).toBe(400);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
    expect(mocks.runInOfficeTransaction).not.toHaveBeenCalled();
    expect(mocks.ingestWalkthrough).not.toHaveBeenCalled();
  });

  it("answers 413 with an actionable message when the body is over the limit", async () => {
    // Express raises `entity.too.large` from the body parser, before any handler. Unhandled, it is a
    // 500 — and a 500 on THIS failure is how a sender concludes the endpoint is broken rather than
    // that its export is too big. Built just past the ceiling with filler in a field the contract
    // bounds, so the size is what is under test and nothing else.
    const oversized = "x".repeat(MAX_WALKTHROUGH_PAYLOAD_BYTES + 1024);
    const body = JSON.stringify({ ...VALID, siteLabel: oversized });
    const res = await request(await appWithRoute())
      .post("/api/integrations/scope/walkthrough-extractions")
      .set("content-type", "application/json")
      .set("x-trock-scope-signature", sign(body))
      .send(body);

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/limit/i);
    expect(mocks.ingestWalkthrough).not.toHaveBeenCalled();
  });

  it("REFUSES an unsigned request", async () => {
    const body = JSON.stringify(VALID);
    const res = await request(await appWithRoute())
      .post("/api/integrations/scope/walkthrough-extractions")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(401);
    expect(mocks.ingestWalkthrough).not.toHaveBeenCalled();
  });

  it("REFUSES a body altered after signing", async () => {
    // The whole reason this is an HMAC over the raw bytes rather than a bearer token: a token proves
    // only who is calling, and this body decides what lands on a deal.
    const signed = JSON.stringify(VALID);
    const tampered = JSON.stringify({ ...VALID, dealId: "11111111-1111-4111-8111-111111111111" });
    const res = await request(await appWithRoute())
      .post("/api/integrations/scope/walkthrough-extractions")
      .set("content-type", "application/json")
      .set("x-trock-scope-signature", sign(signed))
      .send(tampered);

    expect(res.status).toBe(401);
    expect(mocks.ingestWalkthrough).not.toHaveBeenCalled();
  });

  it("REFUSES everything when the secret is not configured", async () => {
    // A forgotten environment variable must never mean "no signature required" — that would leave an
    // open write endpoint on the estimating pipeline.
    delete process.env.TROCK_SCOPE_INGEST_SECRET;
    const body = JSON.stringify(VALID);
    const res = await request(await appWithRoute())
      .post("/api/integrations/scope/walkthrough-extractions")
      .set("content-type", "application/json")
      .set("x-trock-scope-signature", sign(body))
      .send(body);

    expect(res.status).toBe(401);
    expect(mocks.ingestWalkthrough).not.toHaveBeenCalled();
  });

  it("REFUSES an actor it cannot prove", async () => {
    // `files.uploaded_by` is stamped from this id. An unverified value would put a person's name on a
    // machine's work, or a name that does not exist on a row whose foreign key says it must.
    mocks.runInOfficeTransaction.mockImplementation(async (_o: unknown, _u: string, run: any) =>
      run({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) })
    );
    const body = JSON.stringify(VALID);
    const res = await request(await appWithRoute())
      .post("/api/integrations/scope/walkthrough-extractions")
      .set("content-type", "application/json")
      .set("x-trock-scope-signature", sign(body))
      .send(body);

    expect(res.status).toBe(404);
    expect(mocks.ingestWalkthrough).not.toHaveBeenCalled();
  });

  it("REFUSES a SOFT-DELETED deal, by predicate and not by luck", async () => {
    // `is_active = false` is this schema's delete marker, and every per-deal action route reaches a
    // deal through getDealById, which hides inactive ones. Without this predicate a delayed or replayed
    // export deposits a file, a source document, a parse run and extraction rows under a deal no CRM
    // screen shows — and answers 201, so the sender records it as filed.
    //
    // Asserted on the PREDICATE rather than on a 404, because a mock returning [] gives a 404 whether
    // or not the guard is there. Flattening the drizzle condition is the only way to see the guard.
    const wheres: unknown[] = [];
    mocks.runInOfficeTransaction.mockImplementation(async (_o: unknown, _u: string, run: any) =>
      run({
        select: () => ({
          from: () => ({
            where: (condition: unknown) => {
              wheres.push(condition);
              // First call is the actor lookup, second the deal. Return a row for the actor so the
              // deal query is actually reached.
              return { limit: async () => (wheres.length === 1 ? [{ id: "u" }] : []) };
            },
          }),
        }),
      })
    );
    const body = JSON.stringify(VALID);
    const res = await request(await appWithRoute())
      .post("/api/integrations/scope/walkthrough-extractions")
      .set("content-type", "application/json")
      .set("x-trock-scope-signature", sign(body))
      .send(body);

    expect(res.status).toBe(404);
    expect(wheres).toHaveLength(2);
    expect(flattenSql(wheres[1])).toContain("is_active");
    expect(mocks.ingestWalkthrough).not.toHaveBeenCalled();
  });

  it("REFUSES an unknown office rather than guessing one", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    const body = JSON.stringify({ ...VALID, officeSlug: "atlantis" });
    const res = await request(await appWithRoute())
      .post("/api/integrations/scope/walkthrough-extractions")
      .set("content-type", "application/json")
      .set("x-trock-scope-signature", sign(body))
      .send(body);

    expect(res.status).toBe(404);
    expect(mocks.ingestWalkthrough).not.toHaveBeenCalled();
  });

  it("PINS the deal and actor it proved, so the body cannot override them", async () => {
    // The payload is otherwise passed through for the ingress to validate. These two are the fields a
    // caller must not choose, and they are re-applied after the body is spread.
    const body = JSON.stringify(VALID);
    await request(await appWithRoute())
      .post("/api/integrations/scope/walkthrough-extractions")
      .set("content-type", "application/json")
      .set("x-trock-scope-signature", sign(body))
      .send(body);

    const payload = mocks.ingestWalkthrough.mock.calls[0]![0].payload;
    expect(payload.dealId).toBe(VALID.dealId);
    expect(payload.userId).toBe(VALID.userId);
    // And no caller-supplied object key reached the ingress — it derives its own.
    expect(payload.contactSheetR2Key).toBeUndefined();
  });
});
