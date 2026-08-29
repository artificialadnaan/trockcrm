import { canonicalizeProjectNumber } from "../bid-board-sync/project-number.js";

/**
 * T Rock Core's read-only weekly-report contract.
 *
 * These DTOs intentionally do not reuse WeeklyReportDetail or WeeklyReportPdfSource. Both internal
 * shapes carry fields a portal must never receive (send requests, provider detail, public-link state,
 * storage keys and raw source URLs). This file is the allow-list at the service boundary.
 */

export const CORE_WEEKLY_REPORT_API_BASE_PATH =
  "/api/integrations/trock-core/v1/weekly-reports" as const;

export const CORE_WEEKLY_REPORT_DEAL_RESPONSE_VERSION =
  "trock.crm.core-weekly-report-deal.v1" as const;
export const CORE_WEEKLY_REPORT_LIST_RESPONSE_VERSION =
  "trock.crm.core-weekly-report-list.v1" as const;
export const CORE_WEEKLY_REPORT_DETAIL_RESPONSE_VERSION =
  "trock.crm.core-weekly-report-detail.v1" as const;
export const CORE_WEEKLY_REPORT_ERROR_RESPONSE_VERSION =
  "trock.crm.core-weekly-report-error.v1" as const;

export const CORE_WEEKLY_REPORT_MAX_PAGE_SIZE = 100;
export const CORE_WEEKLY_REPORT_MAX_REQUEST_BYTES = 16 * 1024;

const OFFICE_SLUG_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CoreWeeklyReportDealBinding {
  id: string;
  canonicalProjectNumber: string;
}

export interface CoreWeeklyReportResolveDealRequest {
  officeSlug: string;
  projectNumber: string;
}

export interface CoreWeeklyReportResolveDealResponse {
  version: typeof CORE_WEEKLY_REPORT_DEAL_RESPONSE_VERSION;
  requestId: string;
  deal: CoreWeeklyReportDealBinding;
}

export interface CoreWeeklyReportListRequest {
  officeSlug: string;
  dealId: string;
  canonicalProjectNumber: string;
  limit: number;
  cursor: string | null;
}

export type CoreWeeklyReportLifecycleState = "latest" | "superseded" | "withdrawn";

export interface CoreWeeklyReportListItem {
  id: string;
  weekOf: string;
  version: number;
  /** Only `sent` exists in v1. Kept explicit so a future contract cannot silently widen publication. */
  publicationStatus: "sent";
  lifecycleState: CoreWeeklyReportLifecycleState;
  supersededByReportId: string | null;
  /** When the existing send worker's provider accepted the send; not proof of mailbox delivery. */
  sendAcceptedAt: string;
}

export interface CoreWeeklyReportListResponse {
  version: typeof CORE_WEEKLY_REPORT_LIST_RESPONSE_VERSION;
  requestId: string;
  deal: CoreWeeklyReportDealBinding;
  /** Snapshot boundary used by the signed cursor. New provider acceptances do not enter later pages. */
  asOf: string;
  items: CoreWeeklyReportListItem[];
  nextCursor: string | null;
}

export interface CoreWeeklyReportDetailRequest {
  officeSlug: string;
  dealId: string;
  canonicalProjectNumber: string;
  reportId: string;
}

export interface CoreWeeklyReportContact {
  label: string;
  name: string | null;
}

/** A stable reference for a future authenticated byte-streaming endpoint; never a URL or object key. */
export interface CoreWeeklyReportPhotoReference {
  fileId: string;
  caption: string | null;
  sortOrder: number;
}

export interface CoreWeeklyReportClientContent {
  /** Null only for a legacy sent snapshot that would otherwise fall back to the live deal name. */
  propertyName: string | null;
  weekOfLabel: string;
  clientName: string | null;
  clientTeam: CoreWeeklyReportContact[];
  trockTeam: CoreWeeklyReportContact[];
  workCompleted: string | null;
  nextWeekLookAhead: string | null;
  issuesConcerns: string | null;
  schedule: {
    contractDate: string;
    projectStartDate: string;
    projectCompletionDate: string;
    completionPercent: string;
    weatherDelayDays: string;
  };
  duration: {
    projectedWeeks: number | null;
    remainingWeeks: number | null;
  };
  photos: CoreWeeklyReportPhotoReference[];
}

export interface CoreWeeklyReportDetailResponse {
  version: typeof CORE_WEEKLY_REPORT_DETAIL_RESPONSE_VERSION;
  requestId: string;
  deal: CoreWeeklyReportDealBinding;
  report: CoreWeeklyReportListItem & {
    /** Sent rows must render from their own frozen snapshot. v1 fails closed if this is not true. */
    contentSource: "frozen_sent_snapshot";
    content: CoreWeeklyReportClientContent;
  };
}

export interface CoreWeeklyReportErrorResponse {
  version: typeof CORE_WEEKLY_REPORT_ERROR_RESPONSE_VERSION;
  requestId: string | null;
  error: {
    code: string;
    message: string;
  };
}

export class CoreWeeklyReportContractError extends Error {
  readonly code = "invalid_request";
}

const JSON_NUMBER_PATTERN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const MAX_JSON_NESTING_DEPTH = 16;

/**
 * JSON.parse applies last-key-wins before the strict DTO parser can see an object. Scan the raw JSON
 * grammar first so `{"officeSlug":"dallas","officeSlug":"other"}` is rejected rather than silently
 * changing tenant identity. Keys are compared after JSON escape decoding, at every object depth.
 */
class DuplicateSafeJsonScanner {
  private offset = 0;

  constructor(private readonly source: string) {}

  scan(): void {
    this.whitespace();
    this.value(0);
    this.whitespace();
    if (this.offset !== this.source.length) this.invalid();
  }

  private invalid(): never {
    throw new CoreWeeklyReportContractError("Body must be valid JSON");
  }

  private whitespace(): void {
    while (this.offset < this.source.length) {
      const char = this.source.charCodeAt(this.offset);
      if (char !== 0x20 && char !== 0x09 && char !== 0x0a && char !== 0x0d) return;
      this.offset += 1;
    }
  }

  private value(depth: number): void {
    if (depth > MAX_JSON_NESTING_DEPTH) this.invalid();
    const char = this.source[this.offset];
    if (char === "{") {
      this.object(depth);
      return;
    }
    if (char === "[") {
      this.array(depth);
      return;
    }
    if (char === '"') {
      this.string();
      return;
    }
    if (char === "t") {
      this.literal("true");
      return;
    }
    if (char === "f") {
      this.literal("false");
      return;
    }
    if (char === "n") {
      this.literal("null");
      return;
    }
    JSON_NUMBER_PATTERN.lastIndex = this.offset;
    const number = JSON_NUMBER_PATTERN.exec(this.source);
    if (!number) this.invalid();
    this.offset = JSON_NUMBER_PATTERN.lastIndex;
  }

  private object(depth: number): void {
    this.offset += 1;
    this.whitespace();
    if (this.source[this.offset] === "}") {
      this.offset += 1;
      return;
    }
    const keys = new Set<string>();
    while (this.offset < this.source.length) {
      if (this.source[this.offset] !== '"') this.invalid();
      const key = this.string();
      if (keys.has(key)) {
        throw new CoreWeeklyReportContractError("Body contains a duplicate object key");
      }
      keys.add(key);
      this.whitespace();
      if (this.source[this.offset] !== ":") this.invalid();
      this.offset += 1;
      this.whitespace();
      this.value(depth + 1);
      this.whitespace();
      if (this.source[this.offset] === "}") {
        this.offset += 1;
        return;
      }
      if (this.source[this.offset] !== ",") this.invalid();
      this.offset += 1;
      this.whitespace();
    }
    this.invalid();
  }

  private array(depth: number): void {
    this.offset += 1;
    this.whitespace();
    if (this.source[this.offset] === "]") {
      this.offset += 1;
      return;
    }
    while (this.offset < this.source.length) {
      this.value(depth + 1);
      this.whitespace();
      if (this.source[this.offset] === "]") {
        this.offset += 1;
        return;
      }
      if (this.source[this.offset] !== ",") this.invalid();
      this.offset += 1;
      this.whitespace();
    }
    this.invalid();
  }

  private string(): string {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.source.length) {
      const char = this.source[this.offset]!;
      if (char === '"') {
        this.offset += 1;
        return JSON.parse(this.source.slice(start, this.offset)) as string;
      }
      if (char === "\\") {
        this.offset += 1;
        const escape = this.source[this.offset];
        if (!escape || !'"\\/bfnrtu'.includes(escape)) this.invalid();
        if (escape === "u") {
          const hex = this.source.slice(this.offset + 1, this.offset + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.invalid();
          this.offset += 4;
        }
      } else if (char.charCodeAt(0) < 0x20) {
        this.invalid();
      }
      this.offset += 1;
    }
    this.invalid();
  }

  private literal(expected: "true" | "false" | "null"): void {
    if (!this.source.startsWith(expected, this.offset)) this.invalid();
    this.offset += expected.length;
  }
}

export function parseCoreWeeklyReportJson(source: string): unknown {
  new DuplicateSafeJsonScanner(source).scan();
  return JSON.parse(source) as unknown;
}

function objectBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CoreWeeklyReportContractError("Body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new CoreWeeklyReportContractError(`Unknown field: ${unknown.sort()[0]}`);
  }
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length > 0) {
    throw new CoreWeeklyReportContractError(`Missing field: ${missing[0]}`);
  }
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") {
    throw new CoreWeeklyReportContractError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max || trimmed.includes("\u0000")) {
    throw new CoreWeeklyReportContractError(`${field} is invalid`);
  }
  return trimmed;
}

function officeSlug(value: unknown): string {
  const slug = boundedString(value, "officeSlug", 100);
  if (!OFFICE_SLUG_PATTERN.test(slug)) {
    throw new CoreWeeklyReportContractError("officeSlug is invalid");
  }
  return slug;
}

function uuid(value: unknown, field: string): string {
  const id = boundedString(value, field, 36).toLowerCase();
  if (!UUID_PATTERN.test(id)) {
    throw new CoreWeeklyReportContractError(`${field} must be a UUID`);
  }
  return id;
}

function canonicalProjectNumber(value: unknown): string {
  // The canonical form is produced by canonicalizeProjectNumber in the service. This boundary keeps a
  // stale/display spelling from being used as a second identity after /deals/resolve has returned one.
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || value.trim() !== value) {
    throw new CoreWeeklyReportContractError("canonicalProjectNumber is invalid");
  }
  const number = value;
  if (canonicalizeProjectNumber(number) !== number) {
    throw new CoreWeeklyReportContractError(
      "canonicalProjectNumber must be the value returned by deal resolution",
    );
  }
  return number;
}

export function parseCoreWeeklyReportResolveDealRequest(
  value: unknown,
): CoreWeeklyReportResolveDealRequest {
  const body = objectBody(value);
  assertExactKeys(body, ["officeSlug", "projectNumber"]);
  return {
    officeSlug: officeSlug(body.officeSlug),
    projectNumber: boundedString(body.projectNumber, "projectNumber", 128),
  };
}

export function parseCoreWeeklyReportListRequest(value: unknown): CoreWeeklyReportListRequest {
  const body = objectBody(value);
  assertExactKeys(
    body,
    ["officeSlug", "dealId", "canonicalProjectNumber", "limit"],
    ["cursor"],
  );
  if (
    !Number.isInteger(body.limit) ||
    Number(body.limit) < 1 ||
    Number(body.limit) > CORE_WEEKLY_REPORT_MAX_PAGE_SIZE
  ) {
    throw new CoreWeeklyReportContractError(
      `limit must be an integer from 1 through ${CORE_WEEKLY_REPORT_MAX_PAGE_SIZE}`,
    );
  }
  const cursor = body.cursor;
  if (
    cursor != null &&
    (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 2_048)
  ) {
    throw new CoreWeeklyReportContractError("cursor is invalid");
  }
  return {
    officeSlug: officeSlug(body.officeSlug),
    dealId: uuid(body.dealId, "dealId"),
    canonicalProjectNumber: canonicalProjectNumber(body.canonicalProjectNumber),
    limit: Number(body.limit),
    cursor: cursor == null ? null : cursor,
  };
}

export function parseCoreWeeklyReportDetailRequest(value: unknown): CoreWeeklyReportDetailRequest {
  const body = objectBody(value);
  assertExactKeys(body, ["officeSlug", "dealId", "canonicalProjectNumber", "reportId"]);
  return {
    officeSlug: officeSlug(body.officeSlug),
    dealId: uuid(body.dealId, "dealId"),
    canonicalProjectNumber: canonicalProjectNumber(body.canonicalProjectNumber),
    reportId: uuid(body.reportId, "reportId"),
  };
}
