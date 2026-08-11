// The guard on POST /api/internal/estimates-sent.
//
// This endpoint hands out deal names, owners and money across EVERY office to whoever can present a valid
// signature, so the signature is the entire boundary — there is no session, no role, and no tenant scoping
// behind it. The SQL itself is covered against real Postgres in estimates-sent.runtime.test.ts; what cannot
// be seen from there is whether anyone wired the verification to the route at all.
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/db.js", () => ({
  releasePooledClient: (client: any) => client?.release?.(),
  isBrokenConnectionError: () => false,
  pool: {
    query: queryMock,
    connect: vi.fn(async () => ({ query: queryMock, release: vi.fn() })),
  },
}));

const { internalRfpRoutes } = await import("../../../src/modules/internal-rfp/routes.js");

const SECRET = "test-synchub-secret";

function findRouteHandler(path: string) {
  const layer = (internalRfpRoutes as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route?.methods?.post
  );
  if (!layer) throw new Error(`Route POST ${path} not found`);
  const routeLayer = [...layer.route.stack].reverse().find((entry: any) => entry.method === "post");
  if (!routeLayer) throw new Error(`Handler for POST ${path} not found`);
  return routeLayer.handle;
}

function sign(raw: string): string {
  return `sha256=${crypto.createHmac("sha256", SECRET).update(Buffer.from(raw)).digest("hex")}`;
}

async function callWithBody(body: unknown, signature?: string) {
  const req = {
    body,
    headers: signature ? { "x-rfp-request-signature": signature } : {},
  } as any;
  const res = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  } as any;
  const next = vi.fn();
  await findRouteHandler("/estimates-sent")(req, res, next);
  return { res, next };
}

async function call(raw: string, signature?: string) {
  const req = {
    body: Buffer.from(raw),
    headers: signature ? { "x-rfp-request-signature": signature } : {},
  } as any;
  const res = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  } as any;
  const next = vi.fn();
  await findRouteHandler("/estimates-sent")(req, res, next);
  return { res, next };
}

const WINDOW = JSON.stringify({ from: "2026-08-06T00:00:00Z", to: "2026-08-07T00:00:00Z" });

const originalSecret = process.env.SYNCHUB_SHARED_SECRET;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SYNCHUB_SHARED_SECRET = SECRET;
  // First call is the tenant-schema listing; every later call is a per-schema sweep.
  queryMock.mockImplementation(async (text: string) => {
    if (text.includes("pg_namespace")) return { rows: [{ nspname: "office_dallas" }] };
    return { rows: [] };
  });
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.SYNCHUB_SHARED_SECRET;
  else process.env.SYNCHUB_SHARED_SECRET = originalSecret;
});

describe("POST /api/internal/estimates-sent — the signature is the whole boundary", () => {
  it("serves a correctly signed request", async () => {
    const { res } = await call(WINDOW, sign(WINDOW));

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, count: 0 });
    expect(res.body.from).toBe("2026-08-06T00:00:00.000Z");
  });

  it("refuses an unsigned request without touching the database", async () => {
    const { res } = await call(WINDOW);

    expect(res.statusCode).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("refuses a wrong signature", async () => {
    const { res } = await call(WINDOW, "sha256=" + "0".repeat(64));

    expect(res.statusCode).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });

  // The signature covers the BODY, so a valid signature for a different window must not authorise this one.
  it("refuses a signature computed over a different body", async () => {
    const other = JSON.stringify({ from: "2020-01-01T00:00:00Z", to: "2026-08-07T00:00:00Z" });
    const { res } = await call(WINDOW, sign(other));

    expect(res.statusCode).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });

  // An unset secret must deny, never allow. A missing environment variable is not permission.
  it("refuses everything when the shared secret is unset", async () => {
    delete process.env.SYNCHUB_SHARED_SECRET;
    const { res } = await call(WINDOW, sign(WINDOW));

    expect(res.statusCode).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// express.raw({ type: "application/json" }) SKIPS parsing for any other content type, and for a request
// with no Content-Type at all, leaving req.body undefined. Hmac.update(undefined) then throws and the
// outer catch reports a 500 — an unsupported media type surfaced as a server fault, reachable without a
// valid signature. Not observable through `call` above, which hands the handler a real Buffer.
describe("POST /api/internal/estimates-sent — a body the raw parser skipped", () => {
  it("answers 415 rather than throwing into a 500", async () => {
    const { res, next } = await callWithBody(undefined, sign(WINDOW));

    expect(res.statusCode).toBe(415);
    expect(next).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("answers 415 for a body another parser already turned into an object", async () => {
    const { res } = await callWithBody({ from: "2026-08-06T00:00:00Z" }, sign(WINDOW));

    expect(res.statusCode).toBe(415);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/internal/estimates-sent — the window", () => {
  it("422s an invalid window rather than defaulting to one", async () => {
    const body = JSON.stringify({ from: "yesterday", to: "2026-08-07T00:00:00Z" });
    const { res } = await call(body, sign(body));

    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ error: "invalid_window" });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("422s a window longer than the cap, rather than sweeping all history", async () => {
    const body = JSON.stringify({ from: "2020-01-01T00:00:00Z", to: "2026-08-07T00:00:00Z" });
    const { res } = await call(body, sign(body));

    expect(res.statusCode).toBe(422);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("400s a body that is not JSON", async () => {
    const body = "not json";
    const { res } = await call(body, sign(body));

    expect(res.statusCode).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  // Echoed from the PARSED window, so the report can state what it covered instead of restating what it
  // asked for. If those ever disagree, the email is describing a different question than it ran.
  it("echoes the window it actually queried", async () => {
    const { res } = await call(WINDOW, sign(WINDOW));

    expect(res.body.from).toBe("2026-08-06T00:00:00.000Z");
    expect(res.body.to).toBe("2026-08-07T00:00:00.000Z");
  });

  it("passes the window to the query as bind parameters, never inlined", async () => {
    await call(WINDOW, sign(WINDOW));

    const sweep = queryMock.mock.calls.find(([text]) => String(text).includes("deal_stage_history"));
    expect(sweep).toBeDefined();
    expect(sweep![1]).toEqual(["2026-08-06T00:00:00.000Z", "2026-08-07T00:00:00.000Z"]);
  });
});
