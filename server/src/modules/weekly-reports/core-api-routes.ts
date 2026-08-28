import express, {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { pool } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import {
  CORE_WEEKLY_REPORT_CURSOR_TTL_SECONDS,
  CORE_WEEKLY_REPORT_REQUEST_ID_HEADER,
  CORE_WEEKLY_REPORT_SIGNATURE_HEADER,
  CORE_WEEKLY_REPORT_TIMESTAMP_HEADER,
  coreWeeklyReportCursorMatchesContext,
  decodeCoreWeeklyReportCursor,
  encodeCoreWeeklyReportCursor,
  isCanonicalCoreWeeklyReportBoundaryTimestamp,
  verifyCoreWeeklyReportRequest,
  type CoreWeeklyReportAuthAction,
  type CoreWeeklyReportAuthHeaders,
  type CoreWeeklyReportCursorPayload,
} from "./core-api-auth.js";
import {
  CORE_WEEKLY_REPORT_DEAL_RESPONSE_VERSION,
  CORE_WEEKLY_REPORT_DETAIL_RESPONSE_VERSION,
  CORE_WEEKLY_REPORT_ERROR_RESPONSE_VERSION,
  CORE_WEEKLY_REPORT_LIST_RESPONSE_VERSION,
  CORE_WEEKLY_REPORT_MAX_REQUEST_BYTES,
  CoreWeeklyReportContractError,
  parseCoreWeeklyReportDetailRequest,
  parseCoreWeeklyReportJson,
  parseCoreWeeklyReportListRequest,
  parseCoreWeeklyReportResolveDealRequest,
  type CoreWeeklyReportDetailRequest,
  type CoreWeeklyReportDetailResponse,
  type CoreWeeklyReportErrorResponse,
  type CoreWeeklyReportListRequest,
  type CoreWeeklyReportListResponse,
  type CoreWeeklyReportResolveDealRequest,
  type CoreWeeklyReportResolveDealResponse,
} from "./core-api-contracts.js";
import {
  resolveCoreWeeklyReportApiRuntimeConfig,
  type CoreWeeklyReportApiEnvironment,
  type CoreWeeklyReportApiRuntimeConfig,
} from "./core-api-config.js";
import {
  getCoreWeeklyReportDetail,
  listCoreWeeklyReports,
  requireCoreWeeklyReportDealBinding,
  resolveCoreWeeklyReportDeal,
  type CoreWeeklyReportDetailResult,
  type CoreWeeklyReportListResult,
} from "./core-api-service.js";
import { captureCoreWeeklyReportDeliveryBoundary } from "./delivery-publication-boundary.js";
import { withWeeklyReportOfficeClient } from "./office-connection.js";
import type { QueryExecutor } from "./projects-service.js";

export const CORE_WEEKLY_REPORT_DB_STATEMENT_TIMEOUT = "15s" as const;

type CoreWeeklyReportAuditEventName =
  | "crm_weekly_report_api.deal_resolved"
  | "crm_weekly_report_api.deal_resolution_failed"
  | "crm_weekly_report_api.list_served"
  | "crm_weekly_report_api.detail_served"
  | "crm_weekly_report_api.request_refused";

export interface CoreWeeklyReportApiAuditEvent {
  event: CoreWeeklyReportAuditEventName;
  workload: "trock-core";
  action: CoreWeeklyReportAuthAction | null;
  requestId: string | null;
  officeSlug: string | null;
  dealId: string | null;
  reportId: string | null;
  statusCode: number;
  resultCode: string;
  keySlot: "current" | "previous" | null;
  itemCount: number | null;
  paginationCursorPresent: boolean | null;
  nextCursorPresent: boolean | null;
  elapsedMs: number;
}

export type CoreWeeklyReportApiObserver = (
  event: CoreWeeklyReportApiAuditEvent,
) => void | Promise<void>;

/** Must prove trusted workload identity or mTLS from the server/socket context, never a caller header. */
export type CoreWeeklyReportPeerAuthorizer = (
  req: Request,
) => boolean | Promise<boolean>;

export type CoreWeeklyReportOfficeResolver = (
  officeSlug: string,
  signal: AbortSignal,
) => Promise<boolean>;

export type CoreWeeklyReportOfficeTransaction = <T>(
  officeSlug: string,
  signal: AbortSignal,
  run: (client: QueryExecutor) => Promise<T>,
) => Promise<T>;

export type CoreWeeklyReportOfficeClientRunner = <T>(
  officeSlug: string,
  options: { userId?: string | null; statementTimeout?: string },
  run: (client: QueryExecutor) => Promise<T>,
) => Promise<T>;

export interface CoreWeeklyReportApiRouterOptions {
  env?: CoreWeeklyReportApiEnvironment;
  now?: () => number;
  observe?: CoreWeeklyReportApiObserver;
  authorizeCorePeer?: CoreWeeklyReportPeerAuthorizer;
  resolveActiveOffice?: CoreWeeklyReportOfficeResolver;
  withOfficeTransaction?: CoreWeeklyReportOfficeTransaction;
  resolveDeal?: typeof resolveCoreWeeklyReportDeal;
  requireDealBinding?: typeof requireCoreWeeklyReportDealBinding;
  captureDeliveryBoundary?: typeof captureCoreWeeklyReportDeliveryBoundary;
  listReports?: typeof listCoreWeeklyReports;
  detailReport?: typeof getCoreWeeklyReportDetail;
}

interface ResolvedDependencies {
  now: () => number;
  observe: CoreWeeklyReportApiObserver;
  authorizeCorePeer: CoreWeeklyReportPeerAuthorizer;
  resolveActiveOffice: CoreWeeklyReportOfficeResolver;
  withOfficeTransaction: CoreWeeklyReportOfficeTransaction;
  resolveDeal: typeof resolveCoreWeeklyReportDeal;
  requireDealBinding: typeof requireCoreWeeklyReportDealBinding;
  captureDeliveryBoundary: typeof captureCoreWeeklyReportDeliveryBoundary;
  listReports: typeof listCoreWeeklyReports;
  detailReport: typeof getCoreWeeklyReportDetail;
}

interface RequestAuditState {
  startedAtMs: number;
  action: CoreWeeklyReportAuthAction;
  requestId: string | null;
  officeSlug: string | null;
  dealId: string | null;
  reportId: string | null;
  keySlot: "current" | "previous" | null;
  itemCount: number | null;
  paginationCursorPresent: boolean | null;
  nextCursorPresent: boolean | null;
}

interface RouteLocals {
  coreWeeklyReportAuthHeaders?: CoreWeeklyReportAuthHeaders;
  coreWeeklyReportAuditState?: RequestAuditState;
}

interface SafeHttpError {
  statusCode: number;
  code: string;
  message: string;
}

class CoreWeeklyReportRequestCancelledError extends Error {
  constructor() {
    super("request cancelled");
    this.name = "CoreWeeklyReportRequestCancelledError";
  }
}

const RAW_JSON_BODY = express.raw({
  type: "application/json",
  limit: CORE_WEEKLY_REPORT_MAX_REQUEST_BYTES,
  inflate: false,
});

function setPrivateNoStore(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store");
}

function singletonRawHeader(req: Request, headerName: string): string | null {
  const values: string[] = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === headerName) {
      values.push(req.rawHeaders[index + 1] ?? "");
    }
  }
  return values.length === 1 ? values[0]! : null;
}

function exactAuthHeaders(req: Request): CoreWeeklyReportAuthHeaders | null {
  const requestId = singletonRawHeader(req, CORE_WEEKLY_REPORT_REQUEST_ID_HEADER);
  const timestamp = singletonRawHeader(req, CORE_WEEKLY_REPORT_TIMESTAMP_HEADER);
  const signature = singletonRawHeader(req, CORE_WEEKLY_REPORT_SIGNATURE_HEADER);
  if (requestId === null || timestamp === null || signature === null) return null;
  return { requestId, timestamp, signature };
}

function hasExactJsonContentType(req: Request): boolean {
  const contentType = singletonRawHeader(req, "content-type");
  return contentType !== null && req.is("application/json") === "application/json";
}

function hasSupportedContentEncoding(req: Request): boolean {
  const encodings: string[] = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === "content-encoding") {
      encodings.push(req.rawHeaders[index + 1] ?? "");
    }
  }
  return encodings.length === 0 || (encodings.length === 1 && encodings[0] === "identity");
}

function carriesBrowserOrigin(req: Request): boolean {
  // These are browser-origin context headers, not trusted proxy identity. Their presence is enough to
  // refuse this machine-only surface; their absence is never treated as proof (the peer authorizer is).
  const browserHeaders = new Set([
    "origin",
    "referer",
    "sec-fetch-site",
  ]);
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (browserHeaders.has(req.rawHeaders[index]?.toLowerCase() ?? "")) return true;
  }
  return false;
}

function defaultObserver(event: CoreWeeklyReportApiAuditEvent): void {
  // This object is an explicit allow-list. Never add request bodies, cursors, signatures, content, or
  // error objects here: those values may contain report narrative or authentication material.
  console.info("[CRM weekly-report API]", event);
}

async function safelyObserve(
  observer: CoreWeeklyReportApiObserver,
  event: CoreWeeklyReportApiAuditEvent,
): Promise<void> {
  try {
    await observer(event);
  } catch {
    // Do not print the hook's error: a downstream logger may include the event/body it failed to encode.
    console.error("[CRM weekly-report API] observation hook failed");
  }
}

function elapsedMs(now: () => number, startedAtMs: number): number {
  const value = now() - startedAtMs;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function auditEvent(
  state: RequestAuditState,
  now: () => number,
  event: CoreWeeklyReportAuditEventName,
  statusCode: number,
  resultCode: string,
): CoreWeeklyReportApiAuditEvent {
  return {
    event,
    workload: "trock-core",
    action: state.action,
    requestId: state.requestId,
    officeSlug: state.officeSlug,
    dealId: state.dealId,
    reportId: state.reportId,
    statusCode,
    resultCode,
    keySlot: state.keySlot,
    itemCount: state.itemCount,
    paginationCursorPresent: state.paginationCursorPresent,
    nextCursorPresent: state.nextCursorPresent,
    elapsedMs: elapsedMs(now, state.startedAtMs),
  };
}

function bareStatus(res: Response, statusCode: number): void {
  setPrivateNoStore(res);
  res.status(statusCode).end();
}

function sendError(
  res: Response,
  requestId: string | null,
  error: SafeHttpError,
): void {
  const body: CoreWeeklyReportErrorResponse = {
    version: CORE_WEEKLY_REPORT_ERROR_RESPONSE_VERSION,
    requestId,
    error: { code: error.code, message: error.message },
  };
  setPrivateNoStore(res);
  res.status(error.statusCode).json(body);
}

function safeHttpError(error: unknown): SafeHttpError {
  if (error instanceof CoreWeeklyReportRequestCancelledError) {
    return {
      statusCode: 408,
      code: "request_timeout",
      message: "Weekly-report request was cancelled or timed out",
    };
  }
  if (error instanceof CoreWeeklyReportContractError) {
    return { statusCode: 400, code: "invalid_request", message: "Request is invalid" };
  }
  if (error instanceof AppError) {
    if (error.statusCode === 400) {
      return { statusCode: 400, code: "invalid_request", message: "Request is invalid" };
    }
    if (error.statusCode === 404) {
      return {
        statusCode: 404,
        code: "not_found",
        message: "Weekly-report resource was not found",
      };
    }
    if (error.statusCode === 409) {
      return {
        statusCode: 409,
        code: "conflict",
        message: "Weekly-report resource is conflicted",
      };
    }
    if (error.statusCode === 410) {
      return {
        statusCode: 410,
        code: "withdrawn",
        message: "Weekly report was withdrawn",
      };
    }
  }
  return {
    statusCode: 503,
    code: "unavailable",
    message: "Weekly-report service is unavailable",
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new CoreWeeklyReportRequestCancelledError();
}

function requestAbortController(_req: Request, res: Response): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const onResponseClosed = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", onResponseClosed);
  return {
    controller,
    cleanup: () => {
      res.off("close", onResponseClosed);
    },
  };
}

async function defaultResolveActiveOffice(
  officeSlug: string,
  signal: AbortSignal,
): Promise<boolean> {
  throwIfAborted(signal);
  const result = await pool.query<{ slug: string }>(
    "SELECT slug FROM public.offices WHERE slug = $1 AND is_active = true LIMIT 1",
    [officeSlug],
  );
  throwIfAborted(signal);
  return result.rows.length === 1;
}

export function createCoreWeeklyReportOfficeTransaction(
  runWithOfficeClient: CoreWeeklyReportOfficeClientRunner = withWeeklyReportOfficeClient,
): CoreWeeklyReportOfficeTransaction {
  return async <T>(
    officeSlug: string,
    signal: AbortSignal,
    run: (client: QueryExecutor) => Promise<T>,
  ): Promise<T> => {
    throwIfAborted(signal);
    return runWithOfficeClient(
      officeSlug,
      { statementTimeout: CORE_WEEKLY_REPORT_DB_STATEMENT_TIMEOUT },
      async (client) => {
        throwIfAborted(signal);
        const result = await run(client);
        // Throwing here makes withWeeklyReportOfficeClient roll back instead of committing a request whose
        // caller went away while the tenant read was in flight.
        throwIfAborted(signal);
        return result;
      },
    );
  };
}

function resolveDependencies(options: CoreWeeklyReportApiRouterOptions): ResolvedDependencies {
  return {
    now: options.now ?? Date.now,
    observe: options.observe ?? defaultObserver,
    // There is no trusted workload-identity/mTLS verifier elsewhere in this repository today. Omitting
    // this dependency therefore fails readiness rather than silently downgrading the boundary to HMAC.
    authorizeCorePeer: options.authorizeCorePeer ?? (() => false),
    resolveActiveOffice: options.resolveActiveOffice ?? defaultResolveActiveOffice,
    withOfficeTransaction:
      options.withOfficeTransaction ?? createCoreWeeklyReportOfficeTransaction(),
    resolveDeal: options.resolveDeal ?? resolveCoreWeeklyReportDeal,
    requireDealBinding: options.requireDealBinding ?? requireCoreWeeklyReportDealBinding,
    captureDeliveryBoundary:
      options.captureDeliveryBoundary ?? captureCoreWeeklyReportDeliveryBoundary,
    listReports: options.listReports ?? listCoreWeeklyReports,
    detailReport: options.detailReport ?? getCoreWeeklyReportDetail,
  };
}

function initialAuditState(action: CoreWeeklyReportAuthAction, now: () => number): RequestAuditState {
  const startedAtMs = now();
  return {
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : 0,
    action,
    requestId: null,
    officeSlug: null,
    dealId: null,
    reportId: null,
    keySlot: null,
    itemCount: null,
    paginationCursorPresent: null,
    nextCursorPresent: null,
  };
}

function locals(res: Response): RouteLocals {
  return res.locals as RouteLocals;
}

function routePreflight(
  runtime: CoreWeeklyReportApiRuntimeConfig,
  dependencies: ResolvedDependencies,
  action: CoreWeeklyReportAuthAction,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    setPrivateNoStore(res);
    const state = initialAuditState(action, dependencies.now);
    locals(res).coreWeeklyReportAuditState = state;

    if (runtime.state === "disabled") {
      await safelyObserve(
        dependencies.observe,
        auditEvent(state, dependencies.now, "crm_weekly_report_api.request_refused", 404, "disabled"),
      );
      bareStatus(res, 404);
      return;
    }
    if (runtime.state === "unready") {
      await safelyObserve(
        dependencies.observe,
        auditEvent(state, dependencies.now, "crm_weekly_report_api.request_refused", 503, "unready"),
      );
      bareStatus(res, 503);
      return;
    }


    let peerAuthorized = false;
    if (!carriesBrowserOrigin(req)) {
      try {
        peerAuthorized = await dependencies.authorizeCorePeer(req) === true;
      } catch {
        peerAuthorized = false;
      }
    }
    if (!peerAuthorized) {
      await safelyObserve(
        dependencies.observe,
        auditEvent(
          state,
          dependencies.now,
          "crm_weekly_report_api.request_refused",
          401,
          "authentication_failed",
        ),
      );
      bareStatus(res, 401);
      return;
    }

    const headers = exactAuthHeaders(req);
    if (!headers) {
      await safelyObserve(
        dependencies.observe,
        auditEvent(
          state,
          dependencies.now,
          "crm_weekly_report_api.request_refused",
          401,
          "authentication_failed",
        ),
      );
      bareStatus(res, 401);
      return;
    }
    locals(res).coreWeeklyReportAuthHeaders = headers;

    if (!hasExactJsonContentType(req) || !hasSupportedContentEncoding(req)) {
      const error: SafeHttpError = {
        statusCode: 415,
        code: "unsupported_media_type",
        message: "Content-Type must be application/json with an uncompressed body",
      };
      await safelyObserve(
        dependencies.observe,
        auditEvent(
          state,
          dependencies.now,
          "crm_weekly_report_api.request_refused",
          error.statusCode,
          error.code,
        ),
      );
      sendError(res, null, error);
      return;
    }
    next();
  };
}

function operationSuccessEvent(action: CoreWeeklyReportAuthAction): CoreWeeklyReportAuditEventName {
  if (action === "resolve-deal") return "crm_weekly_report_api.deal_resolved";
  if (action === "list-reports") return "crm_weekly_report_api.list_served";
  return "crm_weekly_report_api.detail_served";
}

function operationFailureEvent(
  action: CoreWeeklyReportAuthAction,
  state: RequestAuditState,
): CoreWeeklyReportAuditEventName {
  return action === "resolve-deal" && state.requestId !== null && state.officeSlug !== null
    ? "crm_weekly_report_api.deal_resolution_failed"
    : "crm_weekly_report_api.request_refused";
}

async function verifyAndDecodeRequest(
  req: Request,
  res: Response,
  runtime: Extract<CoreWeeklyReportApiRuntimeConfig, { state: "ready" }>,
  dependencies: ResolvedDependencies,
  action: CoreWeeklyReportAuthAction,
): Promise<{ requestId: string; raw: unknown; state: RequestAuditState } | null> {
  const state = locals(res).coreWeeklyReportAuditState!;
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    const error: SafeHttpError = {
      statusCode: 415,
      code: "unsupported_media_type",
      message: "Content-Type must be application/json with an uncompressed body",
    };
    await safelyObserve(
      dependencies.observe,
      auditEvent(state, dependencies.now, "crm_weekly_report_api.request_refused", 415, error.code),
    );
    sendError(res, null, error);
    return null;
  }

  const authentication = verifyCoreWeeklyReportRequest({
    action,
    rawBody,
    headers: locals(res).coreWeeklyReportAuthHeaders!,
    currentSecret: runtime.currentSecret,
    previousSecret: runtime.previousSecret ?? undefined,
    // Authentication linearizes after the complete bounded body arrives. Using request-start time here
    // would let a sender begin within the skew window, drip the body, and preserve an otherwise stale MAC.
    nowMs: dependencies.now(),
  });
  if (!authentication.ok) {
    await safelyObserve(
      dependencies.observe,
      auditEvent(
        state,
        dependencies.now,
        "crm_weekly_report_api.request_refused",
        401,
        "authentication_failed",
      ),
    );
    bareStatus(res, 401);
    return null;
  }
  state.requestId = authentication.requestId;
  state.keySlot = authentication.keySlot;

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  } catch {
    throw new CoreWeeklyReportContractError("Body must be well-formed UTF-8");
  }
  return { requestId: authentication.requestId, raw: parseCoreWeeklyReportJson(source), state };
}

async function requireSignedOffice(
  officeSlug: string,
  state: RequestAuditState,
  dependencies: ResolvedDependencies,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const active = await dependencies.resolveActiveOffice(officeSlug, signal);
  throwIfAborted(signal);
  if (!active) {
    throw new AppError(404, "Weekly-report resource was not found", "not_found");
  }
  state.officeSlug = officeSlug;
}

function currentCursorPayload(
  request: CoreWeeklyReportListRequest,
  runtime: Extract<CoreWeeklyReportApiRuntimeConfig, { state: "ready" }>,
  nowMs: number,
): {
  asOf: string;
  issuedAt: string;
  expiresAt: string;
  after: Pick<CoreWeeklyReportCursorPayload, "weekOf" | "reportVersion" | "reportId"> | null;
} {
  if (request.cursor === null) throw new CoreWeeklyReportContractError("cursor is missing");
  const cursor = decodeCoreWeeklyReportCursor(
    request.cursor,
    runtime.previousSecret
      ? [runtime.currentSecret, runtime.previousSecret]
      : [runtime.currentSecret],
    nowMs,
  );
  if (
    !cursor ||
    !coreWeeklyReportCursorMatchesContext(cursor, {
      officeSlug: request.officeSlug,
      dealId: request.dealId,
      canonicalProjectNumber: request.canonicalProjectNumber,
      limit: request.limit,
    })
  ) {
    throw new CoreWeeklyReportContractError("cursor is invalid");
  }
  return {
    asOf: cursor.asOf,
    issuedAt: cursor.issuedAt,
    expiresAt: cursor.expiresAt,
    after: {
      weekOf: cursor.weekOf,
      reportVersion: cursor.reportVersion,
      reportId: cursor.reportId,
    },
  };
}

function initialCursorPayload(
  asOf: string,
  issuedAtMs: number,
): ReturnType<typeof currentCursorPayload> {
  if (
    !isCanonicalCoreWeeklyReportBoundaryTimestamp(asOf) ||
    !Number.isFinite(issuedAtMs)
  ) {
    throw new AppError(503, "Weekly-report delivery boundary is unavailable");
  }
  let issuedAt: string;
  let expiresAt: string;
  try {
    issuedAt = new Date(issuedAtMs).toISOString();
    expiresAt = new Date(
      issuedAtMs + CORE_WEEKLY_REPORT_CURSOR_TTL_SECONDS * 1_000,
    ).toISOString();
  } catch {
    throw new AppError(503, "Weekly-report delivery boundary is unavailable");
  }
  return {
    asOf,
    // `asOf` comes from Postgres because it freezes database visibility. Cursor lifetime comes from the
    // API clock because this same API clock validates the next request. Coupling both to the database
    // clock made a cursor issued by a slightly-ahead database invalid until the host caught up.
    issuedAt,
    expiresAt,
    after: null,
  };
}

function nextCursor(
  request: CoreWeeklyReportListRequest,
  page: CoreWeeklyReportListResult,
  cursor: ReturnType<typeof currentCursorPayload>,
  runtime: Extract<CoreWeeklyReportApiRuntimeConfig, { state: "ready" }>,
): string | null {
  if (!page.hasMore) return null;
  if (!page.last) throw new AppError(500, "Invalid weekly-report page state");
  return encodeCoreWeeklyReportCursor(
    {
      version: 1,
      officeSlug: request.officeSlug,
      dealId: request.dealId,
      canonicalProjectNumber: request.canonicalProjectNumber,
      limit: request.limit,
      asOf: cursor.asOf,
      issuedAt: cursor.issuedAt,
      expiresAt: cursor.expiresAt,
      weekOf: page.last.weekOf,
      reportVersion: page.last.reportVersion,
      reportId: page.last.reportId,
    },
    runtime.currentSecret,
  );
}

function sendSuccess(res: Response, body: unknown): void {
  setPrivateNoStore(res);
  res.status(200).json(body);
}

function assertReturnedDealBinding(
  request: Pick<CoreWeeklyReportListRequest, "dealId" | "canonicalProjectNumber">,
  deal: { id: string; canonicalProjectNumber: string },
): void {
  if (
    deal.id !== request.dealId ||
    deal.canonicalProjectNumber !== request.canonicalProjectNumber
  ) {
    throw new AppError(500, "Weekly-report service returned a mismatched deal binding");
  }
}

async function handleResolveDeal(
  req: Request,
  res: Response,
  runtime: Extract<CoreWeeklyReportApiRuntimeConfig, { state: "ready" }>,
  dependencies: ResolvedDependencies,
): Promise<void> {
  const decoded = await verifyAndDecodeRequest(
    req,
    res,
    runtime,
    dependencies,
    "resolve-deal",
  );
  if (!decoded) return;
  const request: CoreWeeklyReportResolveDealRequest =
    parseCoreWeeklyReportResolveDealRequest(decoded.raw);
  decoded.state.officeSlug = request.officeSlug;
  const { controller, cleanup } = requestAbortController(req, res);
  try {
    await requireSignedOffice(request.officeSlug, decoded.state, dependencies, controller.signal);
    const deal = await dependencies.withOfficeTransaction(
      request.officeSlug,
      controller.signal,
      (client) => dependencies.resolveDeal(client, request.projectNumber),
    );
    throwIfAborted(controller.signal);
    decoded.state.dealId = deal.id;
    const body: CoreWeeklyReportResolveDealResponse = {
      version: CORE_WEEKLY_REPORT_DEAL_RESPONSE_VERSION,
      requestId: decoded.requestId,
      deal,
    };
    await safelyObserve(
      dependencies.observe,
      auditEvent(
        decoded.state,
        dependencies.now,
        operationSuccessEvent("resolve-deal"),
        200,
        "ok",
      ),
    );
    sendSuccess(res, body);
  } finally {
    cleanup();
  }
}

async function handleListReports(
  req: Request,
  res: Response,
  runtime: Extract<CoreWeeklyReportApiRuntimeConfig, { state: "ready" }>,
  dependencies: ResolvedDependencies,
): Promise<void> {
  const decoded = await verifyAndDecodeRequest(
    req,
    res,
    runtime,
    dependencies,
    "list-reports",
  );
  if (!decoded) return;
  const request: CoreWeeklyReportListRequest = parseCoreWeeklyReportListRequest(decoded.raw);
  decoded.state.officeSlug = request.officeSlug;
  decoded.state.dealId = request.dealId;
  decoded.state.paginationCursorPresent = request.cursor !== null;
  // Validate cursor authentication/context before spending an office lookup or tenant connection.
  const suppliedCursor = request.cursor === null
    ? null
    : currentCursorPayload(request, runtime, dependencies.now());
  const { controller, cleanup } = requestAbortController(req, res);
  try {
    await requireSignedOffice(request.officeSlug, decoded.state, dependencies, controller.signal);
    const result = await dependencies.withOfficeTransaction(
      request.officeSlug,
      controller.signal,
      async (client) => {
        const deal = await dependencies.requireDealBinding(
          client,
          request.dealId,
          request.canonicalProjectNumber,
        );
        assertReturnedDealBinding(request, deal);
        decoded.state.dealId = deal.id;
        throwIfAborted(controller.signal);
        // Page one linearizes with delivery-webhook receipt inside this exact tenant transaction. Later
        // pages carry the signed boundary and deliberately do not take a new one.
        const cursor = suppliedCursor ?? initialCursorPayload(
          await dependencies.captureDeliveryBoundary(client),
          dependencies.now(),
        );
        throwIfAborted(controller.signal);
        const page = await dependencies.listReports(client, {
          dealId: deal.id,
          limit: request.limit,
          asOf: cursor.asOf,
          after: cursor.after,
        });
        return { deal, page, cursor };
      },
    );
    throwIfAborted(controller.signal);
    const encodedNextCursor = nextCursor(request, result.page, result.cursor, runtime);
    decoded.state.itemCount = result.page.items.length;
    decoded.state.nextCursorPresent = encodedNextCursor !== null;
    const body: CoreWeeklyReportListResponse = {
      version: CORE_WEEKLY_REPORT_LIST_RESPONSE_VERSION,
      requestId: decoded.requestId,
      deal: result.deal,
      asOf: result.cursor.asOf,
      items: result.page.items,
      nextCursor: encodedNextCursor,
    };
    await safelyObserve(
      dependencies.observe,
      auditEvent(
        decoded.state,
        dependencies.now,
        operationSuccessEvent("list-reports"),
        200,
        "ok",
      ),
    );
    sendSuccess(res, body);
  } finally {
    cleanup();
  }
}

async function handleDetailReport(
  req: Request,
  res: Response,
  runtime: Extract<CoreWeeklyReportApiRuntimeConfig, { state: "ready" }>,
  dependencies: ResolvedDependencies,
): Promise<void> {
  const decoded = await verifyAndDecodeRequest(
    req,
    res,
    runtime,
    dependencies,
    "report-detail",
  );
  if (!decoded) return;
  const request: CoreWeeklyReportDetailRequest = parseCoreWeeklyReportDetailRequest(decoded.raw);
  decoded.state.officeSlug = request.officeSlug;
  decoded.state.dealId = request.dealId;
  decoded.state.reportId = request.reportId;
  const { controller, cleanup } = requestAbortController(req, res);
  try {
    await requireSignedOffice(request.officeSlug, decoded.state, dependencies, controller.signal);
    const result: { deal: Awaited<ReturnType<typeof requireCoreWeeklyReportDealBinding>>; detail: CoreWeeklyReportDetailResult } =
      await dependencies.withOfficeTransaction(
        request.officeSlug,
        controller.signal,
        async (client) => {
          const deal = await dependencies.requireDealBinding(
            client,
            request.dealId,
            request.canonicalProjectNumber,
          );
          assertReturnedDealBinding(request, deal);
          decoded.state.dealId = deal.id;
          throwIfAborted(controller.signal);
          const detail = await dependencies.detailReport(client, {
            dealId: deal.id,
            reportId: request.reportId,
          });
          return { deal, detail };
        },
      );
    throwIfAborted(controller.signal);
    if (result.detail.item.id !== request.reportId) {
      throw new AppError(500, "Weekly-report service returned a mismatched report binding");
    }
    decoded.state.reportId = result.detail.item.id;
    const body: CoreWeeklyReportDetailResponse = {
      version: CORE_WEEKLY_REPORT_DETAIL_RESPONSE_VERSION,
      requestId: decoded.requestId,
      deal: result.deal,
      report: {
        ...result.detail.item,
        contentSource: "frozen_sent_snapshot",
        content: result.detail.content,
      },
    };
    await safelyObserve(
      dependencies.observe,
      auditEvent(
        decoded.state,
        dependencies.now,
        operationSuccessEvent("report-detail"),
        200,
        "ok",
      ),
    );
    sendSuccess(res, body);
  } finally {
    cleanup();
  }
}

function asyncOperation(
  action: CoreWeeklyReportAuthAction,
  dependencies: ResolvedDependencies,
  operation: (req: Request, res: Response) => Promise<void>,
) {
  return async (req: Request, res: Response) => {
    try {
      await operation(req, res);
    } catch (error) {
      const state = locals(res).coreWeeklyReportAuditState ?? initialAuditState(action, dependencies.now);
      const safe = safeHttpError(error);
      await safelyObserve(
        dependencies.observe,
        auditEvent(
          state,
          dependencies.now,
          operationFailureEvent(action, state),
          safe.statusCode,
          safe.code,
        ),
      );
      if (!res.headersSent && !res.destroyed) sendError(res, state.requestId, safe);
    }
  };
}

function rawBodyErrorHandler(
  dependencies: ResolvedDependencies,
) {
  return async (error: unknown, _req: Request, res: Response, next: NextFunction) => {
    const row = error as { type?: unknown; status?: unknown; statusCode?: unknown };
    if (
      row.type !== "entity.too.large" &&
      row.type !== "encoding.unsupported" &&
      row.type !== "request.size.invalid"
    ) {
      next(error);
      return;
    }
    const state = locals(res).coreWeeklyReportAuditState;
    const safe: SafeHttpError = row.type === "entity.too.large"
      ? {
          statusCode: 413,
          code: "request_too_large",
          message: `Request body exceeds ${CORE_WEEKLY_REPORT_MAX_REQUEST_BYTES} bytes`,
        }
      : row.type === "encoding.unsupported"
        ? {
            statusCode: 415,
            code: "unsupported_media_type",
            message: "Content-Type must be application/json with an uncompressed body",
          }
        : {
            statusCode: 400,
            code: "invalid_request",
            message: "Request is invalid",
          };
    if (state) {
      await safelyObserve(
        dependencies.observe,
        auditEvent(
          state,
          dependencies.now,
          "crm_weekly_report_api.request_refused",
          safe.statusCode,
          safe.code,
        ),
      );
    }
    sendError(res, null, safe);
  };
}

/**
 * Build the version-1 HTTP boundary. The caller must mount it at CORE_WEEKLY_REPORT_API_BASE_PATH and,
 * critically, before any JSON parser; this factory owns exact raw-byte parsing for its three routes.
 */
export function createCoreWeeklyReportApiRouter(
  options: CoreWeeklyReportApiRouterOptions = {},
): Router {
  const runtime = resolveCoreWeeklyReportApiRuntimeConfig(options.env ?? process.env, {
    peerAuthorizerConfigured: options.authorizeCorePeer !== undefined,
  });
  const dependencies = resolveDependencies(options);
  const router = Router();

  router.post(
    "/deals/resolve",
    routePreflight(runtime, dependencies, "resolve-deal"),
    RAW_JSON_BODY,
    asyncOperation("resolve-deal", dependencies, (req, res) => {
      if (runtime.state !== "ready") return Promise.resolve();
      return handleResolveDeal(req, res, runtime, dependencies);
    }),
  );
  router.post(
    "/reports/list",
    routePreflight(runtime, dependencies, "list-reports"),
    RAW_JSON_BODY,
    asyncOperation("list-reports", dependencies, (req, res) => {
      if (runtime.state !== "ready") return Promise.resolve();
      return handleListReports(req, res, runtime, dependencies);
    }),
  );
  router.post(
    "/reports/detail",
    routePreflight(runtime, dependencies, "report-detail"),
    RAW_JSON_BODY,
    asyncOperation("report-detail", dependencies, (req, res) => {
      if (runtime.state !== "ready") return Promise.resolve();
      return handleDetailReport(req, res, runtime, dependencies);
    }),
  );

  router.use(rawBodyErrorHandler(dependencies));
  router.use(async (_req, res) => {
    const startedAtMs = dependencies.now();
    await safelyObserve(dependencies.observe, {
      event: "crm_weekly_report_api.request_refused",
      workload: "trock-core",
      action: null,
      requestId: null,
      officeSlug: null,
      dealId: null,
      reportId: null,
      statusCode: 404,
      resultCode: "unsupported_operation",
      keySlot: null,
      itemCount: null,
      paginationCursorPresent: null,
      nextCursorPresent: null,
      elapsedMs: elapsedMs(dependencies.now, startedAtMs),
    });
    bareStatus(res, 404);
  });
  return router;
}
