import express, { type Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../middleware/error-handler.js";
import {
  CORE_WEEKLY_REPORT_CURSOR_TTL_SECONDS,
  CORE_WEEKLY_REPORT_REQUEST_ID_HEADER,
  CORE_WEEKLY_REPORT_SIGNATURE_HEADER,
  CORE_WEEKLY_REPORT_TIMESTAMP_HEADER,
  decodeCoreWeeklyReportCursor,
  encodeCoreWeeklyReportCursor,
  signCoreWeeklyReportRequest,
  type CoreWeeklyReportAuthAction,
} from "./core-api-auth.js";
import {
  CORE_WEEKLY_REPORT_API_BASE_PATH,
  CORE_WEEKLY_REPORT_DEAL_RESPONSE_VERSION,
  CORE_WEEKLY_REPORT_DETAIL_RESPONSE_VERSION,
  CORE_WEEKLY_REPORT_ERROR_RESPONSE_VERSION,
  CORE_WEEKLY_REPORT_LIST_RESPONSE_VERSION,
  CORE_WEEKLY_REPORT_MAX_REQUEST_BYTES,
  type CoreWeeklyReportClientContent,
  type CoreWeeklyReportListItem,
} from "./core-api-contracts.js";
import {
  CORE_WEEKLY_REPORT_DB_STATEMENT_TIMEOUT,
  createCoreWeeklyReportOfficeTransaction,
  createCoreWeeklyReportApiRouter,
  type CoreWeeklyReportApiAuditEvent,
  type CoreWeeklyReportApiRouterOptions,
  type CoreWeeklyReportOfficeClientRunner,
  type CoreWeeklyReportOfficeTransaction,
} from "./core-api-routes.js";
import type {
  CoreWeeklyReportDetailResult,
  CoreWeeklyReportListResult,
} from "./core-api-service.js";
import type { QueryExecutor } from "./projects-service.js";

const CURRENT_SECRET = "crm-current-weekly-report-key-material-0001";
const PREVIOUS_SECRET = "crm-previous-weekly-report-key-material-001";
const UNKNOWN_SECRET = "crm-unknown-weekly-report-key-material-00001";
const REQUEST_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_REQUEST_ID = "00000000-0000-4000-8000-000000000002";
const DEAL_ID = "00000000-0000-4000-8000-000000000011";
const OTHER_DEAL_ID = "00000000-0000-4000-8000-000000000012";
const REPORT_ID = "00000000-0000-4000-8000-000000000021";
const NEXT_REPORT_ID = "00000000-0000-4000-8000-000000000022";
const PHOTO_ID = "00000000-0000-4000-8000-000000000031";
const NOW_MS = Date.parse("2026-08-27T20:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW_MS / 1_000);
const CANONICAL_PROJECT_NUMBER = "dfw-1-00123-aa";

const ENABLED_ENV = {
  ENABLE_CRM_CORE_WEEKLY_REPORT_READ_API: "true",
  TROCK_CORE_WEEKLY_REPORT_API_SECRET: CURRENT_SECRET,
  TROCK_CORE_WEEKLY_REPORT_API_PREVIOUS_SECRET: PREVIOUS_SECRET,
} as const;

const LIST_ITEM: CoreWeeklyReportListItem = {
  id: REPORT_ID,
  weekOf: "2026-08-24",
  version: 2,
  publicationStatus: "sent",
  lifecycleState: "latest",
  supersededByReportId: null,
  sendAcceptedAt: "2026-08-27T18:00:00.000Z",
};

const CONTENT: CoreWeeklyReportClientContent = {
  propertyName: "Frozen Client Property",
  weekOfLabel: "Week of August 24, 2026",
  clientName: "Synthetic Client",
  clientTeam: [{ label: "Project Manager", name: "Client Person" }],
  trockTeam: [{ label: "Superintendent", name: "T Rock Person" }],
  workCompleted: "Synthetic already-sent narrative",
  nextWeekLookAhead: "Synthetic next-week narrative",
  issuesConcerns: null,
  schedule: {
    contractDate: "Jan 1, 2026",
    projectStartDate: "Feb 1, 2026",
    projectCompletionDate: "Nov 1, 2026",
    completionPercent: "42%",
    weatherDelayDays: "0",
  },
  duration: { projectedWeeks: 40, remainingWeeks: 23 },
  photos: [{ fileId: PHOTO_ID, caption: "Synthetic client-safe caption", sortOrder: 0 }],
};

interface Harness {
  app: Express;
  client: QueryExecutor;
  auditEvents: CoreWeeklyReportApiAuditEvent[];
  authorizeCorePeer: ReturnType<typeof vi.fn>;
  resolveActiveOffice: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
  resolveDeal: ReturnType<typeof vi.fn>;
  requireDealBinding: ReturnType<typeof vi.fn>;
  captureDeliveryBoundary: ReturnType<typeof vi.fn>;
  listReports: ReturnType<typeof vi.fn>;
  detailReport: ReturnType<typeof vi.fn>;
}

function createHarness(overrides: CoreWeeklyReportApiRouterOptions = {}): Harness {
  const client = { query: vi.fn() } as unknown as QueryExecutor;
  const auditEvents: CoreWeeklyReportApiAuditEvent[] = [];
  const authorizeCorePeer = vi.fn(async () => true);
  const resolveActiveOffice = vi.fn(async () => true);
  const transaction = vi.fn(async (
    _officeSlug: string,
    _signal: AbortSignal,
    run: (executor: QueryExecutor) => Promise<unknown>,
  ) => run(client));
  const resolveDeal = vi.fn(async () => ({
    id: DEAL_ID,
    canonicalProjectNumber: CANONICAL_PROJECT_NUMBER,
  }));
  const requireDealBinding = vi.fn(async () => ({
    id: DEAL_ID,
    canonicalProjectNumber: CANONICAL_PROJECT_NUMBER,
  }));
  const captureDeliveryBoundary = vi.fn(async () => new Date(NOW_MS).toISOString());
  const listReports = vi.fn(async (): Promise<CoreWeeklyReportListResult> => ({
    items: [LIST_ITEM],
    hasMore: false,
    last: {
      weekOf: LIST_ITEM.weekOf,
      reportVersion: LIST_ITEM.version,
      reportId: LIST_ITEM.id,
    },
  }));
  const detailReport = vi.fn(async (): Promise<CoreWeeklyReportDetailResult> => ({
    item: LIST_ITEM,
    content: CONTENT,
  }));
  const defaults: CoreWeeklyReportApiRouterOptions = {
    env: ENABLED_ENV,
    now: () => NOW_MS,
    observe: (event) => {
      auditEvents.push(event);
    },
    authorizeCorePeer,
    resolveActiveOffice,
    withOfficeTransaction: transaction as unknown as CoreWeeklyReportOfficeTransaction,
    resolveDeal: resolveDeal as unknown as NonNullable<CoreWeeklyReportApiRouterOptions["resolveDeal"]>,
    requireDealBinding:
      requireDealBinding as unknown as NonNullable<CoreWeeklyReportApiRouterOptions["requireDealBinding"]>,
    captureDeliveryBoundary:
      captureDeliveryBoundary as unknown as NonNullable<CoreWeeklyReportApiRouterOptions["captureDeliveryBoundary"]>,
    listReports:
      listReports as unknown as NonNullable<CoreWeeklyReportApiRouterOptions["listReports"]>,
    detailReport:
      detailReport as unknown as NonNullable<CoreWeeklyReportApiRouterOptions["detailReport"]>,
  };
  const app = express();
  app.use(
    CORE_WEEKLY_REPORT_API_BASE_PATH,
    createCoreWeeklyReportApiRouter({ ...defaults, ...overrides }),
  );
  return {
    app,
    client,
    auditEvents,
    authorizeCorePeer,
    resolveActiveOffice,
    transaction,
    resolveDeal,
    requireDealBinding,
    captureDeliveryBoundary,
    listReports,
    detailReport,
  };
}

function resolveBody(projectNumber = "DFW-1-00123-AA"): string {
  return JSON.stringify({ officeSlug: "dallas", projectNumber });
}

function listBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    officeSlug: "dallas",
    dealId: DEAL_ID,
    canonicalProjectNumber: CANONICAL_PROJECT_NUMBER,
    limit: 25,
    cursor: null,
    ...overrides,
  });
}

function detailBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    officeSlug: "dallas",
    dealId: DEAL_ID,
    canonicalProjectNumber: CANONICAL_PROJECT_NUMBER,
    reportId: REPORT_ID,
    ...overrides,
  });
}

interface SignedRequestOptions {
  path: "/deals/resolve" | "/reports/list" | "/reports/detail";
  action: CoreWeeklyReportAuthAction;
  rawBody: string | Buffer;
  secret?: string;
  requestId?: string;
  timestampSeconds?: number;
  signatureAction?: CoreWeeklyReportAuthAction;
}

function signedRequest(app: Express, options: SignedRequestOptions) {
  const rawBody = Buffer.isBuffer(options.rawBody)
    ? options.rawBody
    : Buffer.from(options.rawBody, "utf8");
  const requestId = options.requestId ?? REQUEST_ID;
  const timestampSeconds = options.timestampSeconds ?? NOW_SECONDS;
  const test = request(app)
    .post(`${CORE_WEEKLY_REPORT_API_BASE_PATH}${options.path}`)
    .set("Content-Type", "application/json")
    .set(CORE_WEEKLY_REPORT_REQUEST_ID_HEADER, requestId)
    .set(CORE_WEEKLY_REPORT_TIMESTAMP_HEADER, String(timestampSeconds))
    .set(
      CORE_WEEKLY_REPORT_SIGNATURE_HEADER,
      signCoreWeeklyReportRequest({
        action: options.signatureAction ?? options.action,
        requestId,
        timestampSeconds,
        rawBody,
        secret: options.secret ?? CURRENT_SECRET,
      }),
    );
  if (Buffer.isBuffer(options.rawBody)) {
    // Superagent otherwise applies its application/json serializer to Buffer objects. Keep the exact
    // ill-formed byte vector on the wire so the route's fatal UTF-8 decoder, not the test client, sees it.
    return test
      .serialize(() => options.rawBody as unknown as string)
      .send(options.rawBody);
  }
  return test.send(options.rawBody);
}

function expectNoTenantWork(harness: Harness): void {
  expect(harness.resolveActiveOffice).not.toHaveBeenCalled();
  expect(harness.transaction).not.toHaveBeenCalled();
  expect(harness.resolveDeal).not.toHaveBeenCalled();
  expect(harness.requireDealBinding).not.toHaveBeenCalled();
  expect(harness.listReports).not.toHaveBeenCalled();
  expect(harness.detailReport).not.toHaveBeenCalled();
}

function expectBare(response: request.Response, statusCode: number): void {
  expect(response.status).toBe(statusCode);
  expect(response.text).toBe("");
  expect(response.headers["content-type"]).toBeUndefined();
  expect(response.headers["cache-control"]).toBe("private, no-store");
}

function expectTypedError(
  response: request.Response,
  statusCode: number,
  requestId: string | null,
  code: string,
): void {
  expect(response.status).toBe(statusCode);
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.headers["content-type"]).toMatch(/^application\/json/);
  expect(response.body).toEqual({
    version: CORE_WEEKLY_REPORT_ERROR_RESPONSE_VERSION,
    requestId,
    error: { code, message: expect.any(String) },
  });
}

describe("Core weekly-report HTTP feature and peer gates", () => {
  it("is content-free 404 and performs no peer/auth/data work while the exact flag is dark", async () => {
    const harness = createHarness({
      env: {
        ...ENABLED_ENV,
        ENABLE_CRM_CORE_WEEKLY_REPORT_READ_API: "false",
      },
    });
    const response = await request(harness.app)
      .post(`${CORE_WEEKLY_REPORT_API_BASE_PATH}/deals/resolve`)
      .set("Content-Type", "application/json")
      .send(resolveBody());
    expectBare(response, 404);
    expect(harness.authorizeCorePeer).not.toHaveBeenCalled();
    expectNoTenantWork(harness);
  });

  it.each([
    {},
    { TROCK_CORE_WEEKLY_REPORT_API_SECRET: "short" },
    {
      TROCK_CORE_WEEKLY_REPORT_API_SECRET: CURRENT_SECRET,
      TROCK_CORE_WEEKLY_REPORT_API_PREVIOUS_SECRET: CURRENT_SECRET,
    },
  ])("is content-free 503 before peer or lookup for enabled unready secrets: %j", async (keys) => {
    const harness = createHarness({
      env: { ENABLE_CRM_CORE_WEEKLY_REPORT_READ_API: "true", ...keys },
    });
    const response = await request(harness.app)
      .post(`${CORE_WEEKLY_REPORT_API_BASE_PATH}/deals/resolve`)
      .set("Content-Type", "application/json")
      .send(resolveBody());
    expectBare(response, 503);
    expect(harness.authorizeCorePeer).not.toHaveBeenCalled();
    expectNoTenantWork(harness);
  });

  it("stays unready when no trusted peer verifier is supplied", async () => {
    const harness = createHarness({ authorizeCorePeer: undefined });
    const response = await signedRequest(harness.app, {
      path: "/deals/resolve",
      action: "resolve-deal",
      rawBody: resolveBody(),
    });
    expectBare(response, 503);
    expectNoTenantWork(harness);
  });

  it("returns the same body-free 401 for missing, wrong, or throwing peer identity", async () => {
    for (const authorizeCorePeer of [
      vi.fn(async () => false),
      vi.fn(async () => {
        throw new Error("untrusted peer detail must not escape");
      }),
    ]) {
      const harness = createHarness({ authorizeCorePeer });
      const response = await signedRequest(harness.app, {
        path: "/deals/resolve",
        action: "resolve-deal",
        rawBody: resolveBody(),
      });
      expectBare(response, 401);
      expect(authorizeCorePeer).toHaveBeenCalledTimes(1);
      expectNoTenantWork(harness);
    }
  });

  it.each([
    ["Origin", "https://portal.example.com"],
    ["Referer", "https://portal.example.com/projects/1"],
    ["Sec-Fetch-Site", "cross-site"],
  ])("rejects browser/direct-origin context before consulting peer auth: %s", async (name, value) => {
    const harness = createHarness();
    const response = await signedRequest(harness.app, {
      path: "/deals/resolve",
      action: "resolve-deal",
      rawBody: resolveBody(),
    }).set(name, value);
    expectBare(response, 401);
    expect(harness.authorizeCorePeer).not.toHaveBeenCalled();
    expectNoTenantWork(harness);
  });

  it("never treats forwarded client-certificate headers as peer identity", async () => {
    const authorizeCorePeer = vi.fn(async () => false);
    const harness = createHarness({ authorizeCorePeer });
    const response = await signedRequest(harness.app, {
      path: "/deals/resolve",
      action: "resolve-deal",
      rawBody: resolveBody(),
    }).set("X-Forwarded-Client-Cert", "By=fake;Hash=fake");
    expectBare(response, 401);
    expect(authorizeCorePeer).toHaveBeenCalledTimes(1);
    expectNoTenantWork(harness);
  });
});

describe("Core weekly-report HTTP authentication and raw transport", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it.each([
    CORE_WEEKLY_REPORT_REQUEST_ID_HEADER,
    CORE_WEEKLY_REPORT_TIMESTAMP_HEADER,
    CORE_WEEKLY_REPORT_SIGNATURE_HEADER,
  ])("rejects a missing required authentication header uniformly: %s", async (missing) => {
    const rawBody = resolveBody();
    const response = await signedRequest(harness.app, {
      path: "/deals/resolve",
      action: "resolve-deal",
      rawBody,
    }).unset(missing);
    expectBare(response, 401);
    expectNoTenantWork(harness);
  });

  it.each([
    CORE_WEEKLY_REPORT_REQUEST_ID_HEADER,
    CORE_WEEKLY_REPORT_TIMESTAMP_HEADER,
    CORE_WEEKLY_REPORT_SIGNATURE_HEADER,
  ])("rejects duplicate authentication header lines before body/auth processing: %s", async (name) => {
    const rawBody = resolveBody();
    const test = signedRequest(harness.app, {
      path: "/deals/resolve",
      action: "resolve-deal",
      rawBody,
    });
    const duplicateValues = name === CORE_WEEKLY_REPORT_REQUEST_ID_HEADER
      ? [REQUEST_ID, OTHER_REQUEST_ID]
      : name === CORE_WEEKLY_REPORT_TIMESTAMP_HEADER
        ? [String(NOW_SECONDS), String(NOW_SECONDS + 1)]
        : [
            signCoreWeeklyReportRequest({
              action: "resolve-deal",
              requestId: REQUEST_ID,
              timestampSeconds: NOW_SECONDS,
              rawBody: Buffer.from(rawBody),
              secret: CURRENT_SECRET,
            }),
            "sha256=" + "0".repeat(64),
          ];
    const response = await test.set(name, duplicateValues as unknown as string);
    expectBare(response, 401);
    expectNoTenantWork(harness);
  });

  it.each([
    ["bad request id", { requestId: "not-a-uuid" }],
    ["bad timestamp", { timestampSeconds: 123 }],
    ["stale timestamp", { timestampSeconds: NOW_SECONDS - 301 }],
    ["unknown key", { secret: UNKNOWN_SECRET }],
    ["wrong action", { signatureAction: "list-reports" as const }],
  ])("returns one body-free 401 for %s", async (_label, changed) => {
    const response = await signedRequest(harness.app, {
      path: "/deals/resolve",
      action: "resolve-deal",
      rawBody: resolveBody(),
      ...changed,
    });
    expectBare(response, 401);
    expectNoTenantWork(harness);
  });

  it("linearizes HMAC freshness after a slow body has finished, not at request start", async () => {
    const now = vi.fn()
      .mockReturnValueOnce(NOW_MS)
      .mockReturnValue(NOW_MS + 301_000);
    const slowHarness = createHarness({ now });
    const response = await signedRequest(slowHarness.app, {
      path: "/deals/resolve",
      action: "resolve-deal",
      rawBody: resolveBody(),
      timestampSeconds: NOW_SECONDS,
    });
    expectBare(response, 401);
    expect(now).toHaveBeenCalledTimes(3);
    expectNoTenantWork(slowHarness);
  });

  it("accepts current and previous HMAC slots only for the exact signed bytes", async () => {
    for (const secret of [CURRENT_SECRET, PREVIOUS_SECRET]) {
      const local = createHarness();
      const response = await signedRequest(local.app, {
        path: "/deals/resolve",
        action: "resolve-deal",
        rawBody: resolveBody(),
        secret,
      });
      expect(response.status).toBe(200);
      expect(local.resolveDeal).toHaveBeenCalledTimes(1);
      expect(local.auditEvents.at(-1)?.keySlot).toBe(
        secret === CURRENT_SECRET ? "current" : "previous",
      );
    }

    const original = resolveBody();
    const changed = original.replace("dallas", "atlanta");
    const signature = signCoreWeeklyReportRequest({
      action: "resolve-deal",
      requestId: REQUEST_ID,
      timestampSeconds: NOW_SECONDS,
      rawBody: Buffer.from(original),
      secret: CURRENT_SECRET,
    });
    const changedResponse = await request(harness.app)
      .post(`${CORE_WEEKLY_REPORT_API_BASE_PATH}/deals/resolve`)
      .set("Content-Type", "application/json")
      .set(CORE_WEEKLY_REPORT_REQUEST_ID_HEADER, REQUEST_ID)
      .set(CORE_WEEKLY_REPORT_TIMESTAMP_HEADER, String(NOW_SECONDS))
      .set(CORE_WEEKLY_REPORT_SIGNATURE_HEADER, signature)
      .send(changed);
    expectBare(changedResponse, 401);
    expectNoTenantWork(harness);
  });

  it("accepts exactly 16 KiB of signed UTF-8 JSON bytes and rejects the next byte", async () => {
    const compact = resolveBody();
    const atLimit = compact + " ".repeat(CORE_WEEKLY_REPORT_MAX_REQUEST_BYTES - Buffer.byteLength(compact));
    expect(Buffer.byteLength(atLimit)).toBe(CORE_WEEKLY_REPORT_MAX_REQUEST_BYTES);
    const accepted = await signedRequest(harness.app, {
      path: "/deals/resolve",
      action: "resolve-deal",
      rawBody: atLimit,
    });
    expect(accepted.status).toBe(200);
    expect(harness.resolveDeal).toHaveBeenCalledTimes(1);

    const rejectedHarness = createHarness();
    const tooLarge = `${atLimit} `;
    const rejected = await signedRequest(rejectedHarness.app, {
      path: "/deals/resolve",
      action: "resolve-deal",
      rawBody: tooLarge,
    });
    expectTypedError(rejected, 413, null, "request_too_large");
    expectNoTenantWork(rejectedHarness);
  });

  it("rejects missing/wrong/duplicated content type and compressed bodies before lookup", async () => {
    const rawBody = resolveBody();
    const missing = await signedRequest(harness.app, {
      path: "/deals/resolve",
      action: "resolve-deal",
      rawBody,
    }).unset("Content-Type");
    expectTypedError(missing, 415, null, "unsupported_media_type");

    const wrong = await signedRequest(harness.app, {
      path: "/deals/resolve",
      action: "resolve-deal",
      rawBody,
    }).set("Content-Type", "text/plain");
    expectTypedError(wrong, 415, null, "unsupported_media_type");

    const duplicate = await signedRequest(harness.app, {
      path: "/deals/resolve",
      action: "resolve-deal",
      rawBody,
    }).set("Content-Type", ["application/json", "text/plain"] as unknown as string);
    expectTypedError(duplicate, 415, null, "unsupported_media_type");

    const compressed = await signedRequest(harness.app, {
      path: "/deals/resolve",
      action: "resolve-deal",
      rawBody,
    }).set("Content-Encoding", "gzip");
    expectTypedError(compressed, 415, null, "unsupported_media_type");
    expectNoTenantWork(harness);
  });

  it("rejects signed ill-formed UTF-8, malformed JSON, duplicate keys, and strict-shape violations", async () => {
    const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
    const cases: Array<string | Buffer> = [
      invalidUtf8,
      "{",
      '{"officeSlug":"dallas","officeSlug":"atlanta","projectNumber":"DFW-1"}',
      JSON.stringify({ officeSlug: "dallas" }),
      JSON.stringify({ officeSlug: "dallas", projectNumber: "DFW-1", extra: true }),
    ];
    for (const rawBody of cases) {
      const local = createHarness();
      const response = await signedRequest(local.app, {
        path: "/deals/resolve",
        action: "resolve-deal",
        rawBody,
      });
      expectTypedError(response, 400, REQUEST_ID, "invalid_request");
      expectNoTenantWork(local);
    }
  });
});

describe("Core weekly-report HTTP operation isolation and DTOs", () => {
  it("resolves the signed office before one tenant transaction and returns the exact deal DTO", async () => {
    const harness = createHarness();
    const response = await signedRequest(harness.app, {
      path: "/deals/resolve",
      action: "resolve-deal",
      rawBody: resolveBody(),
    });
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toEqual({
      version: CORE_WEEKLY_REPORT_DEAL_RESPONSE_VERSION,
      requestId: REQUEST_ID,
      deal: { id: DEAL_ID, canonicalProjectNumber: CANONICAL_PROJECT_NUMBER },
    });
    expect(response.body).not.toHaveProperty("officeSlug");
    expect(harness.resolveActiveOffice).toHaveBeenCalledWith("dallas", expect.any(AbortSignal));
    expect(harness.transaction).toHaveBeenCalledTimes(1);
    expect(harness.transaction.mock.calls[0]?.[0]).toBe("dallas");
    expect(harness.transaction.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(harness.resolveDeal).toHaveBeenCalledWith(harness.client, "DFW-1-00123-AA");
    expect(harness.resolveActiveOffice.mock.invocationCallOrder[0]).toBeLessThan(
      harness.transaction.mock.invocationCallOrder[0]!,
    );
  });

  it("hides an unknown/inactive office and opens no tenant transaction", async () => {
    const resolveActiveOffice = vi.fn(async () => false);
    const harness = createHarness({ resolveActiveOffice });
    const response = await signedRequest(harness.app, {
      path: "/deals/resolve",
      action: "resolve-deal",
      rawBody: resolveBody(),
    });
    expectTypedError(response, 404, REQUEST_ID, "not_found");
    expect(resolveActiveOffice).toHaveBeenCalledTimes(1);
    expect(harness.transaction).not.toHaveBeenCalled();
    expect(harness.resolveDeal).not.toHaveBeenCalled();
    expect(harness.auditEvents.at(-1)).toMatchObject({
      officeSlug: "dallas",
      dealId: null,
      statusCode: 404,
    });
  });

  it("lists through binding and report reads on the same client in one transaction", async () => {
    const harness = createHarness();
    const response = await signedRequest(harness.app, {
      path: "/reports/list",
      action: "list-reports",
      rawBody: listBody(),
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      version: CORE_WEEKLY_REPORT_LIST_RESPONSE_VERSION,
      requestId: REQUEST_ID,
      deal: { id: DEAL_ID, canonicalProjectNumber: CANONICAL_PROJECT_NUMBER },
      asOf: new Date(NOW_MS).toISOString(),
      items: [LIST_ITEM],
      nextCursor: null,
    });
    expect(response.body.items[0]).not.toHaveProperty("sentAt");
    expect(response.body).not.toHaveProperty("officeSlug");
    expect(harness.transaction).toHaveBeenCalledTimes(1);
    expect(harness.requireDealBinding).toHaveBeenCalledWith(
      harness.client,
      DEAL_ID,
      CANONICAL_PROJECT_NUMBER,
    );
    expect(harness.listReports).toHaveBeenCalledWith(harness.client, {
      dealId: DEAL_ID,
      limit: 25,
      asOf: new Date(NOW_MS).toISOString(),
      after: null,
    });
    expect(harness.requireDealBinding.mock.invocationCallOrder[0]).toBeLessThan(
      harness.captureDeliveryBoundary.mock.invocationCallOrder[0]!,
    );
    expect(harness.captureDeliveryBoundary.mock.invocationCallOrder[0]).toBeLessThan(
      harness.listReports.mock.invocationCallOrder[0]!,
    );
  });

  it("issues a current-key cursor and preserves its asOf/lifetime/position on the next page", async () => {
    const firstHarness = createHarness({
      listReports: vi.fn(async (): Promise<CoreWeeklyReportListResult> => ({
        items: [LIST_ITEM],
        hasMore: true,
        last: {
          weekOf: LIST_ITEM.weekOf,
          reportVersion: LIST_ITEM.version,
          reportId: LIST_ITEM.id,
        },
      })) as unknown as NonNullable<CoreWeeklyReportApiRouterOptions["listReports"]>,
    });
    const first = await signedRequest(firstHarness.app, {
      path: "/reports/list",
      action: "list-reports",
      rawBody: listBody(),
    });
    expect(first.status).toBe(200);
    const cursor = decodeCoreWeeklyReportCursor(
      first.body.nextCursor,
      [CURRENT_SECRET],
      NOW_MS,
    );
    expect(cursor).toEqual({
      version: 1,
      officeSlug: "dallas",
      dealId: DEAL_ID,
      canonicalProjectNumber: CANONICAL_PROJECT_NUMBER,
      limit: 25,
      asOf: new Date(NOW_MS).toISOString(),
      issuedAt: new Date(NOW_MS).toISOString(),
      expiresAt: new Date(NOW_MS + CORE_WEEKLY_REPORT_CURSOR_TTL_SECONDS * 1_000).toISOString(),
      weekOf: LIST_ITEM.weekOf,
      reportVersion: LIST_ITEM.version,
      reportId: LIST_ITEM.id,
    });

    const secondHarness = createHarness();
    const second = await signedRequest(secondHarness.app, {
      path: "/reports/list",
      action: "list-reports",
      rawBody: listBody({ cursor: first.body.nextCursor }),
      requestId: OTHER_REQUEST_ID,
    });
    expect(second.status).toBe(200);
    expect(second.body.asOf).toBe(new Date(NOW_MS).toISOString());
    expect(secondHarness.listReports).toHaveBeenCalledWith(secondHarness.client, {
      dealId: DEAL_ID,
      limit: 25,
      asOf: new Date(NOW_MS).toISOString(),
      after: {
        weekOf: LIST_ITEM.weekOf,
        reportVersion: LIST_ITEM.version,
        reportId: LIST_ITEM.id,
      },
    });
    expect(secondHarness.captureDeliveryBoundary).not.toHaveBeenCalled();
  });

  it("accepts a previous-key cursor during rotation but rejects tamper/context/limit/expiry before lookup", async () => {
    const issuedAt = new Date(NOW_MS).toISOString();
    const payload = {
      version: 1 as const,
      officeSlug: "dallas",
      dealId: DEAL_ID,
      canonicalProjectNumber: CANONICAL_PROJECT_NUMBER,
      limit: 25,
      asOf: issuedAt,
      issuedAt,
      expiresAt: new Date(NOW_MS + CORE_WEEKLY_REPORT_CURSOR_TTL_SECONDS * 1_000).toISOString(),
      weekOf: "2026-08-17",
      reportVersion: 1,
      reportId: REPORT_ID,
    };
    const previousCursor = encodeCoreWeeklyReportCursor(payload, PREVIOUS_SECRET);
    const acceptedHarness = createHarness();
    const accepted = await signedRequest(acceptedHarness.app, {
      path: "/reports/list",
      action: "list-reports",
      rawBody: listBody({ cursor: previousCursor }),
    });
    expect(accepted.status).toBe(200);
    expect(acceptedHarness.listReports).toHaveBeenCalledTimes(1);

    const [encoded, mac] = previousCursor.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ ...payload, dealId: OTHER_DEAL_ID }))
      .toString("base64url");
    const candidates = [
      `${tamperedPayload}.${mac}`,
      previousCursor,
      previousCursor,
    ];
    const bodies = [
      listBody({ cursor: candidates[0] }),
      listBody({ cursor: candidates[1], dealId: OTHER_DEAL_ID }),
      listBody({ cursor: candidates[2], limit: 26 }),
    ];
    for (const rawBody of bodies) {
      const local = createHarness();
      const response = await signedRequest(local.app, {
        path: "/reports/list",
        action: "list-reports",
        rawBody,
      });
      expectTypedError(response, 400, REQUEST_ID, "invalid_request");
      expectNoTenantWork(local);
    }

    const expiredHarness = createHarness({
      now: () => NOW_MS + CORE_WEEKLY_REPORT_CURSOR_TTL_SECONDS * 1_000,
    });
    const expired = await signedRequest(expiredHarness.app, {
      path: "/reports/list",
      action: "list-reports",
      rawBody: listBody({ cursor: previousCursor }),
      timestampSeconds: NOW_SECONDS + CORE_WEEKLY_REPORT_CURSOR_TTL_SECONDS,
    });
    expectTypedError(expired, 400, REQUEST_ID, "invalid_request");
    expectNoTenantWork(expiredHarness);
    expect(encoded).toBeTruthy();
  });

  it("validates cursor time after body/auth work rather than preserving request-start validity", async () => {
    const issuedAt = new Date(NOW_MS).toISOString();
    const cursor = encodeCoreWeeklyReportCursor({
      version: 1,
      officeSlug: "dallas",
      dealId: DEAL_ID,
      canonicalProjectNumber: CANONICAL_PROJECT_NUMBER,
      limit: 25,
      asOf: issuedAt,
      issuedAt,
      expiresAt: new Date(NOW_MS + 1_000).toISOString(),
      weekOf: "2026-08-17",
      reportVersion: 1,
      reportId: REPORT_ID,
    }, CURRENT_SECRET);
    const now = vi.fn()
      .mockReturnValueOnce(NOW_MS)
      .mockReturnValueOnce(NOW_MS + 999)
      .mockReturnValue(NOW_MS + 1_000);
    const harness = createHarness({ now });
    const response = await signedRequest(harness.app, {
      path: "/reports/list",
      action: "list-reports",
      rawBody: listBody({ cursor }),
      timestampSeconds: Math.floor((NOW_MS + 999) / 1_000),
    });
    expectTypedError(response, 400, REQUEST_ID, "invalid_request");
    expectNoTenantWork(harness);
  });

  it("returns only the exact frozen detail DTO and preserves nullable legacy propertyName", async () => {
    const detailReport = vi.fn(async (): Promise<CoreWeeklyReportDetailResult> => ({
      item: { ...LIST_ITEM, lifecycleState: "superseded", supersededByReportId: NEXT_REPORT_ID },
      content: { ...CONTENT, propertyName: null },
    }));
    const harness = createHarness({
      detailReport: detailReport as unknown as NonNullable<CoreWeeklyReportApiRouterOptions["detailReport"]>,
    });
    const response = await signedRequest(harness.app, {
      path: "/reports/detail",
      action: "report-detail",
      rawBody: detailBody(),
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      version: CORE_WEEKLY_REPORT_DETAIL_RESPONSE_VERSION,
      requestId: REQUEST_ID,
      deal: { id: DEAL_ID, canonicalProjectNumber: CANONICAL_PROJECT_NUMBER },
      report: {
        ...LIST_ITEM,
        lifecycleState: "superseded",
        supersededByReportId: NEXT_REPORT_ID,
        contentSource: "frozen_sent_snapshot",
        content: { ...CONTENT, propertyName: null },
      },
    });
    expect(response.body).not.toHaveProperty("officeSlug");
    expect(response.text).not.toMatch(/token|https?:\/\/|bucket|objectKey|sentAt/);
    expect(harness.transaction).toHaveBeenCalledTimes(1);
    expect(harness.requireDealBinding).toHaveBeenCalledWith(
      harness.client,
      DEAL_ID,
      CANONICAL_PROJECT_NUMBER,
    );
    expect(detailReport).toHaveBeenCalledWith(harness.client, {
      dealId: DEAL_ID,
      reportId: REPORT_ID,
    });
  });

  it("fails wrong deal binding before detail and retains signed stable IDs only in body-free audit", async () => {
    const requireDealBinding = vi.fn(async () => {
      throw new AppError(404, "wrong tenant narrative should not escape", "internal_code");
    });
    const harness = createHarness({
      requireDealBinding:
        requireDealBinding as unknown as NonNullable<CoreWeeklyReportApiRouterOptions["requireDealBinding"]>,
    });
    const response = await signedRequest(harness.app, {
      path: "/reports/detail",
      action: "report-detail",
      rawBody: detailBody(),
    });
    expectTypedError(response, 404, REQUEST_ID, "not_found");
    expect(harness.detailReport).not.toHaveBeenCalled();
    expect(harness.auditEvents.at(-1)).toMatchObject({
      requestId: REQUEST_ID,
      officeSlug: "dallas",
      dealId: DEAL_ID,
      reportId: REPORT_ID,
      statusCode: 404,
      resultCode: "not_found",
    });
    expect(JSON.stringify(harness.auditEvents)).not.toContain("wrong tenant narrative");
  });

  it("fails closed if an internal loader returns a different deal or report than the signed binding", async () => {
    const mismatchedDeal = createHarness({
      requireDealBinding: vi.fn(async () => ({
        id: OTHER_DEAL_ID,
        canonicalProjectNumber: CANONICAL_PROJECT_NUMBER,
      })) as unknown as NonNullable<CoreWeeklyReportApiRouterOptions["requireDealBinding"]>,
    });
    const dealResponse = await signedRequest(mismatchedDeal.app, {
      path: "/reports/list",
      action: "list-reports",
      rawBody: listBody(),
    });
    expectTypedError(dealResponse, 503, REQUEST_ID, "unavailable");
    expect(mismatchedDeal.listReports).not.toHaveBeenCalled();

    const mismatchedReport = createHarness({
      detailReport: vi.fn(async (): Promise<CoreWeeklyReportDetailResult> => ({
        item: { ...LIST_ITEM, id: NEXT_REPORT_ID },
        content: CONTENT,
      })) as unknown as NonNullable<CoreWeeklyReportApiRouterOptions["detailReport"]>,
    });
    const reportResponse = await signedRequest(mismatchedReport.app, {
      path: "/reports/detail",
      action: "report-detail",
      rawBody: detailBody(),
    });
    expectTypedError(reportResponse, 503, REQUEST_ID, "unavailable");
    expect(reportResponse.text).not.toContain(NEXT_REPORT_ID);
    expect(mismatchedReport.auditEvents.at(-1)).toMatchObject({
      dealId: DEAL_ID,
      reportId: REPORT_ID,
      resultCode: "unavailable",
    });
  });

  it.each([
    [404, "not_found"],
    [409, "conflict"],
    [410, "withdrawn"],
  ])("maps safe service status %i without internal messages or withdrawn content", async (status, code) => {
    const detailReport = vi.fn(async () => {
      throw new AppError(status, "SECRET narrative/token/bucket/key", "sensitive_internal_code");
    });
    const harness = createHarness({
      detailReport: detailReport as unknown as NonNullable<CoreWeeklyReportApiRouterOptions["detailReport"]>,
    });
    const response = await signedRequest(harness.app, {
      path: "/reports/detail",
      action: "report-detail",
      rawBody: detailBody(),
    });
    expectTypedError(response, status, REQUEST_ID, code);
    expect(response.text).not.toMatch(/SECRET|narrative|token|bucket|sensitive_internal_code/);
    expect(JSON.stringify(harness.auditEvents)).not.toMatch(/SECRET|narrative|token|bucket/);
    if (status === 410) {
      expect(response.body).not.toHaveProperty("report");
      expect(response.body).not.toHaveProperty("content");
    }
  });

  it("maps unexpected failures to a retryable 503 surface without logging the error object", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const listReports = vi.fn(async () => {
      throw new Error("SECRET narrative and https://storage.invalid/bucket/key");
    });
    const harness = createHarness({
      listReports: listReports as unknown as NonNullable<CoreWeeklyReportApiRouterOptions["listReports"]>,
    });
    const response = await signedRequest(harness.app, {
      path: "/reports/list",
      action: "list-reports",
      rawBody: listBody(),
    });
    expectTypedError(response, 503, REQUEST_ID, "unavailable");
    expect(response.text).not.toMatch(/SECRET|storage\.invalid|bucket|key/);
    expect(JSON.stringify(harness.auditEvents)).not.toMatch(/SECRET|storage\.invalid|bucket/);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("rejects strict list/detail shape errors before office lookup", async () => {
    const cases = [
      { path: "/reports/list" as const, action: "list-reports" as const, body: listBody({ limit: 0 }) },
      { path: "/reports/list" as const, action: "list-reports" as const, body: listBody({ extra: true }) },
      { path: "/reports/detail" as const, action: "report-detail" as const, body: detailBody({ reportId: "not-a-uuid" }) },
      { path: "/reports/detail" as const, action: "report-detail" as const, body: detailBody({ canonicalProjectNumber: "DFW-1-00123-AA" }) },
    ];
    for (const row of cases) {
      const harness = createHarness();
      const response = await signedRequest(harness.app, {
        path: row.path,
        action: row.action,
        rawBody: row.body,
      });
      expectTypedError(response, 400, REQUEST_ID, "invalid_request");
      expectNoTenantWork(harness);
    }
  });
});

describe("Core weekly-report HTTP observability and unsupported surface", () => {
  it("emits a fixed body-free list audit event with pagination presence but no body/cursor/content", async () => {
    const harness = createHarness();
    const response = await signedRequest(harness.app, {
      path: "/reports/list",
      action: "list-reports",
      rawBody: listBody(),
    });
    expect(response.status).toBe(200);
    expect(harness.auditEvents).toHaveLength(1);
    expect(harness.auditEvents[0]).toEqual({
      event: "crm_weekly_report_api.list_served",
      workload: "trock-core",
      action: "list-reports",
      requestId: REQUEST_ID,
      officeSlug: "dallas",
      dealId: DEAL_ID,
      reportId: null,
      statusCode: 200,
      resultCode: "ok",
      keySlot: "current",
      itemCount: 1,
      paginationCursorPresent: false,
      nextCursorPresent: false,
      elapsedMs: 0,
    });
    const serialized = JSON.stringify(harness.auditEvents[0]);
    expect(serialized).not.toContain(CANONICAL_PROJECT_NUMBER);
    expect(serialized).not.toContain("Synthetic already-sent narrative");
    expect(serialized).not.toContain("Synthetic client-safe caption");
    expect(serialized).not.toContain(CURRENT_SECRET);
    expect(serialized).not.toMatch(/signature|rawBody|cursor\"|content|clientName|photo/i);
  });

  it("does not let an observer failure leak data or change a successful read", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = createHarness({
      observe: async () => {
        throw new Error("observer carried SECRET narrative");
      },
    });
    const response = await signedRequest(harness.app, {
      path: "/deals/resolve",
      action: "resolve-deal",
      rawBody: resolveBody("SENSITIVE-PROJECT-NUMBER"),
    });
    expect(response.status).toBe(200);
    expect(consoleError).toHaveBeenCalledWith("[CRM weekly-report API] observation hook failed");
    expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(/SECRET|SENSITIVE/);
    consoleError.mockRestore();
  });

  it.each([
    ["post", "/unsupported"],
    ["get", "/reports/list"],
    ["put", "/reports/detail"],
  ] as const)("returns a content-free no-store 404 for unsupported %s %s", async (method, path) => {
    const harness = createHarness();
    const response = await request(harness.app)[method](
      `${CORE_WEEKLY_REPORT_API_BASE_PATH}${path}`,
    );
    expectBare(response, 404);
    expect(harness.authorizeCorePeer).not.toHaveBeenCalled();
    expectNoTenantWork(harness);
  });

  it("uses a bounded tenant statement timeout and passes an abort signal into every transaction seam", async () => {
    expect(CORE_WEEKLY_REPORT_DB_STATEMENT_TIMEOUT).toBe("15s");
    const underlyingClient = { query: vi.fn() } as unknown as QueryExecutor;
    const underlying = vi.fn(async (
      _officeSlug: string,
      _options: { statementTimeout?: string },
      run: (client: QueryExecutor) => Promise<unknown>,
    ) => run(underlyingClient));
    const boundedTransaction = createCoreWeeklyReportOfficeTransaction(
      underlying as unknown as CoreWeeklyReportOfficeClientRunner,
    );
    const boundedResult = await boundedTransaction(
      "dallas",
      new AbortController().signal,
      async (client) => client,
    );
    expect(boundedResult).toBe(underlyingClient);
    expect(underlying).toHaveBeenCalledWith(
      "dallas",
      { statementTimeout: "15s" },
      expect.any(Function),
    );

    const aborted = new AbortController();
    await expect(
      createCoreWeeklyReportOfficeTransaction(
        underlying as unknown as CoreWeeklyReportOfficeClientRunner,
      )(
        "dallas",
        aborted.signal,
        async () => {
          aborted.abort();
          return "read-complete";
        },
      ),
    ).rejects.toThrow("request cancelled");

    const signals: AbortSignal[] = [];
    const transaction: CoreWeeklyReportOfficeTransaction = async <T>(
      _officeSlug: string,
      signal: AbortSignal,
      run: (client: QueryExecutor) => Promise<T>,
    ) => {
      signals.push(signal);
      expect(signal.aborted).toBe(false);
      return run({ query: vi.fn() } as unknown as QueryExecutor);
    };
    for (const operation of [
      { path: "/deals/resolve" as const, action: "resolve-deal" as const, body: resolveBody() },
      { path: "/reports/list" as const, action: "list-reports" as const, body: listBody() },
      { path: "/reports/detail" as const, action: "report-detail" as const, body: detailBody() },
    ]) {
      const harness = createHarness({ withOfficeTransaction: transaction });
      const response = await signedRequest(harness.app, {
        path: operation.path,
        action: operation.action,
        rawBody: operation.body,
      });
      expect(response.status).toBe(200);
    }
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });
});
