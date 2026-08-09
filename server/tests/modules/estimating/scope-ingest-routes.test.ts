import crypto from "node:crypto";
import http from "node:http";
import zlib from "node:zlib";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCrmFileBucket,
  MAX_WALKTHROUGH_PAYLOAD_BYTES,
  MAX_WALKTHROUGH_TRANSPORT_BYTES,
} from "../../../src/modules/estimating/walkthrough-ingress-service.js";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  runInOfficeAsUser: vi.fn(),
  ingestWalkthrough: vi.fn(),
  contactSheetStore: vi.fn(() => ({})),
}));

vi.mock("../../../src/db.js", () => ({ pool: { query: mocks.poolQuery } }));
vi.mock("../../../src/modules/field/cross-office.js", () => ({
  runInOfficeAsUser: mocks.runInOfficeAsUser,
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
  return signBytes(Buffer.from(body, "utf8"));
}

/** Signs EXACT BYTES. The string form above cannot express a body that is not valid UTF-8, nor one
 *  whose transmitted bytes differ from the bytes signed — both of which are under test below. */
function signBytes(body: Buffer): string {
  return `sha256=${crypto.createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

async function appWithRoute() {
  const { scopeIngestRoutes } = await import("../../../src/modules/estimating/scope-ingest-routes.js");
  const app = express();
  app.use("/api/integrations/scope", scopeIngestRoutes);
  return app;
}

/**
 * POST EXACT BYTES, over a real socket.
 *
 * supertest cannot express these tests. Superagent SERIALIZES a Buffer when the content type is JSON —
 * `.send(buf)` arrives as `{"type":"Buffer","data":[…]}` — so a test that thought it was posting gzip
 * was posting 76 bytes of JSON about a Buffer, and one that thought it was posting an invalid byte was
 * posting its decimal code point. Both then failed for the wrong reason, which is worse than not being
 * written: the failure looked like the finding under test.
 *
 * Everything else in this file posts strings, which superagent passes through untouched, so only the
 * byte-exact cases need this.
 */
async function postRawBytes(
  app: express.Express,
  { headers, body }: { headers: Record<string, string>; body: Buffer }
): Promise<{ status: number; body: Record<string, any> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const { port } = server.address() as { port: number };
    return await new Promise((resolve, reject) => {
      const req = http.request(
        {
          port,
          method: "POST",
          path: "/api/integrations/scope/walkthrough-extractions",
          // Set explicitly: without it Node uses chunked encoding, and `Content-Length` is part of what
          // the body parser reads to decide how much to buffer.
          headers: { ...headers, "content-length": String(body.byteLength) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: Record<string, any> = {};
            try {
              parsed = JSON.parse(text);
            } catch {
              // A non-JSON error page is a legitimate answer to assert a status against.
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        }
      );
      req.on("error", reject);
      req.end(body);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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
  mocks.runInOfficeAsUser.mockImplementation(async (_office: unknown, _userId: string, run: any) =>
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
    expect(mocks.runInOfficeAsUser).not.toHaveBeenCalled();
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
    expect(mocks.runInOfficeAsUser).not.toHaveBeenCalled();
    expect(mocks.ingestWalkthrough).not.toHaveBeenCalled();
  });

  it("answers 400 naming the CONTRACT limit when the payload is over it but parseable", async () => {
    // The aggregate byte ceiling is part of the contract, so the ordinary too-big export is refused by
    // the validator with a message that names the limit — not by the transport with a bare 413. This is
    // the case a sender actually hits, and the one that used to be unexplainable.
    const oversized = "x".repeat(MAX_WALKTHROUGH_PAYLOAD_BYTES + 1024);
    const body = JSON.stringify({ ...VALID, siteLabel: oversized });
    const res = await request(await appWithRoute())
      .post("/api/integrations/scope/walkthrough-extractions")
      .set("content-type", "application/json")
      .set("x-trock-scope-signature", sign(body))
      .send(body);

    expect(res.status).toBe(400);
    // Asserted on `text`, not `body.error`: this app mounts the router alone, so an AppError reaches
    // Express's finalhandler, which honours `statusCode` but renders HTML rather than the JSON envelope
    // the real app's error handler produces. The status and the number are what this test is about.
    expect(res.text).toContain(String(MAX_WALKTHROUGH_PAYLOAD_BYTES));
    expect(mocks.ingestWalkthrough).not.toHaveBeenCalled();
  });

  it("answers 413 with an actionable message when the body is over the limit", async () => {
    // Express raises `entity.too.large` from the body parser, before any handler. Unhandled, it is a
    // 500 — and a 500 on THIS failure is how a sender concludes the endpoint is broken rather than
    // that its export is too big. Built just past the ceiling with filler in a field the contract
    // bounds, so the size is what is under test and nothing else.
    const oversized = "x".repeat(MAX_WALKTHROUGH_TRANSPORT_BYTES + 1024);
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

  it.each([
    ["no Content-Type at all", undefined],
    ["a non-JSON Content-Type", "text/plain"],
  ])("answers 415, not 500, when the raw parser is skipped because of %s", async (_label, contentType) => {
    // `express.raw({ type: "application/json" })` parses NOTHING for any other content type, leaving
    // `req.body` undefined. The route cast it to Buffer, so `Hmac.update(undefined)` threw and the
    // catch-all reported a 500 — reachable without a signature, by omitting a header.
    const body = JSON.stringify(VALID);
    let req = request(await appWithRoute()).post("/api/integrations/scope/walkthrough-extractions");
    if (contentType) req = req.set("content-type", contentType);
    const res = await req.set("x-trock-scope-signature", sign(body)).send(body);

    expect(res.status).toBe(415);
    expect(mocks.ingestWalkthrough).not.toHaveBeenCalled();
  });

  it.each([
    ["gzip", (raw: Buffer) => zlib.gzipSync(raw)],
    ["deflate", (raw: Buffer) => zlib.deflateSync(raw)],
    ["br", (raw: Buffer) => zlib.brotliCompressSync(raw)],
  ])("REFUSES a %s-encoded body rather than signing bytes that were never sent", async (encoding, compress) => {
    // THE SIGNATURE MUST COVER THE WIRE BYTES. body-parser's `raw()` inflates a compressed body by
    // default (read.js `contentstream`: it decompresses unless `inflate === false`), so `req.body` was
    // the DECOMPRESSED JSON. That breaks the contract in both directions: a sender that signs what it
    // actually transmitted gets a 401, and a sender that signs the uncompressed bytes is accepted on a
    // signature covering something other than the request. The second is the dangerous one — an
    // attacker who can re-compress a body changes the transmitted bytes without disturbing the HMAC.
    //
    // Refused outright rather than verified pre-inflation: the only sender is trock-scope, an exact-byte
    // contract is far easier to keep than a "sign the compressed form" one, and a 415 tells the sender
    // precisely what to change.
    const raw = Buffer.from(JSON.stringify(VALID), "utf8");
    const res = await postRawBytes(await appWithRoute(), {
      headers: {
        "content-type": "application/json",
        "content-encoding": encoding,
        // Signs the UNCOMPRESSED bytes — the sender the old behaviour silently accepted, because the
        // parser handed the route exactly these bytes after inflating.
        "x-trock-scope-signature": signBytes(raw),
      },
      body: compress(raw),
    });

    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/encoding/i);
    expect(mocks.ingestWalkthrough).not.toHaveBeenCalled();
  });

  it("REFUSES malformed UTF-8 instead of storing a substituted character", async () => {
    // `Buffer.toString("utf8")` is LOSSY: an invalid byte becomes U+FFFD rather than an error. The
    // result is still valid JSON, still passes every validator, and commits with a 201 — so the row
    // stored is not the row whose bytes were signed, and a sender's encoding bug is reported as a
    // success. The byte goes inside `rawLabel`, a free-text field, precisely so the request would
    // otherwise sail through to `ingestWalkthrough`.
    const json = JSON.stringify(VALID);
    const marker = "Replace wall base";
    const splitAt = json.indexOf(marker) + marker.length;
    expect(splitAt).toBeGreaterThan(marker.length); // the fixture still contains the anchor
    const body = Buffer.concat([
      Buffer.from(json.slice(0, splitAt), "utf8"),
      // A lone continuation byte: never valid UTF-8 in any position.
      Buffer.from([0xff]),
      Buffer.from(json.slice(splitAt), "utf8"),
    ]);

    const res = await postRawBytes(await appWithRoute(), {
      headers: {
        "content-type": "application/json",
        "x-trock-scope-signature": signBytes(body),
      },
      body,
    });

    expect(res.status).toBe(400);
    expect(mocks.ingestWalkthrough).not.toHaveBeenCalled();
  });

  it("answers 400, not a Postgres error, when officeSlug carries a NUL", async () => {
    // `officeSlug` is NOT part of the canonical payload shape, so the route's trim was its only check —
    // and it is bound straight into the office lookup. Postgres refuses a NUL in a text parameter, so
    // the LOOKUP threw and the route reported 500 for a malformed field.
    const body = JSON.stringify({ ...VALID, officeSlug: "dal\u0000las" });
    const res = await request(await appWithRoute())
      .post("/api/integrations/scope/walkthrough-extractions")
      .set("content-type", "application/json")
      .set("x-trock-scope-signature", sign(body))
      .send(body);

    expect(res.status).toBe(400);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it("lets the ingress own the ONLY transaction", async () => {
    // `runInOfficeTransaction` issues a raw BEGIN that drizzle cannot see, so `ingestWalkthrough`'s own
    // `tenantDb.transaction(...)` emitted a nested BEGIN (a no-op) and a real COMMIT that closed the
    // wrapper's transaction early — everything after ran unprotected and the wrapper's COMMIT was a
    // no-op. Pinned structurally: the route must use the non-transactional office helper, because a
    // mock cannot observe a BEGIN that Postgres merely warns about.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../../../src/modules/estimating/scope-ingest-routes.ts", import.meta.url),
        "utf8"
      )
    );

    // Matched on the CALL, not the file text: the comment explaining this change necessarily names the
    // old helper, and an assertion that trips over its own rationale is a test nobody keeps.
    expect(source).toMatch(/await runInOfficeAsUser\(/);
    expect(source).not.toMatch(/await runInOfficeTransaction\(/);
    expect(source).toMatch(/import \{ runInOfficeAsUser[,\s]/);
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
    mocks.runInOfficeAsUser.mockImplementation(async (_o: unknown, _u: string, run: any) =>
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
    mocks.runInOfficeAsUser.mockImplementation(async (_o: unknown, _u: string, run: any) =>
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
