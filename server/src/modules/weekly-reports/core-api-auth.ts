import crypto from "node:crypto";
import { CORE_WEEKLY_REPORT_MAX_PAGE_SIZE } from "./core-api-contracts.js";

export const CORE_WEEKLY_REPORT_REQUEST_ID_HEADER = "x-trock-core-request-id";
export const CORE_WEEKLY_REPORT_TIMESTAMP_HEADER = "x-trock-core-timestamp";
export const CORE_WEEKLY_REPORT_SIGNATURE_HEADER = "x-trock-core-signature";
export const CORE_WEEKLY_REPORT_AUTH_TOLERANCE_SECONDS = 300;
export const CORE_WEEKLY_REPORT_CURSOR_TTL_SECONDS = 15 * 60;
export const CORE_WEEKLY_REPORT_MIN_SECRET_BYTES = 32;

const AUTH_DOMAIN = "trock.crm.core-weekly-report-api.v1";
const CURSOR_DOMAIN = "trock.crm.core-weekly-report-cursor.v1\n";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OFFICE_SLUG_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type CoreWeeklyReportAuthAction = "resolve-deal" | "list-reports" | "report-detail";

export interface CoreWeeklyReportAuthHeaders {
  requestId: unknown;
  timestamp: unknown;
  signature: unknown;
}

export type CoreWeeklyReportAuthResult =
  | { ok: true; requestId: string; timestampSeconds: number; keySlot: "current" | "previous" }
  | {
      ok: false;
      reason:
        | "missing_secret"
        | "invalid_secret_configuration"
        | "missing_headers"
        | "invalid_request_id"
        | "invalid_timestamp"
        | "stale_timestamp"
        | "invalid_signature";
    };

function headerString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export type CoreWeeklyReportSecretReadiness =
  | { ok: true; currentSecret: string; previousSecret: string | null }
  | {
      ok: false;
      reason:
        | "missing_current_secret"
        | "weak_current_secret"
        | "weak_previous_secret"
        | "duplicate_rotation_secrets";
    };

function strongSecret(value: string): boolean {
  return (
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    Buffer.byteLength(value, "utf8") >= CORE_WEEKLY_REPORT_MIN_SECRET_BYTES
  );
}

function requireStrongSigningSecret(secret: string): void {
  if (!strongSecret(secret)) {
    throw new TypeError(
      `Weekly-report HMAC secrets must contain at least ${CORE_WEEKLY_REPORT_MIN_SECRET_BYTES} bytes`,
    );
  }
}

/** Validate both key slots once, before authentication and before any tenant lookup. */
export function coreWeeklyReportSecretReadiness(
  currentSecret: string | undefined,
  previousSecret?: string | undefined,
): CoreWeeklyReportSecretReadiness {
  if (!currentSecret) return { ok: false, reason: "missing_current_secret" };
  if (!strongSecret(currentSecret)) return { ok: false, reason: "weak_current_secret" };
  const previous = previousSecret === "" || previousSecret === undefined ? null : previousSecret;
  if (previous !== null && !strongSecret(previous)) {
    return { ok: false, reason: "weak_previous_secret" };
  }
  if (previous === currentSecret) {
    return { ok: false, reason: "duplicate_rotation_secrets" };
  }
  return { ok: true, currentSecret, previousSecret: previous };
}

/**
 * Byte-exact, domain-separated frame. The action prevents a valid list request being replayed as detail;
 * the request id and timestamp make every call attributable and bound to the five-minute replay window.
 */
export function coreWeeklyReportAuthFrame(input: {
  action: CoreWeeklyReportAuthAction;
  requestId: string;
  timestampSeconds: number;
  rawBody: Buffer;
}): Buffer {
  return Buffer.concat([
    Buffer.from(
      `${AUTH_DOMAIN}\n${input.action}\n${input.requestId.toLowerCase()}\n${input.timestampSeconds}\n`,
      "utf8",
    ),
    input.rawBody,
  ]);
}

export function signCoreWeeklyReportRequest(input: {
  action: CoreWeeklyReportAuthAction;
  requestId: string;
  timestampSeconds: number;
  rawBody: Buffer;
  secret: string;
}): string {
  requireStrongSigningSecret(input.secret);
  const digest = crypto
    .createHmac("sha256", input.secret)
    .update(coreWeeklyReportAuthFrame(input))
    .digest("hex");
  return `sha256=${digest}`;
}

function equalHexDigest(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function verifyCoreWeeklyReportRequest(input: {
  action: CoreWeeklyReportAuthAction;
  rawBody: Buffer;
  headers: CoreWeeklyReportAuthHeaders;
  currentSecret: string | undefined;
  previousSecret?: string | undefined;
  nowMs?: number;
}): CoreWeeklyReportAuthResult {
  const secrets = coreWeeklyReportSecretReadiness(input.currentSecret, input.previousSecret);
  if (!secrets.ok) {
    return {
      ok: false,
      reason:
        secrets.reason === "missing_current_secret"
          ? "missing_secret"
          : "invalid_secret_configuration",
    };
  }

  const requestId = headerString(input.headers.requestId)?.toLowerCase() ?? null;
  const timestamp = headerString(input.headers.timestamp);
  const signature = headerString(input.headers.signature);
  if (!requestId || !timestamp || !signature) return { ok: false, reason: "missing_headers" };
  if (!UUID_PATTERN.test(requestId)) return { ok: false, reason: "invalid_request_id" };
  if (!/^\d{10}$/.test(timestamp)) return { ok: false, reason: "invalid_timestamp" };
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) return { ok: false, reason: "invalid_timestamp" };
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) return { ok: false, reason: "invalid_timestamp" };
  const nowSeconds = Math.floor(nowMs / 1_000);
  if (Math.abs(nowSeconds - timestampSeconds) > CORE_WEEKLY_REPORT_AUTH_TOLERANCE_SECONDS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const received = /^sha256=([a-f0-9]{64})$/.exec(signature)?.[1];
  if (!received) return { ok: false, reason: "invalid_signature" };
  const frame = coreWeeklyReportAuthFrame({
    action: input.action,
    requestId,
    timestampSeconds,
    rawBody: input.rawBody,
  });
  const current = crypto.createHmac("sha256", secrets.currentSecret).update(frame).digest("hex");
  const currentMatches = equalHexDigest(current, received);
  let previousMatches = false;
  if (secrets.previousSecret) {
    const previous = crypto.createHmac("sha256", secrets.previousSecret).update(frame).digest("hex");
    // Always compute and timing-compare every configured slot before choosing one. Returning as soon as
    // current matched made a current-key request observably cheaper than a previous-key request during
    // rotation, which defeats the point of timing-safe digest comparison at the key-slot boundary.
    previousMatches = equalHexDigest(previous, received);
  }
  if (currentMatches) {
    return { ok: true, requestId, timestampSeconds, keySlot: "current" };
  }
  if (previousMatches) {
    return { ok: true, requestId, timestampSeconds, keySlot: "previous" };
  }
  return { ok: false, reason: "invalid_signature" };
}

export interface CoreWeeklyReportCursorPayload {
  version: 1;
  officeSlug: string;
  dealId: string;
  canonicalProjectNumber: string;
  limit: number;
  asOf: string;
  issuedAt: string;
  expiresAt: string;
  weekOf: string;
  reportVersion: number;
  reportId: string;
}

export interface CoreWeeklyReportCursorContext {
  officeSlug: string;
  dealId: string;
  canonicalProjectNumber: string;
  limit: number;
}

export function coreWeeklyReportCursorMatchesContext(
  cursor: CoreWeeklyReportCursorPayload,
  context: CoreWeeklyReportCursorContext,
): boolean {
  return (
    cursor.officeSlug === context.officeSlug &&
    cursor.dealId === context.dealId &&
    cursor.canonicalProjectNumber === context.canonicalProjectNumber &&
    cursor.limit === context.limit
  );
}

function cursorMac(payloadBytes: Buffer, secret: string): Buffer {
  return crypto
    .createHmac("sha256", secret)
    .update(CURSOR_DOMAIN, "utf8")
    .update(payloadBytes)
    .digest();
}

export function encodeCoreWeeklyReportCursor(
  payload: CoreWeeklyReportCursorPayload,
  secret: string,
): string {
  requireStrongSigningSecret(secret);
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  return `${bytes.toString("base64url")}.${cursorMac(bytes, secret).toString("base64url")}`;
}

function isCursorPayload(value: unknown): value is CoreWeeklyReportCursorPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  const expected = [
    "asOf",
    "canonicalProjectNumber",
    "dealId",
    "expiresAt",
    "issuedAt",
    "limit",
    "officeSlug",
    "reportId",
    "reportVersion",
    "version",
    "weekOf",
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return false;
  }
  return (
    row.version === 1 &&
    typeof row.officeSlug === "string" && OFFICE_SLUG_PATTERN.test(row.officeSlug) &&
    typeof row.dealId === "string" && UUID_PATTERN.test(row.dealId) &&
    typeof row.canonicalProjectNumber === "string" && row.canonicalProjectNumber.length > 0 &&
    Number.isSafeInteger(row.limit) &&
    Number(row.limit) >= 1 &&
    Number(row.limit) <= CORE_WEEKLY_REPORT_MAX_PAGE_SIZE &&
    typeof row.asOf === "string" && ISO_TIMESTAMP_PATTERN.test(row.asOf) &&
    typeof row.issuedAt === "string" && ISO_TIMESTAMP_PATTERN.test(row.issuedAt) &&
    typeof row.expiresAt === "string" && ISO_TIMESTAMP_PATTERN.test(row.expiresAt) &&
    typeof row.weekOf === "string" && ISO_DATE_PATTERN.test(row.weekOf) &&
    Number.isSafeInteger(row.reportVersion) &&
    Number(row.reportVersion) >= 1 &&
    typeof row.reportId === "string" && UUID_PATTERN.test(row.reportId)
  );
}

export function decodeCoreWeeklyReportCursor(
  cursor: string,
  secrets: readonly string[],
  nowMs: number = Date.now(),
): CoreWeeklyReportCursorPayload | null {
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(cursor);
  if (!match || secrets.length === 0 || secrets.some((secret) => !strongSecret(secret))) return null;
  let payloadBytes: Buffer;
  let provided: Buffer;
  try {
    payloadBytes = Buffer.from(match[1]!, "base64url");
    provided = Buffer.from(match[2]!, "base64url");
  } catch {
    return null;
  }
  if (payloadBytes.length === 0 || payloadBytes.length > 1_024 || provided.length !== 32) return null;
  const authenticated = secrets.some((secret) => {
    const expected = cursorMac(payloadBytes, secret);
    return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
  });
  if (!authenticated) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
    if (!isCursorPayload(parsed)) return null;
    const issuedAtMs = Date.parse(parsed.issuedAt);
    const expiresAtMs = Date.parse(parsed.expiresAt);
    const weekOfMs = Date.parse(`${parsed.weekOf}T00:00:00.000Z`);
    const maximumExpiryMs = issuedAtMs + CORE_WEEKLY_REPORT_CURSOR_TTL_SECONDS * 1_000;
    if (
      !Number.isFinite(nowMs) ||
      !Number.isFinite(issuedAtMs) ||
      !Number.isFinite(expiresAtMs) ||
      !Number.isFinite(weekOfMs) ||
      new Date(issuedAtMs).toISOString() !== parsed.issuedAt ||
      new Date(expiresAtMs).toISOString() !== parsed.expiresAt ||
      new Date(weekOfMs).toISOString().slice(0, 10) !== parsed.weekOf ||
      parsed.asOf !== parsed.issuedAt ||
      expiresAtMs <= issuedAtMs ||
      expiresAtMs > maximumExpiryMs ||
      nowMs < issuedAtMs ||
      nowMs >= expiresAtMs
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
