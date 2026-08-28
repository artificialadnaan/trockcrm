import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CORE_WEEKLY_REPORT_AUTH_TOLERANCE_SECONDS,
  CORE_WEEKLY_REPORT_CURSOR_TTL_SECONDS,
  CORE_WEEKLY_REPORT_MIN_SECRET_BYTES,
  coreWeeklyReportCursorMatchesContext,
  coreWeeklyReportSecretReadiness,
  decodeCoreWeeklyReportCursor,
  encodeCoreWeeklyReportCursor,
  signCoreWeeklyReportRequest,
  verifyCoreWeeklyReportRequest,
  type CoreWeeklyReportAuthAction,
  type CoreWeeklyReportCursorPayload,
} from "./core-api-auth.js";
import { CORE_WEEKLY_REPORT_MAX_PAGE_SIZE } from "./core-api-contracts.js";

const SECRET = "core-current-secret-with-32-byte-minimum-0001";
const PREVIOUS_SECRET = "core-previous-secret-with-32-byte-minimum-001";
const UNKNOWN_SECRET = "core-unknown-secret-with-32-byte-minimum-00001";
const REQUEST_ID = "00000000-0000-4000-8000-000000000001";
const NOW_SECONDS = 1_787_868_000;
const BODY = Buffer.from('{"officeSlug":"dallas","projectNumber":"DFW-1-00123-aa"}');

function signature(
  overrides: {
    action?: CoreWeeklyReportAuthAction;
    requestId?: string;
    timestampSeconds?: number;
    rawBody?: Buffer;
    secret?: string;
  } = {},
): string {
  return signCoreWeeklyReportRequest({
    action: overrides.action ?? "resolve-deal",
    requestId: overrides.requestId ?? REQUEST_ID,
    timestampSeconds: overrides.timestampSeconds ?? NOW_SECONDS,
    rawBody: overrides.rawBody ?? BODY,
    secret: overrides.secret ?? SECRET,
  });
}

function verify(
  overrides: Partial<Parameters<typeof verifyCoreWeeklyReportRequest>[0]> = {},
) {
  return verifyCoreWeeklyReportRequest({
    action: "resolve-deal",
    rawBody: BODY,
    headers: {
      requestId: REQUEST_ID,
      timestamp: String(NOW_SECONDS),
      signature: signature(),
    },
    currentSecret: SECRET,
    previousSecret: PREVIOUS_SECRET,
    nowMs: NOW_SECONDS * 1_000,
    ...overrides,
  });
}

describe("T Rock Core weekly-report request authentication", () => {
  it("accepts an exact request signed by the current key", () => {
    expect(verify()).toEqual({
      ok: true,
      requestId: REQUEST_ID,
      timestampSeconds: NOW_SECONDS,
      keySlot: "current",
    });
  });

  it("accepts the previous key during rotation but still requires a current configured key", () => {
    expect(
      verify({
        headers: {
          requestId: REQUEST_ID,
          timestamp: String(NOW_SECONDS),
          signature: signature({ secret: PREVIOUS_SECRET }),
        },
      }),
    ).toMatchObject({ ok: true, keySlot: "previous" });
    expect(verify({ currentSecret: undefined })).toEqual({ ok: false, reason: "missing_secret" });
  });

  it("fails closed on weak or unsafe current/rotation key configuration", () => {
    expect(coreWeeklyReportSecretReadiness("x".repeat(CORE_WEEKLY_REPORT_MIN_SECRET_BYTES))).toEqual({
      ok: true,
      currentSecret: "x".repeat(CORE_WEEKLY_REPORT_MIN_SECRET_BYTES),
      previousSecret: null,
    });
    for (const changed of [
      { currentSecret: "short" },
      { currentSecret: `${SECRET} ` },
      { currentSecret: SECRET, previousSecret: "short" },
      { currentSecret: SECRET, previousSecret: SECRET },
    ]) {
      expect(verify(changed)).toEqual({
        ok: false,
        reason: "invalid_secret_configuration",
      });
    }
    expect(() => signature({ secret: "short" })).toThrow(/at least 32 bytes/);
  });

  it("timing-compares every configured key slot before selecting current or previous", () => {
    const spy = vi.spyOn(crypto, "timingSafeEqual");
    expect(verify()).toMatchObject({ ok: true });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockClear();
    expect(
      verify({
        headers: {
          requestId: REQUEST_ID,
          timestamp: String(NOW_SECONDS),
          signature: signature({ secret: PREVIOUS_SECRET }),
        },
      }),
    ).toMatchObject({ ok: true, keySlot: "previous" });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it.each([
    ["the raw body", { rawBody: Buffer.from(BODY.toString().replace("dallas", "atlanta")) }],
    ["the action", { action: "list-reports" as const }],
    ["the request id", { headers: { requestId: "00000000-0000-4000-8000-000000000002", timestamp: String(NOW_SECONDS), signature: signature() } }],
    ["the timestamp", { headers: { requestId: REQUEST_ID, timestamp: String(NOW_SECONDS + 1), signature: signature() } }],
  ])("rejects a signature replayed after changing %s", (_label, changed) => {
    expect(verify(changed)).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects absent/malformed headers without attempting an unsafe digest conversion", () => {
    expect(verify({ headers: { requestId: undefined, timestamp: undefined, signature: undefined } })).toEqual({
      ok: false,
      reason: "missing_headers",
    });
    expect(
      verify({ headers: { requestId: "not-a-uuid", timestamp: String(NOW_SECONDS), signature: signature() } }),
    ).toEqual({ ok: false, reason: "invalid_request_id" });
    expect(
      verify({ headers: { requestId: REQUEST_ID, timestamp: "now", signature: signature() } }),
    ).toEqual({ ok: false, reason: "invalid_timestamp" });
    expect(verify({ nowMs: Number.NaN })).toEqual({ ok: false, reason: "invalid_timestamp" });
    expect(
      verify({ headers: { requestId: REQUEST_ID, timestamp: String(NOW_SECONDS), signature: "sha256=xyz" } }),
    ).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("enforces the replay window in both directions, inclusively at the boundary", () => {
    for (const delta of [-CORE_WEEKLY_REPORT_AUTH_TOLERANCE_SECONDS, CORE_WEEKLY_REPORT_AUTH_TOLERANCE_SECONDS]) {
      const timestamp = NOW_SECONDS + delta;
      expect(
        verify({
          headers: {
            requestId: REQUEST_ID,
            timestamp: String(timestamp),
            signature: signature({ timestampSeconds: timestamp }),
          },
        }),
      ).toMatchObject({ ok: true });
    }
    for (const delta of [
      -CORE_WEEKLY_REPORT_AUTH_TOLERANCE_SECONDS - 1,
      CORE_WEEKLY_REPORT_AUTH_TOLERANCE_SECONDS + 1,
    ]) {
      const timestamp = NOW_SECONDS + delta;
      expect(
        verify({
          headers: {
            requestId: REQUEST_ID,
            timestamp: String(timestamp),
            signature: signature({ timestampSeconds: timestamp }),
          },
        }),
      ).toEqual({ ok: false, reason: "stale_timestamp" });
    }
  });
});

const CURSOR: CoreWeeklyReportCursorPayload = {
  version: 1,
  officeSlug: "dallas",
  dealId: "00000000-0000-4000-8000-000000000011",
  canonicalProjectNumber: "dfw-1-00123-aa",
  limit: 25,
  asOf: "2026-08-27T20:00:00.000Z",
  issuedAt: "2026-08-27T20:00:00.000Z",
  expiresAt: "2026-08-27T20:15:00.000Z",
  weekOf: "2026-08-13",
  reportVersion: 2,
  reportId: "00000000-0000-4000-8000-000000000022",
};

const CURSOR_ISSUED_AT_MS = Date.parse(CURSOR.issuedAt);

describe("T Rock Core weekly-report pagination cursors", () => {
  it("round-trips the full office/deal/number/snapshot/position binding", () => {
    expect(
      decodeCoreWeeklyReportCursor(
        encodeCoreWeeklyReportCursor(CURSOR, SECRET),
        [SECRET],
        CURSOR_ISSUED_AT_MS,
      ),
    ).toEqual(CURSOR);
  });

  it("verifies a cursor against the previous secret during rotation", () => {
    const cursor = encodeCoreWeeklyReportCursor(CURSOR, PREVIOUS_SECRET);
    expect(
      decodeCoreWeeklyReportCursor(
        cursor,
        [SECRET, PREVIOUS_SECRET],
        CURSOR_ISSUED_AT_MS,
      ),
    ).toEqual(CURSOR);
  });

  it("rejects tampering, truncation, an unknown key and an empty keyring", () => {
    const cursor = encodeCoreWeeklyReportCursor(CURSOR, SECRET);
    const [payload, mac] = cursor.split(".");
    const changedPayload = Buffer.from(
      JSON.stringify({ ...CURSOR, officeSlug: "atlanta" }),
      "utf8",
    ).toString("base64url");
    expect(
      decodeCoreWeeklyReportCursor(`${changedPayload}.${mac}`, [SECRET], CURSOR_ISSUED_AT_MS),
    ).toBeNull();
    expect(
      decodeCoreWeeklyReportCursor(`${payload}.${mac!.slice(1)}`, [SECRET], CURSOR_ISSUED_AT_MS),
    ).toBeNull();
    expect(
      decodeCoreWeeklyReportCursor(cursor, [UNKNOWN_SECRET], CURSOR_ISSUED_AT_MS),
    ).toBeNull();
    expect(decodeCoreWeeklyReportCursor(cursor, ["short"], CURSOR_ISSUED_AT_MS)).toBeNull();
    expect(decodeCoreWeeklyReportCursor(cursor, [], CURSOR_ISSUED_AT_MS)).toBeNull();
    expect(() => encodeCoreWeeklyReportCursor(CURSOR, "short")).toThrow(/at least 32 bytes/);
  });

  it("rejects a correctly signed payload with unknown, malformed, or overlong lifetime fields", () => {
    const unknown = encodeCoreWeeklyReportCursor({ ...CURSOR, extra: true } as never, SECRET);
    const malformed = encodeCoreWeeklyReportCursor({ ...CURSOR, weekOf: "yesterday" }, SECRET);
    const impossibleDate = encodeCoreWeeklyReportCursor(
      { ...CURSOR, weekOf: "2026-02-31" },
      SECRET,
    );
    const badLimit = encodeCoreWeeklyReportCursor(
      { ...CURSOR, limit: CORE_WEEKLY_REPORT_MAX_PAGE_SIZE + 1 },
      SECRET,
    );
    const unsafeVersion = encodeCoreWeeklyReportCursor(
      { ...CURSOR, reportVersion: Number.MAX_SAFE_INTEGER + 1 },
      SECRET,
    );
    const mismatchedAsOf = encodeCoreWeeklyReportCursor(
      { ...CURSOR, asOf: "2026-08-27T19:59:59.999Z" },
      SECRET,
    );
    const overlong = encodeCoreWeeklyReportCursor(
      {
        ...CURSOR,
        expiresAt: new Date(
          CURSOR_ISSUED_AT_MS + (CORE_WEEKLY_REPORT_CURSOR_TTL_SECONDS + 1) * 1_000,
        ).toISOString(),
      },
      SECRET,
    );
    for (const cursor of [
      unknown,
      malformed,
      impossibleDate,
      badLimit,
      unsafeVersion,
      mismatchedAsOf,
      overlong,
    ]) {
      expect(decodeCoreWeeklyReportCursor(cursor, [SECRET], CURSOR_ISSUED_AT_MS)).toBeNull();
    }
  });

  it("uses a half-open issued-at/expires-at validity window", () => {
    const cursor = encodeCoreWeeklyReportCursor(CURSOR, SECRET);
    expect(decodeCoreWeeklyReportCursor(cursor, [SECRET], CURSOR_ISSUED_AT_MS)).toEqual(CURSOR);
    expect(
      decodeCoreWeeklyReportCursor(cursor, [SECRET], Date.parse(CURSOR.expiresAt) - 1),
    ).toEqual(CURSOR);
    expect(decodeCoreWeeklyReportCursor(cursor, [SECRET], CURSOR_ISSUED_AT_MS - 1)).toBeNull();
    expect(decodeCoreWeeklyReportCursor(cursor, [SECRET], Date.parse(CURSOR.expiresAt))).toBeNull();
  });

  it("binds the cursor to the exact office, deal, canonical number, and page limit", () => {
    const context = {
      officeSlug: CURSOR.officeSlug,
      dealId: CURSOR.dealId,
      canonicalProjectNumber: CURSOR.canonicalProjectNumber,
      limit: CURSOR.limit,
    };
    expect(coreWeeklyReportCursorMatchesContext(CURSOR, context)).toBe(true);
    for (const changed of [
      { ...context, officeSlug: "atlanta" },
      { ...context, dealId: "00000000-0000-4000-8000-000000000099" },
      { ...context, canonicalProjectNumber: "dfw-1-other" },
      { ...context, limit: context.limit + 1 },
    ]) {
      expect(coreWeeklyReportCursorMatchesContext(CURSOR, changed)).toBe(false);
    }
  });
});
