import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("../../../src/modules/estimating/walkthrough-ingress-service.js", () => ({
  ingestWalkthrough: mocks.ingestWalkthrough,
}));
vi.mock("../../../src/modules/estimating/walkthrough-contact-sheet-store.js", () => ({
  createWalkthroughContactSheetStore: mocks.contactSheetStore,
}));

const SECRET = "test-ingest-secret";

function sign(body: string): string {
  return `sha256=${crypto.createHmac("sha256", SECRET).update(Buffer.from(body, "utf8")).digest("hex")}`;
}

async function appWithRoute() {
  const { scopeIngestRoutes } = await import("../../../src/modules/estimating/scope-ingest-routes.js");
  const app = express();
  app.use("/api/integrations/scope", scopeIngestRoutes);
  return app;
}

const VALID = {
  officeSlug: "dallas",
  dealId: "a3f62c5b-6cbc-42cb-8f64-9a3d31fef98c",
  userId: "5687a3c6-1556-4dd6-a3d6-b26fbc22f471",
  walkthroughId: "b91a5bfd-eca9-4dbd-bde4-06528658b2b6",
  rows: [],
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
