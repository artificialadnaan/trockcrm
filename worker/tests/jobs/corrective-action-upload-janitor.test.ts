import { describe, expect, it, vi } from "vitest";
import { runCorrectiveActionUploadJanitor } from "../../src/jobs/corrective-action-upload-janitor.js";

const silent = { log: () => {}, warn: () => {}, error: () => {} };

/**
 * Content-routing query mock for the abandoned-upload janitor. The real reclamation is a single CTE statement
 * (created_at threshold + is_active/deleted_at + NOT EXISTS field_scorecard_photos → soft-delete file + delete
 * ledger), so the tests assert:
 *   - the reclaim CTE runs per active office schema (only where the ledger table exists);
 *   - the CTE encodes the STALE + UNATTACHED discrimination and mirrors deleteFile's soft-delete;
 *   - the returned reclaimed count reflects the CTE's rowCount;
 *   - the sweep is best-effort (one office throwing doesn't abort the rest).
 * The discrimination itself (which rows are stale/attached) is enforced by the CTE WHERE, asserted against the
 * SQL text — an ATTACHED file (a field_scorecard_photos link) or a RECENT unattached file is excluded by that
 * WHERE and therefore never appears in the CTE's returned set.
 */
function makeQuery(opts: {
  offices?: { slug: string }[];
  tableExists?: Record<string, boolean>;
  reclaimed?: Record<string, string[]>;
}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });

    if (/FROM public\.offices WHERE is_active = true/i.test(sql)) {
      const offices = opts.offices ?? [{ slug: "dallas" }];
      return { rows: offices, rowCount: offices.length };
    }
    if (/information_schema\.tables/i.test(sql)) {
      const schema = String((params as any[])[0]);
      const exists = opts.tableExists ? opts.tableExists[schema] !== false : true;
      return { rows: exists ? [{ "?column?": 1 }] : [], rowCount: exists ? 1 : 0 };
    }
    if (/WITH stale AS/i.test(sql)) {
      const m = sql.match(/"(office_[a-z0-9_]+)"\./i);
      const schema = m ? m[1] : "office_dallas";
      const ids = opts.reclaimed?.[schema] ?? [];
      return { rows: ids.map((id) => ({ file_id: id })), rowCount: ids.length };
    }
    return { rows: [], rowCount: 0 };
  });
  return { query: query as any, calls };
}

describe("runCorrectiveActionUploadJanitor", () => {
  it("reclaims a stale, unattached upload: soft-deletes the file + deletes the ledger, returns the count", async () => {
    const { query, calls } = makeQuery({
      offices: [{ slug: "dallas" }],
      reclaimed: { office_dallas: ["f1"] },
    });

    const result = await runCorrectiveActionUploadJanitor({ query, logger: silent });

    expect(result).toEqual({ reclaimed: 1, officesSwept: 1 });

    const cte = calls.find((c) => /WITH stale AS/i.test(c.sql));
    expect(cte).toBeDefined();
    // STALE: past the threshold interval.
    expect(cte!.sql).toMatch(/created_at < now\(\) - interval '24 hours'/i);
    // Only still-active/undeleted files are candidates.
    expect(cte!.sql).toMatch(/f\.is_active = true/i);
    expect(cte!.sql).toMatch(/f\.deleted_at IS NULL/i);
    // UNATTACHED: no field_scorecard_photos row references the file.
    expect(cte!.sql).toMatch(/NOT EXISTS/i);
    expect(cte!.sql).toMatch(/field_scorecard_photos/i);
    // Reclamation mirrors deleteFile's soft-delete (is_active=false + deleted_at) and removes the ledger row.
    expect(cte!.sql).toMatch(/SET is_active = false, deleted_at = now\(\)/i);
    expect(cte!.sql).toMatch(/DELETE FROM "office_dallas"\.scorecard_corrective_action_uploads/i);
  });

  it("leaves ATTACHED and RECENT uploads alone (the CTE returns nothing → nothing reclaimed)", async () => {
    // An ATTACHED file (has a field_scorecard_photos link) and a RECENT unattached file are both excluded by the
    // CTE's WHERE, so the reclaim CTE returns zero rows and no file is soft-deleted / no ledger row removed.
    const { query, calls } = makeQuery({
      offices: [{ slug: "dallas" }],
      reclaimed: { office_dallas: [] },
    });

    const result = await runCorrectiveActionUploadJanitor({ query, logger: silent });

    expect(result).toEqual({ reclaimed: 0, officesSwept: 1 });
    // The sweep still ran (a no-op), but reclaimed nothing.
    expect(calls.find((c) => /WITH stale AS/i.test(c.sql))).toBeDefined();
  });

  it("skips an office whose ledger table does not exist (pre-feature schema)", async () => {
    const { query, calls } = makeQuery({
      offices: [{ slug: "dallas" }, { slug: "atlanta" }],
      tableExists: { office_atlanta: false },
      reclaimed: { office_dallas: ["f1"] },
    });

    const result = await runCorrectiveActionUploadJanitor({ query, logger: silent });

    expect(result).toEqual({ reclaimed: 1, officesSwept: 1 });
    // No reclaim CTE ever runs against atlanta (skipped before reclamation).
    expect(calls.find((c) => /WITH stale AS/i.test(c.sql) && /office_atlanta/i.test(c.sql))).toBeUndefined();
  });

  it("is best-effort per office: one office throwing does not abort the others", async () => {
    const query = vi.fn(async (sql: string) => {
      if (/FROM public\.offices WHERE is_active = true/i.test(sql)) {
        return { rows: [{ slug: "dallas" }, { slug: "atlanta" }], rowCount: 2 };
      }
      if (/information_schema\.tables/i.test(sql)) {
        return { rows: [{ "?column?": 1 }], rowCount: 1 };
      }
      if (/WITH stale AS/i.test(sql)) {
        if (/office_dallas/i.test(sql)) throw new Error("boom in dallas");
        return { rows: [{ file_id: "f2" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }) as any;

    const result = await runCorrectiveActionUploadJanitor({ query, logger: silent });

    // Dallas threw (caught + logged); Atlanta still reclaimed 1.
    expect(result).toEqual({ reclaimed: 1, officesSwept: 1 });
  });
});
