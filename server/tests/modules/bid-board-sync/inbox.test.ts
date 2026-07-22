import crypto from "crypto";
import { describe, expect, it, vi } from "vitest";
import {
  computeIdempotencyKey,
  extractOfficeSlug,
  resolveIngestOfficeSlug,
  countPayloadRows,
  isValidOfficeSlug,
  officeAdvisoryKey,
  BID_BOARD_ADVISORY_NAMESPACE,
  acceptBidBoardIngestion,
  recordSuccessWithRetry,
  type Querier,
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

  describe("resolveIngestOfficeSlug (legacy missing-office default)", () => {
    it("defaults an ABSENT / empty office to dallas (matches the importer's normalizeOfficeSlug fallback)", () => {
      expect(resolveIngestOfficeSlug({})).toBe("dallas");
      expect(resolveIngestOfficeSlug({ office_slug: null })).toBe("dallas");
      expect(resolveIngestOfficeSlug({ office_slug: "   " })).toBe("dallas");
      expect(resolveIngestOfficeSlug(null)).toBe("dallas");
    });

    it("returns a PRESENT valid slug (snake_case or camelCase)", () => {
      expect(resolveIngestOfficeSlug({ office_slug: "atlanta" })).toBe("atlanta");
      expect(resolveIngestOfficeSlug({ officeSlug: "office_2" })).toBe("office_2");
    });

    it("resolves camelCase officeSlug when office_slug is BLANK — mirrors the importer, NOT shadowed to dallas", () => {
      // Coalescing on the raw aliases would pick the blank office_slug and default to dallas while the
      // importer's textValue-per-alias resolves to atlanta — mis-keying the row + advisory lock.
      expect(resolveIngestOfficeSlug({ office_slug: "", officeSlug: "atlanta" })).toBe("atlanta");
      expect(resolveIngestOfficeSlug({ office_slug: "   ", officeSlug: "atlanta" })).toBe("atlanta");
    });

    it("rejects (null) a PRESENT but schema-unsafe slug — never coerces it to dallas", () => {
      expect(resolveIngestOfficeSlug({ office_slug: "Dallas" })).toBeNull(); // uppercase
      expect(resolveIngestOfficeSlug({ office_slug: "dallas; drop" })).toBeNull();
      expect(resolveIngestOfficeSlug({ office_slug: "2dallas" })).toBeNull(); // leading digit
    });
  });

  describe("countPayloadRows (sheets-aware, mirrors extractRows)", () => {
    it("prefers the sender's provenance count", () => {
      expect(countPayloadRows({ provenance: { rowCount: 42 }, rows: [1, 2] })).toBe(42);
      expect(countPayloadRows({ provenance: { row_count: 7 } })).toBe(7);
    });

    it("counts top-level rows", () => {
      expect(countPayloadRows({ rows: [1, 2, 3] })).toBe(3);
    });

    it("flattens an array-of-sheets payload (previously counted as 0)", () => {
      expect(countPayloadRows({ sheets: [{ rows: [1, 2] }, { rows: [3] }, { rows: [] }] })).toBe(3);
    });

    it("flattens a keyed-object sheets payload", () => {
      expect(countPayloadRows({ sheets: { Dallas: [1, 2], Atlanta: [3] } })).toBe(3);
    });

    it("is 0 for an empty / absent payload", () => {
      expect(countPayloadRows({})).toBe(0);
      expect(countPayloadRows(null)).toBe(0);
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

  describe("acceptBidBoardIngestion resilience (scripted fake db)", () => {
    it("re-runs the insert when a conflicting row vanishes between conflict and lookup (retention race)", async () => {
      // office lookup → id; CTE #1 → conflict (0 rows); duplicate lookup → vanished (0 rows); CTE #2 → inserts.
      const responses: Array<{ rows: any[] }> = [
        { rows: [{ id: "office-1" }] },
        { rows: [] }, // CTE #1: conflict
        { rows: [] }, // duplicate lookup: row was deleted by retention
        { rows: [{ id: "inbox-new" }] }, // CTE #2: fresh insert
      ];
      let i = 0;
      const db: Querier = { query: vi.fn(async () => responses[i++] ?? { rows: [] }) };

      const res = await acceptBidBoardIngestion(db, {
        officeSlug: "dallas",
        payload: { office_slug: "dallas", rows: [] },
        payloadHash: "h",
        rowCount: 0,
        sourceFilename: null,
      });
      expect(res).toMatchObject({ inboxId: "inbox-new", duplicate: false, status: "queued" });
    });
  });

  describe("recordSuccessWithRetry (post-commit bookkeeping)", () => {
    it("retries a transient success-write failure so a committed import is never re-run", async () => {
      let calls = 0;
      const db: Querier = {
        query: vi.fn(async () => {
          calls++;
          if (calls < 3) throw new Error("transient");
          // A landed UPDATE reports rowCount 1 → markInboxSucceeded returns 'recorded' (no follow-up status read),
          // so the retry loop ends here without an extra query.
          return { rows: [], rowCount: 1 };
        }),
      };
      await expect(
        recordSuccessWithRetry(db, "inbox-1", { runId: null, metrics: {}, warningsCount: 0 })
      ).resolves.toBeUndefined();
      expect(calls).toBe(3);
    });

    it("throws only after exhausting its retries", async () => {
      const db: Querier = { query: vi.fn(async () => { throw new Error("down"); }) };
      await expect(
        recordSuccessWithRetry(db, "inbox-1", { runId: null, metrics: {}, warningsCount: 0 }, 2)
      ).rejects.toThrow("down");
    });
  });
});
