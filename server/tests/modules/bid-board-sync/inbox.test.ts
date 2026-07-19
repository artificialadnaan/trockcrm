import crypto from "crypto";
import { describe, expect, it } from "vitest";
import {
  computeIdempotencyKey,
  extractOfficeSlug,
  isValidOfficeSlug,
  officeAdvisoryKey,
  BID_BOARD_ADVISORY_NAMESPACE,
} from "../../../src/modules/bid-board-sync/inbox.js";

describe("bid-board inbox pure helpers", () => {
  describe("computeIdempotencyKey", () => {
    it("is sha256 of the raw body and matches CRM<->SyncHub hashing", () => {
      const body = JSON.stringify({ office_slug: "dallas", rows: [{ Name: "x" }] });
      const key = computeIdempotencyKey(body);
      expect(key).toBe(crypto.createHash("sha256").update(body).digest("hex"));
      // A Buffer of the same bytes hashes identically (route receives a Buffer; SyncHub sends a string).
      expect(computeIdempotencyKey(Buffer.from(body, "utf8"))).toBe(key);
    });

    it("differs for a different payload (new scrape) and is stable for identical bytes (a retry)", () => {
      const a = computeIdempotencyKey(JSON.stringify({ rows: [1] }));
      const b = computeIdempotencyKey(JSON.stringify({ rows: [2] }));
      expect(a).not.toBe(b);
      expect(computeIdempotencyKey(JSON.stringify({ rows: [1] }))).toBe(a);
    });
  });

  describe("office slug validation", () => {
    it("accepts valid schema-safe slugs and rejects anything else", () => {
      expect(isValidOfficeSlug("dallas")).toBe(true);
      expect(isValidOfficeSlug("office_2")).toBe(true);
      expect(isValidOfficeSlug("Dallas")).toBe(false); // uppercase → schema-unsafe
      expect(isValidOfficeSlug("2dallas")).toBe(false); // leading digit
      expect(isValidOfficeSlug("dallas; drop")).toBe(false);
      expect(isValidOfficeSlug("")).toBe(false);
      expect(isValidOfficeSlug(undefined)).toBe(false);
    });

    it("extractOfficeSlug reads snake_case or camelCase, validating the value", () => {
      expect(extractOfficeSlug({ office_slug: "dallas" })).toBe("dallas");
      expect(extractOfficeSlug({ officeSlug: "atlanta" })).toBe("atlanta");
      expect(extractOfficeSlug({ office_slug: "BAD SLUG" })).toBeNull();
      expect(extractOfficeSlug({})).toBeNull();
      expect(extractOfficeSlug(null)).toBeNull();
    });
  });

  describe("officeAdvisoryKey", () => {
    it("is deterministic and a positive int4 (valid pg_advisory_lock arg)", () => {
      const k = officeAdvisoryKey("dallas");
      expect(k).toBe(officeAdvisoryKey("dallas"));
      expect(Number.isInteger(k)).toBe(true);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThanOrEqual(0x7fffffff);
      expect(BID_BOARD_ADVISORY_NAMESPACE).toBeLessThanOrEqual(0x7fffffff);
    });

    it("separates offices (different lock keys → no cross-office blocking)", () => {
      expect(officeAdvisoryKey("dallas")).not.toBe(officeAdvisoryKey("atlanta"));
    });
  });
});
